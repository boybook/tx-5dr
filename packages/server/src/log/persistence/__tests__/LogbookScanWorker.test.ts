import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { scanAdifBuffer } from '../AdifCodec.js';
import { projectLogbookRecords } from '../LogbookDocument.js';
import { scanLogbookFileInline } from '../LogbookScanCore.js';
import {
  LogbookScanTimeoutError,
  LogbookScanWorker,
  resolveLogbookScanWorkerEntry,
  type LogbookScanProcess,
} from '../LogbookScanWorker.js';

function adifRecord(call = 'BG5DR'): string {
  return `<CALL:${call.length}>${call}<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>`;
}

function fakeProcess(): LogbookScanProcess {
  const child = new EventEmitter() as LogbookScanProcess;
  child.kill = vi.fn(() => true) as LogbookScanProcess['kill'];
  child.send = vi.fn(() => true) as LogbookScanProcess['send'];
  return child;
}

function containsBuffer(value: unknown, seen = new Set<unknown>()): boolean {
  if (Buffer.isBuffer(value)) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some(entry => containsBuffer(entry, seen));
}

describe('LogbookScanWorker', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function tempFile(content: string | Buffer): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-logbook-scan-'));
    tempDirectories.push(directory);
    const filePath = path.join(directory, 'log.adi');
    await writeFile(filePath, content);
    return filePath;
  }

  it('computes stable content and structural generations without returning file bytes', async () => {
    const source = Buffer.from(`header<EOH>\n${adifRecord()}\n`);
    const filePath = await tempFile(source);

    const first = await scanLogbookFileInline(filePath);
    const second = await scanLogbookFileInline(filePath);

    expect(first.scan.records).toHaveLength(1);
    expect(first.generation).toEqual(second.generation);
    expect(first.generation.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.generation.scanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.generation.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.scan.records[0]?.fields).toEqual([]);
    expect(first.recordProjections[0]?.qso).toMatchObject({ callsign: 'BG5DR' });
    expect(containsBuffer(first)).toBe(false);
  });

  it('matches the byte codec across chunk boundaries without retaining the source file', async () => {
    const comment = 'before<EOR>\u53f0\u5317after';
    const source = Buffer.concat([
      Buffer.alloc(1024 * 1024 - 7, 0x20),
      Buffer.from(
        `<COMMENT:${Buffer.byteLength(comment)}>${comment}`
        + '<CALL:5>BG5DR<QSO_DATE:8>20260810<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>\r\n'
        + '<CALL:nope>BAD<QSO_DATE:8>20260810<TIME_ON:6>010204<EOR>\n'
        + '<CALL:5>PART',
      ),
    ]);
    const filePath = await tempFile(source);

    const streamed = await scanLogbookFileInline(filePath);
    const expected = scanAdifBuffer(source);
    const compactExpected = {
      ...expected,
      records: expected.records.map(record => ({ ...record, fields: [] })),
    };

    expect(streamed.scan).toEqual(compactExpected);
    expect(streamed.recordProjections).toEqual(projectLogbookRecords(expected.records));
    expect(containsBuffer(streamed)).toBe(false);
  });

  it('projects business fields larger than the former 8 MiB limit without silent data loss', async () => {
    const commentSize = 8 * 1024 * 1024 + 17;
    const comment = Buffer.alloc(commentSize, 0x78);
    comment[comment.length - 1] = 0x7a;
    const source = Buffer.concat([
      Buffer.from(`<COMMENT:${comment.length}>`),
      comment,
      Buffer.from(adifRecord()),
    ]);
    const filePath = await tempFile(source);

    const scanned = await scanLogbookFileInline(filePath);

    expect(scanned.scan.records).toHaveLength(1);
    expect(scanned.recordProjections).toHaveLength(1);
    expect(scanned.recordProjections[0]?.qso?.comment).toHaveLength(commentSize);
    expect(scanned.recordProjections[0]?.qso?.comment?.endsWith('z')).toBe(true);
    expect(scanned.warnings).not.toEqual(expect.arrayContaining([
      expect.stringContaining('projection limit'),
    ]));
  });

  it('reports real read advances, every MiB, and record progress every 1000 records', async () => {
    const source = Buffer.from(`${' '.repeat(2 * 1024 * 1024)}${adifRecord()}\n${adifRecord('BG5DS')}\n`);
    const filePath = await tempFile(source);
    const progress: Array<{ phase: string; bytesRead?: number; recordsScanned?: number }> = [];

    await scanLogbookFileInline(filePath, event => progress.push(event));

    const readProgress = progress
      .filter(event => event.phase === 'read')
      .map(event => event.bytesRead!);
    expect(readProgress).toEqual(expect.arrayContaining([64 * 1024, 1024 * 1024, 2 * 1024 * 1024]));
    expect(readProgress.at(-1)).toBe(source.length);
    expect(readProgress.every((value, index) => index === 0 || value > readProgress[index - 1]!)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'records', recordsScanned: 2 });

    const manyRecordsPath = await tempFile(Array.from({ length: 1001 }, () => adifRecord()).join('\n'));
    const recordProgress: number[] = [];
    await scanLogbookFileInline(manyRecordsPath, (event) => {
      if (event.phase === 'records') recordProgress.push(event.recordsScanned);
    });
    expect(recordProgress).toEqual([1000, 1001]);
  });

  it('rejects a file that changes while its stream is being read', async () => {
    const filePath = await tempFile(Buffer.alloc(2 * 1024 * 1024, 0x20));
    let changed = false;

    await expect(scanLogbookFileInline(filePath, (event) => {
      if (!changed && event.phase === 'read' && event.bytesRead >= 1024 * 1024) {
        changed = true;
        appendFileSync(filePath, adifRecord());
      }
    })).rejects.toMatchObject({ code: 'LOGBOOK_FILE_CHANGED_DURING_SCAN' });
  });

  it('kills a child that makes no progress for the configured timeout', async () => {
    vi.useFakeTimers();
    const child = fakeProcess();
    const scanner = new LogbookScanWorker({
      useInline: false,
      fallbackToInline: false,
      noProgressTimeoutMs: 100,
      workerFactory: () => child,
    });
    const pending = scanner.scan('/tmp/stalled.adi');
    const rejected = expect(pending).rejects.toBeInstanceOf(LogbookScanTimeoutError);
    child.emit('message', { type: 'ready' });

    await vi.advanceTimersByTimeAsync(101);

    await rejected;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('uses the 512 MiB heap cap and can fork the TypeScript entry in tests', async () => {
    const entry = resolveLogbookScanWorkerEntry();
    expect(entry.execArgv).toContain('--max-old-space-size=512');
    expect(entry.entryPath).toMatch(/logbook-scan-worker-entry\.(?:ts|js)$/);

    const filePath = await tempFile(adifRecord());
    const scanner = new LogbookScanWorker({
      useInline: false,
      fallbackToInline: false,
      noProgressTimeoutMs: 10_000,
    });
    await expect(scanner.scan(filePath)).resolves.toMatchObject({
      scan: { byteLength: Buffer.byteLength(adifRecord()) },
    });
  }, 15_000);

  it('delivers a result larger than the IPC high-water mark from a real child', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-logbook-scan-ipc-'));
    tempDirectories.push(directory);
    const nestedDirectory = path.join(directory, '\u65e5\u8a8c [IPC] #1');
    await mkdir(nestedDirectory);
    const filePath = path.join(nestedDirectory, '\u547c\u865f + space.adi');
    const comment = `\u53f0\u5317-${'x'.repeat(800 * 1024)}-\u7d42`;
    const source = Buffer.from(
      `<COMMENT:${Buffer.byteLength(comment)}>${comment}${adifRecord()}`,
    );
    await writeFile(filePath, source);

    const scanner = new LogbookScanWorker({
      useInline: false,
      fallbackToInline: false,
      noProgressTimeoutMs: 20_000,
    });
    const result = await scanner.scan(filePath);

    expect(Buffer.byteLength(comment)).toBeGreaterThan(768 * 1024);
    expect(result.scan.byteLength).toBe(source.length);
    expect(result.recordProjections).toHaveLength(1);
    expect(result.recordProjections[0]?.qso?.comment).toBe(comment);
  }, 30_000);
});
