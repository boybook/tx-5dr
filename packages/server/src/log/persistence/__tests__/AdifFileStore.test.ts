import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdifFileCommitError,
  AdifFileStateUncertainError,
  AdifFileStore,
  AdifGenerationConflictError,
  AdifRewriteValidationError,
  LOGBOOK_TAIL_FRAGMENT_RETENTION_MS,
  literalAdifBytes,
  mainFileRange,
} from '../AdifFileStore.js';
import {
  ADIF_APPEND_FLAGS,
  nodeAdifFileSystem,
  type AdifFileHandle,
  type AdifFileSystem,
} from '../FileSystemAdapter.js';
import { scanLogbookFileInline } from '../LogbookScanCore.js';
import { LogbookDocument } from '../LogbookDocument.js';

function adifRecord(call: string, id = call): string {
  return `<CALL:${call.length}>${call}<APP_TX5DR_ID:${id.length}>${id}<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function wrapHandle(
  handle: AdifFileHandle,
  overrides: Partial<AdifFileHandle>,
): AdifFileHandle {
  return {
    read: overrides.read ?? ((buffer, offset, length, position) => handle.read(buffer, offset, length, position)),
    write: overrides.write ?? ((buffer, offset, length, position) => handle.write(buffer, offset, length, position)),
    sync: overrides.sync ?? (() => handle.sync()),
    truncate: overrides.truncate ?? (length => handle.truncate(length)),
    close: overrides.close ?? (() => handle.close()),
  };
}

function withOpen(
  open: AdifFileSystem['open'],
): AdifFileSystem {
  return { ...nodeAdifFileSystem, open };
}

describe('AdifFileStore durability', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function createLogbook(content = ''): Promise<{ directory: string; filePath: string }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-adif-store-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'station.adi');
    await writeFile(filePath, content);
    return { directory, filePath };
  }

  it('physically appends and fsyncs each mutation while close remains drain-only', async () => {
    const original = `${adifRecord('BG5AA')}\n`;
    const appended = `${adifRecord('BG5AB')}\n`;
    const { filePath } = await createLogbook(original);
    const openedFlags: Array<string | number> = [];
    const fileSystem = withOpen(async (target, flags, mode) => {
      openedFlags.push(flags);
      return nodeAdifFileSystem.open(target, flags, mode);
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    const open = await store.open();

    const { generation, scan } = await store.commitAppend([Buffer.from(appended)], open.generation);

    expect(await readFile(filePath, 'utf8')).toBe(original + appended);
    expect(generation.size).toBe(Buffer.byteLength(original + appended));
    expect(scan.records).toHaveLength(2);
    expect(openedFlags).toContain(ADIF_APPEND_FLAGS);
    await store.close();
    expect(await readFile(filePath, 'utf8')).toBe(original + appended);
    expect(store.getState().status).toBe('closed');
  });

  it('preserves the formal ADIF permission mode across atomic rewrites', async () => {
    if (process.platform === 'win32') return;
    const original = adifRecord('BG5AA') + String.fromCharCode(10);
    const replacement = adifRecord('BG5AB') + String.fromCharCode(10);
    const { filePath } = await createLogbook(original);
    await chmod(filePath, 0o640);
    const store = new AdifFileStore(filePath);
    const opened = await store.open();

    await store.commitRewrite(
      [Buffer.from(replacement)],
      opened.generation,
      { recordCount: 1 },
    );

    expect((await stat(filePath)).mode & 0o777).toBe(0o640);
    await store.close();
  });

  it('coalesces a large document rewrite into a constant number of formal ADIF opens', async () => {
    const records = Array.from(
      { length: 2_000 },
      (_, index) => `${adifRecord(`K${String(index).padStart(4, '0')}`, `qso-${index}`)}\n`,
    ).join('');
    const { filePath } = await createLogbook(records);
    let sourceOpens = 0;
    const fileSystem = withOpen(async (target, flags, mode) => {
      if (target === filePath && flags === 'r') sourceOpens += 1;
      return nodeAdifFileSystem.open(target, flags, mode);
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    const opened = await store.open();
    const document = LogbookDocument.fromScan(opened.scan!, opened.recordProjections);
    const last = document.getQsoRecords().at(-1)!;
    const mutation = document.prepareUpdate(last.id, { notes: 'rewritten' });
    const sourceParts = mutation.rewriteParts.filter(part => part.kind === 'source');
    expect(sourceParts.length).toBeGreaterThan(2_000);

    await store.commitRewrite(
      mutation.rewriteParts,
      opened.generation,
      { recordCount: 2_000 },
    );

    // One handle hashes the expected generation and one streams all source ranges.
    expect(sourceOpens).toBeLessThanOrEqual(2);
    await store.close();
  });

  it('uses the open scan and incrementally validates successful appends', async () => {
    const { filePath } = await createLogbook(`${adifRecord('BG5AX')}\n`);
    let scans = 0;
    const scanner = {
      scan: async (target: string) => {
        scans += 1;
        return scanLogbookFileInline(target);
      },
    };
    const store = new AdifFileStore(filePath, { scanner });
    const opened = await store.open();

    const first = await store.commitAppend(
      [Buffer.from(`${adifRecord('BG5AY')}\n`)],
      opened.generation,
    );
    await store.commitAppend(
      [Buffer.from(`${adifRecord('BG5AZ')}\n`)],
      first.generation,
    );

    expect(scans).toBe(1);
  });

  it.each([
    {
      name: 'header-only CRLF file',
      initial: 'Generated by test\r\n<ADIF_VER:5>3.1.4\r\n<EOH>\r\n',
    },
    {
      name: 'headerless file with a complete record and safe trailing whitespace',
      initial: `${adifRecord('BG5AU')}\r\n \t`,
    },
    {
      name: 'whitespace-only file',
      initial: '\r\n \t',
    },
  ])('matches a full scan after a multi-record append to a $name', async ({ initial }) => {
    const duplicate = '<CALL:5>BG5AV<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>';
    const opaque = '<VENDOR_NOTE:14>literal <EOR>!<EOR>';
    const append = Buffer.from(`\r\n${duplicate}\n${duplicate}\n${opaque}\n`);
    const { filePath } = await createLogbook(initial);
    const store = new AdifFileStore(filePath);
    const opened = await store.open();

    const committed = await store.commitAppend(
      [append.subarray(0, 17), append.subarray(17)],
      opened.generation,
    );
    const rescanned = await scanLogbookFileInline(filePath);

    expect(committed.scan).toEqual(rescanned.scan);
    expect(committed.recordProjections).toEqual(rescanned.recordProjections);
    expect(committed.generation).toMatchObject({
      contentHash: rescanned.generation.contentHash,
      scanHash: rescanned.generation.scanHash,
      size: rescanned.generation.size,
    });
    if (opened.scan!.records.length > 0) {
      expect(committed.scan.records[opened.scan!.records.length]!.leadingRange.start)
        .toBe(opened.scan!.safeTrailingRange.start);
    }
  });

  it('detects an in-place same-stat content replacement before opening for append', async () => {
    const original = `${adifRecord('BG5AW')}\n`;
    const replacement = `${adifRecord('BG5AX')}\n`;
    const { filePath } = await createLogbook(original);
    let frozenMtime: number | undefined;
    let appendOpened = false;
    const fileSystem: AdifFileSystem = {
      ...nodeAdifFileSystem,
      stat: async (target) => {
        const value = await nodeAdifFileSystem.stat(target);
        return target === filePath && frozenMtime !== undefined
          ? { ...value, mtimeMs: frozenMtime, isFile: () => value.isFile() }
          : value;
      },
      open: async (target, flags, mode) => {
        if (target === filePath && flags === ADIF_APPEND_FLAGS) appendOpened = true;
        return nodeAdifFileSystem.open(target, flags, mode);
      },
    };
    const store = new AdifFileStore(filePath, { fileSystem });
    const opened = await store.open();
    frozenMtime = opened.generation!.mtimeMs;
    await writeFile(filePath, replacement);

    await expect(store.commitAppend(
      [Buffer.from(`${adifRecord('BG5AY')}\n`)],
      opened.generation,
    )).rejects.toBeInstanceOf(AdifGenerationConflictError);
    expect(appendOpened).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe(replacement);
    expect(store.getState().status).toBe('read-only');
  });

  it('enters uncertain state when the fsynced suffix is replaced by same-length bytes', async () => {
    const original = `${adifRecord('BG5AW')}` + String.fromCharCode(10);
    const appended = `${adifRecord('BG5AX')}` + String.fromCharCode(10);
    const competing = `${adifRecord('BG5AY')}` + String.fromCharCode(10);
    const { filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath, {
      faultHook: async ({ point }) => {
        if (point === 'append-after-fsync') {
          await writeFile(filePath, original + competing);
        }
      },
    });
    const opened = await store.open();

    await expect(store.commitAppend([Buffer.from(appended)], opened.generation))
      .rejects.toBeInstanceOf(AdifFileStateUncertainError);

    expect(Buffer.byteLength(competing)).toBe(Buffer.byteLength(appended));
    expect(await readFile(filePath, 'utf8')).toBe(original + competing);
    expect(store.getState()).toMatchObject({
      status: 'uncertain',
      issues: [expect.objectContaining({ code: 'STATE_UNCERTAIN' })],
    });
    await expect(store.commitAppend([Buffer.from(appended)]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
  });

  it('does not rescan 70K existing records after a successful append', async () => {
    const records = Array.from(
      { length: 70_000 },
      (_, index) => `<CALL:5>BG5AZ<APP_TX5DR_ID:7>${String(index).padStart(7, '0')}<EOR>\n`,
    ).join('');
    const { filePath } = await createLogbook(records);
    let scans = 0;
    const scanner = {
      scan: async (target: string) => {
        scans += 1;
        return scanLogbookFileInline(target);
      },
    };
    const store = new AdifFileStore(filePath, { scanner });
    const opened = await store.open();

    const committed = await store.commitAppend(
      [Buffer.from(`${adifRecord('BG5BA', 'tail-id')}\n`)],
      opened.generation,
    );

    expect(scans).toBe(1);
    expect(committed.scan.records).toHaveLength(70_001);
    expect(committed.recordProjections.at(-1)?.qso?.id).toBe('tail-id');
  }, 20_000);

  it('rejects a stale generation before writing anything', async () => {
    const original = `${adifRecord('BG5BA')}\n`;
    const { filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath);
    const open = await store.open();
    await writeFile(filePath, `${original}${adifRecord('BG5BB')}\n`);

    await expect(store.commitAppend([Buffer.from(adifRecord('BG5BC'))], open.generation))
      .rejects.toBeInstanceOf(AdifGenerationConflictError);
    expect(await readFile(filePath, 'utf8')).not.toContain('BG5BC');
    expect(store.getState()).toMatchObject({
      status: 'read-only',
      issues: [expect.objectContaining({ code: 'GENERATION_CONFLICT' })],
    });
    await expect(store.commitRewrite([Buffer.from(original)]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
    await expect(store.open()).resolves.toMatchObject({ status: 'ready' });
  });

  it('becomes read-only when the formal ADIF disappears before a mutation', async () => {
    const original = `${adifRecord('BG5BD')}\n`;
    const { directory, filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath);
    const opened = await store.open();
    await rm(filePath);

    await expect(store.commitAppend(
      [Buffer.from(`${adifRecord('BG5BE')}\n`)],
      opened.generation,
    )).rejects.toMatchObject({
      code: 'ADIF_STORE_READ_ONLY',
      cause: { code: 'ENOENT' },
    });

    expect(store.getState()).toMatchObject({
      status: 'read-only',
      issues: [expect.objectContaining({ code: 'MAIN_FILE_MISSING' })],
    });
    await expect(store.commitRewrite([Buffer.from(original)]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('becomes read-only when main-file access fails while verifying a rewrite baseline', async () => {
    const original = `${adifRecord('BG5BF')}\n`;
    const replacement = `${adifRecord('BG5BG')}\n`;
    const { directory, filePath } = await createLogbook(original);
    let denyMainStat = false;
    const fileSystem: AdifFileSystem = {
      ...nodeAdifFileSystem,
      stat: async (target) => {
        if (target === filePath && denyMainStat) {
          throw Object.assign(new Error('injected main permission denial'), { code: 'EACCES' });
        }
        return nodeAdifFileSystem.stat(target);
      },
    };
    const store = new AdifFileStore(filePath, { fileSystem });
    const opened = await store.open();
    denyMainStat = true;

    await expect(store.commitRewrite(
      [Buffer.from(replacement)],
      opened.generation,
      { recordCount: 1 },
    )).rejects.toMatchObject({
      code: 'ADIF_STORE_READ_ONLY',
      cause: { code: 'EACCES' },
    });

    expect(store.getState()).toMatchObject({
      status: 'read-only',
      issues: [expect.objectContaining({ code: 'MAIN_SCAN_FAILED' })],
    });
    await expect(store.commitAppend([Buffer.from(replacement)]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['station.adi']);
  });

  it('becomes read-only after a worker baseline scan fails and does not rescan on later writes', async () => {
    const original = `${adifRecord('BG5BH')}\n`;
    const appended = `${adifRecord('BG5BI')}\n`;
    const { directory, filePath } = await createLogbook(original);
    let failMainScan = false;
    let scans = 0;
    const scanner = {
      scan: async (target: string) => {
        scans += 1;
        if (target === filePath && failMainScan) {
          throw Object.assign(new Error('injected worker scan failure'), { code: 'EIO' });
        }
        return scanLogbookFileInline(target);
      },
    };
    const store = new AdifFileStore(filePath, { scanner });
    await store.open();
    failMainScan = true;

    await expect(store.commitAppend([Buffer.from(appended)]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
    expect(store.getState()).toMatchObject({
      status: 'read-only',
      issues: [expect.objectContaining({
        code: 'MAIN_SCAN_FAILED',
        cause: 'injected worker scan failure',
      })],
    });

    const scansAfterFailure = scans;
    await expect(store.commitAppend([Buffer.from(appended)]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
    expect(scans).toBe(scansAfterFailure);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['station.adi']);
  });

  it('loops partial writes until the entire append is durable', async () => {
    const original = `${adifRecord('BG5CA')}\n`;
    const appended = `${adifRecord('BG5CB')}\n`;
    const { filePath } = await createLogbook(original);
    let appendWriteCalls = 0;
    const fileSystem = withOpen(async (target, flags, mode) => {
      const handle = await nodeAdifFileSystem.open(target, flags, mode);
      if (flags !== ADIF_APPEND_FLAGS) return handle;
      return wrapHandle(handle, {
        write: async (buffer, offset = 0, length = buffer.byteLength, position = null) => {
          appendWriteCalls += 1;
          return handle.write(buffer, offset, Math.min(length, 7), position);
        },
      });
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    await store.open();

    await store.commitAppend([Buffer.from(appended)]);

    expect(appendWriteCalls).toBeGreaterThan(1);
    expect(await readFile(filePath, 'utf8')).toBe(original + appended);
  });

  it('does not attempt a destructive rollback when opening for append fails', async () => {
    const original = `${adifRecord('BG5CC')}\n`;
    const { filePath } = await createLogbook(original);
    let rollbackOpened = false;
    const fileSystem = withOpen(async (target, flags, mode) => {
      if (target === filePath && flags === ADIF_APPEND_FLAGS) {
        throw Object.assign(new Error('append permission denied'), { code: 'EACCES' });
      }
      if (target === filePath && flags === 'r+') rollbackOpened = true;
      return nodeAdifFileSystem.open(target, flags, mode);
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    await store.open();

    await expect(store.commitAppend([Buffer.from(adifRecord('BG5CD'))])).rejects.toMatchObject({
      rolledBack: true,
      cause: { code: 'EACCES' },
    });
    expect(rollbackOpened).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(store.getState().status).toBe('ready');
  });

  it('skips truncate when a failed first write left the content unchanged', async () => {
    const original = `${adifRecord('BG5CE')}\n`;
    const { filePath } = await createLogbook(original);
    let rollbackOpened = false;
    const fileSystem = withOpen(async (target, flags, mode) => {
      const handle = await nodeAdifFileSystem.open(target, flags, mode);
      if (target === filePath && flags === ADIF_APPEND_FLAGS) {
        return wrapHandle(handle, {
          write: async () => {
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          },
        });
      }
      if (target === filePath && flags === 'r+') rollbackOpened = true;
      return handle;
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    await store.open();

    await expect(store.commitAppend([Buffer.from(adifRecord('BG5CF'))])).rejects.toMatchObject({
      rolledBack: true,
      cause: { code: 'ENOSPC' },
    });
    expect(rollbackOpened).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(store.getState().status).toBe('ready');
  });

  it('rolls a failed partial append back to the exact previous EOF', async () => {
    const original = `${adifRecord('BG5DA')}\n`;
    const { filePath } = await createLogbook(original);
    let appendWriteCalls = 0;
    const fileSystem = withOpen(async (target, flags, mode) => {
      const handle = await nodeAdifFileSystem.open(target, flags, mode);
      if (flags !== ADIF_APPEND_FLAGS) return handle;
      return wrapHandle(handle, {
        write: async (buffer, offset = 0, length = buffer.byteLength, position = null) => {
          appendWriteCalls += 1;
          if (appendWriteCalls > 1) throw new Error('injected write failure');
          return handle.write(buffer, offset, Math.min(length, 11), position);
        },
      });
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    await store.open();

    const failure = store.commitAppend([Buffer.from(`${adifRecord('BG5DB')}\n`)]);

    await expect(failure).rejects.toMatchObject({ rolledBack: true });
    await expect(failure).rejects.toBeInstanceOf(AdifFileCommitError);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(store.getState().status).toBe('ready');
  });

  it('rolls back an append fsync failure and reports a verified generation', async () => {
    const original = `${adifRecord('BG5EA')}\n`;
    const { filePath } = await createLogbook(original);
    const fileSystem = withOpen(async (target, flags, mode) => {
      const handle = await nodeAdifFileSystem.open(target, flags, mode);
      return flags === ADIF_APPEND_FLAGS
        ? wrapHandle(handle, { sync: async () => { throw new Error('injected fsync failure'); } })
        : handle;
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    await store.open();

    await expect(store.commitAppend([Buffer.from(adifRecord('BG5EB'))]))
      .rejects.toMatchObject({ rolledBack: true, generation: { size: Buffer.byteLength(original) } });
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('rolls back a fully written append that would leave an incomplete ADIF tail', async () => {
    const original = `${adifRecord('BG5EC')}\n`;
    const { filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath);
    await store.open();

    await expect(store.commitAppend([Buffer.from('<CALL:5>BG5ED')]))
      .rejects.toMatchObject({ rolledBack: true });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(store.getState().status).toBe('ready');
  });

  it('enters uncertain read-only state when rollback itself cannot truncate', async () => {
    const original = `${adifRecord('BG5FA')}\n`;
    const { filePath } = await createLogbook(original);
    let appendWriteCalls = 0;
    const onStateUncertain = vi.fn();
    const fileSystem = withOpen(async (target, flags, mode) => {
      const handle = await nodeAdifFileSystem.open(target, flags, mode);
      if (flags === ADIF_APPEND_FLAGS) {
        return wrapHandle(handle, {
          write: async (buffer, offset = 0, length = buffer.byteLength, position = null) => {
            appendWriteCalls += 1;
            if (appendWriteCalls > 1) throw new Error('injected append failure');
            return handle.write(buffer, offset, Math.min(length, 5), position);
          },
        });
      }
      if (flags === 'r+') {
        return wrapHandle(handle, { truncate: async () => { throw new Error('injected truncate failure'); } });
      }
      return handle;
    });
    const store = new AdifFileStore(filePath, { fileSystem, onStateUncertain });
    await store.open();

    await expect(store.commitAppend([Buffer.from(adifRecord('BG5FB'))]))
      .rejects.toBeInstanceOf(AdifFileStateUncertainError);
    expect(store.getState().status).toBe('uncertain');
    expect(onStateUncertain).toHaveBeenCalledOnce();
    await expect(store.commitAppend([Buffer.from(adifRecord('BG5FC'))]))
      .rejects.toMatchObject({ code: 'ADIF_STORE_READ_ONLY' });
  });

  it('enters uncertain state when rollback truncate succeeds but rollback fsync fails', async () => {
    const original = `${adifRecord('BG5FC')}\n`;
    const { filePath } = await createLogbook(original);
    let appendWriteCalls = 0;
    const fileSystem = withOpen(async (target, flags, mode) => {
      const handle = await nodeAdifFileSystem.open(target, flags, mode);
      if (flags === ADIF_APPEND_FLAGS) {
        return wrapHandle(handle, {
          write: async (buffer, offset = 0, length = buffer.byteLength, position = null) => {
            appendWriteCalls += 1;
            if (appendWriteCalls > 1) throw new Error('injected append failure');
            return handle.write(buffer, offset, Math.min(length, 5), position);
          },
        });
      }
      if (flags === 'r+') {
        return wrapHandle(handle, { sync: async () => { throw new Error('injected rollback fsync failure'); } });
      }
      return handle;
    });
    const store = new AdifFileStore(filePath, { fileSystem });
    await store.open();

    await expect(store.commitAppend([Buffer.from(adifRecord('BG5FD'))]))
      .rejects.toBeInstanceOf(AdifFileStateUncertainError);
    expect(store.getState().status).toBe('uncertain');
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('validates a rewrite before rename and removes stale temp on the next open', async () => {
    const original = `${adifRecord('BG5GA')}\n`;
    const { filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath);
    await store.open();

    await expect(store.commitRewrite([Buffer.from('<CALL:5>BG5GB')]))
      .rejects.toBeInstanceOf(AdifRewriteValidationError);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    await expect(readFile(store.rewriteTempPath, 'utf8')).resolves.toContain('BG5GB');

    await expect(store.open()).resolves.toMatchObject({ status: 'ready' });
    await expect(readFile(store.rewriteTempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps only fixed rewrite artifacts and rotates one validated last-good snapshot', async () => {
    const first = `${adifRecord('BG5HA')}\n`;
    const second = `${adifRecord('BG5HB')}\n`;
    const third = `${adifRecord('BG5HC')}\n`;
    const { filePath } = await createLogbook(first);
    const store = new AdifFileStore(filePath);
    await store.open();

    await store.commitRewrite([Buffer.from(second)], undefined, { recordCount: 1 });
    expect(await readFile(store.lastGoodPath, 'utf8')).toBe(first);
    await store.commitRewrite([Buffer.from(third)], undefined, { recordCount: 1 });

    expect(await readFile(filePath, 'utf8')).toBe(third);
    expect(await readFile(store.lastGoodPath, 'utf8')).toBe(second);
    expect((await readdir(store.recoveryDirectory)).sort()).toEqual(['last-good.adi']);
  });

  it('converges interrupted rewrite and last-good recovery without growing artifacts', async () => {
    const original = `${adifRecord('BG5IA')}\n`;
    const replacement = `${adifRecord('BG5IB')}\n`;
    const { filePath } = await createLogbook('not recoverable as ADIF');
    const paths = new AdifFileStore(filePath);
    const recoveryDirectory = paths.recoveryDirectory;
    await mkdir(recoveryDirectory, { recursive: true });
    await writeFile(paths.rewriteTempPath, replacement);
    await writeFile(paths.lastGoodPath, original);

    const firstOpen = await new AdifFileStore(filePath).open();
    expect(firstOpen).toMatchObject({ recoveredFrom: 'rewrite.tmp', status: 'degraded' });
    expect(await readFile(filePath, 'utf8')).toBe(replacement);
    expect((await readdir(recoveryDirectory)).sort()).toEqual(['last-good.adi']);

    await writeFile(filePath, 'still not recoverable as ADIF');
    const secondOpen = await new AdifFileStore(filePath).open();
    expect(secondOpen).toMatchObject({ recoveredFrom: 'last-good.adi', status: 'degraded' });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect((await readdir(recoveryDirectory)).sort()).toEqual(['last-good.adi']);

    await new AdifFileStore(filePath).open();
    expect((await readdir(recoveryDirectory)).sort()).toEqual(['last-good.adi']);
  });

  it.each([
    { artifact: 'rewrite.tmp' as const },
    { artifact: 'last-good.adi' as const },
  ])('does not replace main with complete $artifact when the initial main scan fails', async ({ artifact }) => {
    const original = `${adifRecord('BG5IC')}\n`;
    const recoveredContent = `${adifRecord('BG5ID')}\n`;
    const { directory, filePath } = await createLogbook(original);
    const paths = new AdifFileStore(filePath);
    const artifactPath = artifact === 'rewrite.tmp'
      ? paths.rewriteTempPath
      : paths.lastGoodPath;
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(artifactPath, recoveredContent);
    const scannedPaths: string[] = [];
    const scanner = {
      scan: async (target: string) => {
        scannedPaths.push(target);
        if (target === filePath) {
          throw Object.assign(new Error('injected initial main scan failure'), { code: 'EACCES' });
        }
        return scanLogbookFileInline(target);
      },
    };

    const opened = await new AdifFileStore(filePath, { scanner }).open();

    expect(opened).toMatchObject({
      status: 'unavailable',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'MAIN_SCAN_FAILED' })]),
    });
    expect(scannedPaths).toEqual([filePath]);
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(await readFile(artifactPath, 'utf8')).toBe(recoveredContent);
    await expect(readFile(paths.unrecoverableOriginalPath))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).sort()).toEqual(['.tx5dr-recovery', 'station.adi']);
  });

  it('leaves all fixed files untouched when a corrupt main has no scannable recovery candidate', async () => {
    const original = 'not a usable ADIF file';
    const rewrite = `${adifRecord('BG5IF')}\n`;
    const lastGood = `${adifRecord('BG5IG')}\n`;
    const { filePath } = await createLogbook(original);
    const paths = new AdifFileStore(filePath);
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(paths.rewriteTempPath, rewrite);
    await writeFile(paths.lastGoodPath, lastGood);
    const rejectedPaths = new Set([paths.rewriteTempPath, paths.lastGoodPath]);
    const scanner = {
      scan: async (target: string) => {
        if (rejectedPaths.has(target)) {
          throw Object.assign(new Error(`injected scan failure for ${path.basename(target)}`), {
            code: 'EIO',
          });
        }
        return scanLogbookFileInline(target);
      },
    };

    const opened = await new AdifFileStore(filePath, { scanner }).open();

    expect(opened).toMatchObject({
      status: 'unavailable',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'REWRITE_TEMP_SCAN_FAILED' }),
        expect.objectContaining({ code: 'LAST_GOOD_SCAN_FAILED' }),
      ]),
    });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(await readFile(paths.rewriteTempPath, 'utf8')).toBe(rewrite);
    expect(await readFile(paths.lastGoodPath, 'utf8')).toBe(lastGood);
    await expect(readFile(paths.unrecoverableOriginalPath))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(paths.recoveryDirectory)).sort())
      .toEqual(['last-good.adi', 'rewrite.tmp']);

    const healthy = await createLogbook(`${adifRecord('BG5IH')}\n`);
    const healthyStore = new AdifFileStore(healthy.filePath);
    await expect(healthyStore.open()).resolves.toMatchObject({ status: 'ready' });
    await expect(healthyStore.commitAppend([Buffer.from(`${adifRecord('BG5II')}\n`)]))
      .resolves.toMatchObject({ scan: { records: [expect.any(Object), expect.any(Object)] } });
  });

  it('preserves and removes only the unsafe tail when a complete prefix survives', async () => {
    const complete = `${adifRecord('BG5JA')}\n`;
    const unsafeTail = '<CALL:5>BG5JB';
    const { filePath } = await createLogbook(`${complete}${unsafeTail}`);
    const store = new AdifFileStore(filePath);

    await expect(store.open()).resolves.toMatchObject({
      status: 'degraded',
      recoveredFrom: 'safe-prefix',
      scan: { records: expect.arrayContaining([expect.any(Object)]) },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'TRUNCATED_UNSAFE_TAIL' })]),
    });
    expect(await readFile(filePath, 'utf8')).toBe(complete);
    expect(await readFile(store.tailFragmentPath, 'utf8')).toBe(unsafeTail);
  });

  it('creates a standard header for a missing logbook and removes empty lock directories', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-adif-store-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'new.adi');
    const store = new AdifFileStore(filePath);

    await expect(store.open()).resolves.toMatchObject({ status: 'ready', scan: { records: [] } });

    const content = await readFile(filePath, 'utf8');
    expect(content).toContain('<ADIF_VER:5>3.1.4');
    expect(content).toContain('<PROGRAMID:6>TX-5DR');
    expect(content).toContain('<EOH>');
    expect(await readdir(directory)).toEqual(['new.adi']);
  });

  it('does not create an empty main when legacy migration failed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-adif-store-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'legacy-pending.adi');
    const store = new AdifFileStore(filePath, { createIfMissing: false });

    await expect(store.open()).resolves.toMatchObject({
      status: 'unavailable',
      issues: [expect.objectContaining({ code: 'MAIN_CREATION_DEFERRED' })],
    });
    await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('does not repair a salvageable tail when recovery writes are disabled', async () => {
    const complete = `${adifRecord('BG5KC')}\n`;
    const unsafeTail = '<CALL:5>BG5KD';
    const original = `${complete}${unsafeTail}`;
    const { directory, filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath, { recoveryWritesEnabled: false });

    const opened = await store.open();

    expect(opened).toMatchObject({
      status: 'read-only',
      scan: { records: [expect.any(Object)] },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'RECOVERY_WRITE_BLOCKED' })]),
    });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(await readdir(directory)).toEqual(['station.adi']);
  });

  it('leaves an unrecoverable main and valid recovery candidate untouched when recovery writes are disabled', async () => {
    const original = 'not a usable ADIF file';
    const replacement = `${adifRecord('BG5KE')}\n`;
    const { filePath } = await createLogbook(original);
    const paths = new AdifFileStore(filePath);
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(paths.rewriteTempPath, replacement);
    const store = new AdifFileStore(filePath, { recoveryWritesEnabled: false });

    const opened = await store.open();

    expect(opened).toMatchObject({
      status: 'unavailable',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'RECOVERY_WRITE_BLOCKED' })]),
    });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    expect(await readFile(paths.rewriteTempPath, 'utf8')).toBe(replacement);
    await expect(readFile(paths.unrecoverableOriginalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not rewrite a whitespace-only existing file', async () => {
    const whitespace = ' \r\n\t\r\n';
    const { filePath } = await createLogbook(whitespace);

    await expect(new AdifFileStore(filePath).open()).resolves.toMatchObject({ status: 'ready' });
    expect(await readFile(filePath, 'utf8')).toBe(whitespace);
  });

  it('preserves a wholly unrecoverable source once and starts with a standard empty ADIF', async () => {
    const garbage = 'this is not an ADIF file';
    const { filePath } = await createLogbook(garbage);
    const store = new AdifFileStore(filePath);

    await expect(store.open()).resolves.toMatchObject({
      status: 'degraded',
      recoveredFrom: 'standard-empty',
      issues: [expect.objectContaining({ code: 'RESET_UNRECOVERABLE_MAIN' })],
    });
    expect(await readFile(store.unrecoverableOriginalPath, 'utf8')).toBe(garbage);
    expect(await readFile(filePath, 'utf8')).toContain('<EOH>');
    await expect(readFile(store.tailFragmentPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const secondGarbage = 'a different broken source';
    await writeFile(filePath, secondGarbage);
    await expect(new AdifFileStore(filePath).open()).resolves.toMatchObject({
      status: 'unavailable',
      issues: [expect.objectContaining({ code: 'UNRECOVERABLE_ORIGINAL_CONFLICT' })],
    });
    expect(await readFile(filePath, 'utf8')).toBe(secondGarbage);
    expect(await readFile(store.unrecoverableOriginalPath, 'utf8')).toBe(garbage);
  });

  it('resumes after a crash that preserved the unrecoverable original before reset', async () => {
    const garbage = 'unrecoverable but preserved before the injected crash';
    const { filePath } = await createLogbook(garbage);
    const interrupted = new AdifFileStore(filePath, {
      faultHook: ({ point }) => {
        if (point === 'recovery-after-unrecoverable-preserved') {
          throw new Error('injected crash after preserving original');
        }
      },
    });

    await expect(interrupted.open()).resolves.toMatchObject({
      status: 'unavailable',
      issues: [expect.objectContaining({ code: 'OPEN_FAILED' })],
    });
    expect(await readFile(interrupted.unrecoverableOriginalPath, 'utf8')).toBe(garbage);
    expect(await readFile(filePath, 'utf8')).toBe(garbage);

    const resumed = new AdifFileStore(filePath);
    await expect(resumed.open()).resolves.toMatchObject({
      status: 'degraded',
      recoveredFrom: 'standard-empty',
      issues: [expect.objectContaining({ code: 'RESET_UNRECOVERABLE_MAIN' })],
    });
    expect(await readFile(resumed.unrecoverableOriginalPath, 'utf8')).toBe(garbage);
    expect(await readFile(filePath, 'utf8')).toContain('<EOH>');
  });

  it('does not overwrite a different fixed tail fragment', async () => {
    const complete = `${adifRecord('BG5MA')}\n`;
    const { filePath } = await createLogbook(`${complete}first broken tail`);
    const store = new AdifFileStore(filePath);
    await store.open();
    expect(await readFile(store.tailFragmentPath, 'utf8')).toBe('first broken tail');

    const secondTail = 'second broken tail';
    await writeFile(filePath, `${complete}${secondTail}`);
    await expect(new AdifFileStore(filePath).open()).resolves.toMatchObject({
      status: 'read-only',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'TAIL_FRAGMENT_CONFLICT' })]),
    });
    expect(await readFile(filePath, 'utf8')).toBe(`${complete}${secondTail}`);
    expect(await readFile(store.tailFragmentPath, 'utf8')).toBe('first broken tail');
  });

  it('expires a fixed tail fragment after 30 days only when the main scan is complete', async () => {
    const complete = `${adifRecord('BG5MQ')}\n`;
    const { directory, filePath } = await createLogbook(complete);
    const paths = new AdifFileStore(filePath);
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(paths.tailFragmentPath, 'old tail');
    const fragmentMtime = (await nodeAdifFileSystem.stat(paths.tailFragmentPath)).mtimeMs;

    await new AdifFileStore(filePath, {
      now: () => fragmentMtime + LOGBOOK_TAIL_FRAGMENT_RETENTION_MS + 1,
    }).open();

    await expect(readFile(paths.tailFragmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(directory)).toEqual(['station.adi']);

    const unsafeTail = 'new unsafe tail';
    await writeFile(filePath, `${complete}${unsafeTail}`);
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(paths.tailFragmentPath, unsafeTail);
    const unsafeMtime = (await nodeAdifFileSystem.stat(paths.tailFragmentPath)).mtimeMs;
    await new AdifFileStore(filePath, {
      now: () => unsafeMtime + LOGBOOK_TAIL_FRAGMENT_RETENTION_MS + 1,
    }).open();
    expect(await readFile(paths.tailFragmentPath, 'utf8')).toBe(unsafeTail);

    const unhealthyObservedAt = (await nodeAdifFileSystem.stat(paths.tailFragmentPath)).mtimeMs;
    await writeFile(filePath, complete);
    await new AdifFileStore(filePath, {
      now: () => unhealthyObservedAt + LOGBOOK_TAIL_FRAGMENT_RETENTION_MS - 1,
    }).open();
    expect(await readFile(paths.tailFragmentPath, 'utf8')).toBe(unsafeTail);

    await new AdifFileStore(filePath, {
      now: () => unhealthyObservedAt + LOGBOOK_TAIL_FRAGMENT_RETENTION_MS + 1,
    }).open();
    await expect(readFile(paths.tailFragmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports recovery cleanup failure without making a readable main unavailable', async () => {
    const complete = `${adifRecord('BG5MR')}\n`;
    const { filePath } = await createLogbook(complete);
    const paths = new AdifFileStore(filePath);
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(paths.rewriteTempPath, 'stale temp');
    const fileSystem: AdifFileSystem = {
      ...nodeAdifFileSystem,
      unlink: async (target) => {
        if (target === paths.rewriteTempPath) {
          const error = new Error('injected cleanup denial') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
        await nodeAdifFileSystem.unlink(target);
      },
    };

    const opened = await new AdifFileStore(filePath, { fileSystem }).open();

    expect(opened).toMatchObject({
      status: 'degraded',
      scan: { records: expect.any(Array) },
      issues: expect.arrayContaining([expect.objectContaining({ code: 'CLEANUP_PENDING' })]),
    });
    expect(await readFile(filePath, 'utf8')).toBe(complete);
  });

  it('streams source ranges and literal bytes into a rewrite and offers consistent reads', async () => {
    const first = adifRecord('BG5NA');
    const second = adifRecord('BG5NB');
    const replacement = adifRecord('BG5NC');
    const initial = `${first}\n${second}\n`;
    const { filePath } = await createLogbook(initial);
    const store = new AdifFileStore(filePath);
    const opened = await store.open();
    const firstEnd = opened.scan!.records[0]!.range.end;

    const committed = await store.commitRewrite([
      mainFileRange(0, firstEnd),
      literalAdifBytes(Buffer.from(`\n${replacement}\n`)),
    ], opened.generation, { recordCount: 2 });

    expect(await readFile(filePath, 'utf8')).toBe(`${first}\n${replacement}\n`);
    const firstRange = await store.readRange({ start: 0, end: firstEnd }, committed.generation);
    expect(firstRange.data.toString()).toBe(first);
    const all = await store.readAll(committed.generation);
    expect(all.data.toString()).toBe(`${first}\n${replacement}\n`);
    expect(all.scan.records).toHaveLength(2);
  });

  it.each(['rewrite-after-main-rename', 'rewrite-after-directory-fsync'] as const)(
    'marks state uncertain when %s fails',
    async (failurePoint) => {
      const { filePath } = await createLogbook(`${adifRecord('BG5OA')}\n`);
      const store = new AdifFileStore(filePath, {
        faultHook: ({ point }) => {
          if (point === failurePoint) throw new Error(`injected ${failurePoint}`);
        },
      });
      await store.open();

      await expect(store.commitRewrite([Buffer.from(`${adifRecord('BG5OB')}\n`)]))
        .rejects.toBeInstanceOf(AdifFileStateUncertainError);
      expect(store.getState().status).toBe('uncertain');
    },
  );

  it.each([
    'rewrite-after-temp-write',
    'rewrite-after-temp-fsync',
    'rewrite-after-temp-validated',
    'rewrite-after-last-good-copy',
    'rewrite-after-last-good-fsync',
    'rewrite-after-last-good-rename',
  ] as const)('keeps the old main authoritative when %s fails before rename', async (failurePoint) => {
    const original = `${adifRecord('BG5OQ')}\n`;
    const replacement = `${adifRecord('BG5OR')}\n`;
    const { filePath } = await createLogbook(original);
    const store = new AdifFileStore(filePath, {
      faultHook: ({ point }) => {
        if (point === failurePoint) throw new Error(`injected ${failurePoint}`);
      },
    });
    await store.open();

    await expect(store.commitRewrite([Buffer.from(replacement)])).rejects.toThrow(`injected ${failurePoint}`);
    expect(await readFile(filePath, 'utf8')).toBe(original);

    const reopened = new AdifFileStore(filePath);
    await expect(reopened.open()).resolves.toMatchObject({ status: 'ready' });
    expect(await readFile(filePath, 'utf8')).toBe(original);
    if (failurePoint === 'rewrite-after-last-good-rename') {
      expect((await readdir(reopened.recoveryDirectory)).sort()).toEqual(['last-good.adi']);
    } else {
      await expect(readdir(reopened.recoveryDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('returns uncertain health instead of throwing when recovery fails after rename', async () => {
    const { filePath } = await createLogbook('garbage');
    const paths = new AdifFileStore(filePath);
    await mkdir(paths.recoveryDirectory, { recursive: true });
    await writeFile(paths.rewriteTempPath, `${adifRecord('BG5PA')}\n`);
    const store = new AdifFileStore(filePath, {
      faultHook: ({ point }) => {
        if (point === 'recovery-after-main-rename') throw new Error('injected recovery crash');
      },
    });

    await expect(store.open()).resolves.toMatchObject({ status: 'uncertain' });
    expect(store.getState().status).toBe('uncertain');
  });

  it('serializes same-path appends across store instances and close waits without rewriting', async () => {
    const { filePath } = await createLogbook('');
    const gate = deferred();
    const firstAtWrite = deferred();
    let pauseFirst = true;
    let secondStarted = false;
    const first = new AdifFileStore(filePath, {
      faultHook: async ({ point }) => {
        if (point === 'append-after-write' && pauseFirst) {
          pauseFirst = false;
          firstAtWrite.resolve();
          await gate.promise;
        }
      },
    });
    const second = new AdifFileStore(filePath, {
      faultHook: ({ point }) => {
        if (point === 'append-before-open') secondStarted = true;
      },
    });
    await Promise.all([first.open(), second.open()]);

    const firstAppend = first.commitAppend([Buffer.from(`${adifRecord('BG5KA')}\n`)]);
    await firstAtWrite.promise;
    const secondAppend = second.commitAppend([Buffer.from(`${adifRecord('BG5KB')}\n`)]);
    const closing = first.close();
    await new Promise(resolve => setImmediate(resolve));
    expect(secondStarted).toBe(false);

    gate.resolve();
    await Promise.all([firstAppend, secondAppend, closing]);

    expect(secondStarted).toBe(true);
    expect(await readFile(filePath, 'utf8')).toBe(`${adifRecord('BG5KA')}\n${adifRecord('BG5KB')}\n`);
    expect(first.getState().status).toBe('closed');
  });

  it('isolates scanner I/O failures as unavailable instead of throwing from open', async () => {
    const { filePath } = await createLogbook(adifRecord('BG5LA'));
    const scanner = {
      scan: async () => {
        throw Object.assign(new Error('injected read failure'), { code: 'EIO' });
      },
    };

    const result = await new AdifFileStore(filePath, { scanner }).open();

    expect(result.status).toBe('unavailable');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MAIN_SCAN_FAILED', cause: 'injected read failure' }),
    ]));
  });
});
