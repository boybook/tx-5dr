import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { QSORecord } from '@tx5dr/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeAdifHeader, encodeAdifRecord } from '../AdifCodec.js';
import { LegacyLogbookMaintenance } from '../LegacyLogbookMaintenance.js';
import { LEGACY_RETENTION_MS } from '../legacyLogbookArtifacts.js';
import { scanLogbookFileInline } from '../LogbookScanCore.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tx5dr-logbook-maintenance-'));
  tempDirs.push(dir);
  return dir;
}

function healthyAdif(id: string, callsign: string): Buffer {
  const qso: QSORecord = {
    id,
    callsign,
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-08-10T01:02:03Z'),
    messageHistory: [],
  };
  return Buffer.concat([encodeAdifHeader(), encodeAdifRecord(qso)]);
}

function recoveryRoot(dir: string, mainPath: string): string {
  const hash = createHash('sha256').update(path.resolve(mainPath)).digest('hex').slice(0, 24);
  return path.join(dir, '.tx5dr-recovery', hash);
}

function backupDirectory(dir: string, mainPath: string): string {
  return path.join(dir, '.tx5dr-backups', path.basename(mainPath));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('LegacyLogbookMaintenance quarantine-only cleanup', () => {
  it('quarantines exact legacy artifacts without replaying them or changing main', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BG5DRB.adi');
    const original = healthyAdif('main-record', 'BG5DRB');
    await fs.writeFile(mainPath, original);
    await fs.writeFile(path.join(dir, 'BG5DRB.adi.bak.1'), healthyAdif('old-record', 'BG1OLD'));
    await fs.writeFile(path.join(dir, 'BG5DRB.journal.jsonl'), '{"op":"delete"}\n');
    await fs.writeFile(path.join(dir, 'BG5DRB.adi.journal.jsonl'), '{"op":"add"}\n');
    await fs.writeFile(path.join(dir, 'BG5DRB.meta.json'), '{}');

    const result = await new LegacyLogbookMaintenance(dir).runNow();

    expect(result.quarantinedArtifacts).toBe(4);
    expect(await fs.readFile(mainPath)).toEqual(original);
    expect(await fs.readdir(path.join(backupDirectory(dir, mainPath), 'legacy'))).toEqual([
      'BG5DRB.adi.bak.1',
      'BG5DRB.adi.journal.jsonl',
      'BG5DRB.journal.jsonl',
      'BG5DRB.meta.json',
    ]);
  });

  it('never creates a formal ADIF from orphan backups or journals', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'ORPHAN.adi');
    await fs.writeFile(`${mainPath}.bak.1`, healthyAdif('orphan-record', 'BG2OLD'));
    await fs.writeFile(path.join(dir, 'ORPHAN.journal.jsonl'), '{"op":"add"}\n');

    const result = await new LegacyLogbookMaintenance(dir).runNow();

    expect(result.quarantinedOrphans).toBe(1);
    await expect(fs.access(mainPath)).rejects.toThrow();
    expect(await fs.readdir(path.join(backupDirectory(dir, mainPath), 'legacy'))).toEqual([
      'ORPHAN.adi.bak.1',
      'ORPHAN.journal.jsonl',
    ]);
  });

  it('leaves every unknown top-level and legacy-directory entry untouched', async () => {
    const fixture = JSON.parse(await fs.readFile(
      new URL('./fixtures/legacy-directory-35.json', import.meta.url),
      'utf8',
    )) as {
      entries: Array<{
        name: string;
        type: 'file' | 'directory';
        role: 'main' | 'artifact' | 'unknown';
      }>;
    };
    const dir = await makeTempDir();
    for (const entry of fixture.entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.type === 'directory') await fs.mkdir(entryPath);
      else await fs.writeFile(entryPath, entry.role === 'main' ? encodeAdifHeader() : Buffer.alloc(0));
    }

    await new LegacyLogbookMaintenance(dir).runNow();

    for (const entry of fixture.entries.filter(candidate => candidate.role === 'unknown')) {
      await expect(fs.access(path.join(dir, entry.name))).resolves.toBeUndefined();
    }

    const mainPath = path.join(dir, 'BG5DRB.adi');
    const legacyDir = path.join(backupDirectory(dir, mainPath), 'legacy');
    await fs.writeFile(path.join(legacyDir, 'user-recovery-notes.txt'), 'keep');
    let now = Date.parse('2026-01-01T00:00:00Z') + LEGACY_RETENTION_MS + 1;
    await fs.writeFile(path.join(backupDirectory(dir, mainPath), 'latest.adi'), encodeAdifHeader());
    await fs.utimes(legacyDir, 0, 0);

    const result = await new LegacyLogbookMaintenance(dir, { now: () => now }).runNow();

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'LEGACY_RETENTION_UNKNOWN_CONTENT',
    }));
    await expect(fs.readFile(path.join(legacyDir, 'user-recovery-notes.txt'), 'utf8'))
      .resolves.toBe('keep');
  });

  it('deletes only obsolete fixed temps and preserves a single unrecoverable original', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BG2SAFE.adi');
    await fs.writeFile(mainPath, healthyAdif('safe', 'BG2SAFE'));
    const oldRoot = recoveryRoot(dir, mainPath);
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.writeFile(path.join(oldRoot, 'operation.lock'), 'obsolete');
    await fs.writeFile(path.join(oldRoot, 'rewrite.tmp'), 'obsolete');
    await fs.writeFile(path.join(oldRoot, 'last-good.adi'), healthyAdif('old', 'BG2OLD'));
    await fs.writeFile(path.join(oldRoot, 'unrecoverable-original.adi'), 'original broken bytes');
    await fs.writeFile(path.join(oldRoot, 'operator-notes.txt'), 'keep');

    const result = await new LegacyLogbookMaintenance(dir).runNow();
    const target = backupDirectory(dir, mainPath);

    expect(result.deletedObsoleteArtifacts).toBe(2);
    expect(result.preservedUnrecoverable).toBe(1);
    await expect(fs.readFile(path.join(target, 'unrecoverable-original.adi'), 'utf8'))
      .resolves.toBe('original broken bytes');
    await expect(fs.readFile(path.join(target, 'legacy', 'last-good.adi'))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(oldRoot, 'operator-notes.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('never overwrites a different unrecoverable original', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BG2CONFLICT.adi');
    await fs.writeFile(mainPath, healthyAdif('safe', 'BG2CF'));
    const oldRoot = recoveryRoot(dir, mainPath);
    const target = backupDirectory(dir, mainPath);
    await fs.mkdir(oldRoot, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(oldRoot, 'unrecoverable-original.adi'), 'second original');
    await fs.writeFile(path.join(target, 'unrecoverable-original.adi'), 'first original');

    const result = await new LegacyLogbookMaintenance(dir).runNow();

    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'UNRECOVERABLE_ORIGINAL_CONFLICT',
    }));
    await expect(fs.readFile(path.join(target, 'unrecoverable-original.adi'), 'utf8'))
      .resolves.toBe('first original');
    await expect(fs.readFile(path.join(oldRoot, 'unrecoverable-original.adi'), 'utf8'))
      .resolves.toBe('second original');
  });

  it('retains legacy for 30 healthy days and defers cleanup if main or latest is unsafe', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'RETAINED.adi');
    const target = backupDirectory(dir, mainPath);
    let now = Date.parse('2026-01-01T00:00:00Z');
    await fs.writeFile(mainPath, healthyAdif('main', 'BG4IAJ'));
    await fs.writeFile(path.join(dir, 'RETAINED.meta.json'), '{}');

    await new LegacyLogbookMaintenance(dir, { now: () => now }).runNow();
    const legacyDir = path.join(target, 'legacy');
    await fs.writeFile(path.join(target, 'latest.adi'), '<CALL:5>PART');

    now += LEGACY_RETENTION_MS + 1;
    await new LegacyLogbookMaintenance(dir, { now: () => now }).runNow();
    await expect(fs.access(legacyDir)).resolves.toBeUndefined();

    await fs.writeFile(path.join(target, 'latest.adi'), healthyAdif('backup', 'BG4IAJ'));
    now += LEGACY_RETENTION_MS - 1;
    await new LegacyLogbookMaintenance(dir, { now: () => now }).runNow();
    await expect(fs.access(legacyDir)).resolves.toBeUndefined();

    now += 2;
    const result = await new LegacyLogbookMaintenance(dir, { now: () => now }).runNow();
    expect(result.removedLegacyDirectories).toBe(1);
    await expect(fs.access(legacyDir)).rejects.toThrow();
    expect(await scanLogbookFileInline(mainPath)).toBeTruthy();
  });

  it('keeps the recovery file set bounded across 100 cleanup passes', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BOUNDED.adi');
    await fs.writeFile(mainPath, healthyAdif('main', 'BG5BOUND'));
    await fs.writeFile(path.join(dir, 'BOUNDED.journal.jsonl'), '{"legacy":true}\n');
    await fs.writeFile(path.join(dir, 'BOUNDED.meta.json'), '{}');
    const maintenance = new LegacyLogbookMaintenance(dir, {
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });

    for (let pass = 0; pass < 100; pass += 1) {
      await maintenance.runNow();
    }

    expect((await fs.readdir(dir)).sort()).toEqual(['.tx5dr-backups', 'BOUNDED.adi']);
    expect(await fs.readdir(path.join(backupDirectory(dir, mainPath), 'legacy'))).toEqual([
      'BOUNDED.journal.jsonl',
      'BOUNDED.meta.json',
    ]);
  });

  it('does not schedule work until start and unrefs and clears its timer', async () => {
    const dir = await makeTempDir();
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const maintenance = new LegacyLogbookMaintenance(dir);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    maintenance.start();
    maintenance.start();
    await maintenance.stop();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(timer.unref).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
  });
});
