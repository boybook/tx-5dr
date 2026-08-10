import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { QSORecord } from '@tx5dr/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeAdifHeader, encodeAdifRecord, scanAdifBuffer } from '../AdifCodec.js';
import { LegacyLogbookDocumentCodec } from '../LegacyLogbookDocumentCodec.js';
import {
  LegacyLogbookMaintenance,
  type LegacyLogbookMaintenanceMigrator,
} from '../LegacyLogbookMaintenance.js';
import { NodeLegacyLogbookFileStore } from '../LegacyLogbookFileStore.js';
import { LegacyLogbookMigrator, type LegacyMigrationResult } from '../LegacyLogbookMigrator.js';
import {
  LEGACY_RECOVERY_RETENTION_MS,
  LegacyLogbookRecoveryManager,
} from '../LegacyLogbookRecovery.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tx5dr-logbook-maintenance-'));
  tempDirs.push(dir);
  return dir;
}

function qso(id: string, callsign: string): QSORecord {
  return {
    id,
    callsign,
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: Date.parse('2026-08-10T01:02:03Z'),
    messageHistory: [],
  };
}

function healthyAdif(id: string, callsign: string): Buffer {
  return Buffer.concat([encodeAdifHeader(), encodeAdifRecord(qso(id, callsign))]);
}

function notNeeded(mainPath: string): LegacyMigrationResult {
  return {
    status: 'NOT_NEEDED',
    mainPath,
    committed: false,
    appliedTransactions: 0,
    skippedTransactions: 0,
    unappliedOperations: 0,
    issues: [],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('LegacyLogbookMaintenance', () => {
  it('migrates an orphan backup into a formal ADIF without registering a provider', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'ORPHAN.adi');
    const backupPath = `${mainPath}.bak.1`;
    await fs.writeFile(backupPath, healthyAdif('orphan-qso', 'BG5DR'));

    const fileStore = new NodeLegacyLogbookFileStore();
    const migrator = new LegacyLogbookMigrator(new LegacyLogbookDocumentCodec(), fileStore);
    const result = await new LegacyLogbookMaintenance(dir, { fileStore, migrator }).runNow();

    expect(result.discoveredPaths).toBe(1);
    expect(result.processedPaths).toBe(1);
    expect(result.migratedOrphans).toBe(1);
    expect(result.issues.some(issue => issue.code === 'LEGACY_MIGRATION_FAILED')).toBe(false);
    const main = await fs.readFile(mainPath);
    expect(scanAdifBuffer(main).records).toHaveLength(1);
    await expect(fs.access(backupPath)).rejects.toThrow();
    const recoveryBase = path.join(dir, '.tx5dr-recovery');
    const recoveryRoots = await fs.readdir(recoveryBase);
    expect(recoveryRoots).toHaveLength(1);
    await expect(fs.access(path.join(recoveryBase, recoveryRoots[0]!, 'legacy', path.basename(backupPath))))
      .resolves.toBeUndefined();
  });

  it('removes an expired recovery set only after worker-backed healthy open proof', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'RETAINED.adi');
    await fs.writeFile(mainPath, healthyAdif('retained-qso', 'BG4IAJ'));
    await fs.writeFile(path.join(dir, 'RETAINED.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const fileStore = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(fileStore, () => now);
    const migrator = new LegacyLogbookMigrator(
      new LegacyLogbookDocumentCodec(),
      fileStore,
      recovery,
    );
    const migration = await migrator.migrate(mainPath);
    const manifestPath = path.join(migration.recoveryPath!, 'manifest.json');
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();

    now += LEGACY_RECOVERY_RETENTION_MS + 1;
    const result = await new LegacyLogbookMaintenance(dir, { fileStore, migrator }).runNow();

    expect(result.removedRecoverySets).toBe(1);
    await expect(fs.access(manifestPath)).rejects.toThrow();
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(1);
  });

  it('isolates one path failure and continues maintaining the remaining logbooks', async () => {
    const dir = await makeTempDir();
    const failedPath = path.join(dir, 'A.adi');
    const healthyPath = path.join(dir, 'B.adi');
    await fs.writeFile(failedPath, healthyAdif('a', 'BG1AAA'));
    await fs.writeFile(healthyPath, healthyAdif('b', 'BG2BBB'));
    const opened: string[] = [];
    const migrator: LegacyLogbookMaintenanceMigrator = {
      async migrate(mainPath) {
        if (mainPath === failedPath) throw new Error('injected migration failure');
        return notNeeded(mainPath);
      },
      async cleanupExpired() {
        return { removedRecoverySets: 0, issues: [] };
      },
    };
    const maintenance = new LegacyLogbookMaintenance(dir, {
      migrator,
      storeFactory: mainPath => ({
        async open() {
          opened.push(mainPath);
          return { status: 'ready', issues: [] };
        },
        async close() {},
      }),
    });

    const result = await maintenance.runNow();

    expect(result.processedPaths).toBe(2);
    expect(opened).toEqual([healthyPath]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'migration',
        code: 'LEGACY_MIGRATION_FAILED',
        path: failedPath,
      }),
    ]));
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
