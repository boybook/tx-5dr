import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { LogbookHealth } from '@tx5dr/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { AdifFileStore } from '../../persistence/AdifFileStore.js';
import { AdifBackupService, generationRevision, LogbookBackupError } from '../AdifBackupService.js';
import { AdifBackupWorker } from '../AdifBackupWorker.js';

function adifRecord(call: string, id = call): string {
  return `<CALL:${call.length}>${call}<APP_TX5DR_ID:${id.length}>${id}`
    + '<QSO_DATE:8>20260812<TIME_ON:6>010203<MODE:3>FT8<FREQ:9>14.074000<EOR>\n';
}

const HEALTHY: LogbookHealth = {
  state: 'healthy',
  readable: true,
  writable: true,
  issues: [],
  updatedAt: 1,
};

describe('AdifBackupService', () => {
  const tempDirectories: string[] = [];
  const stores: AdifFileStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map(store => store.close().catch(() => undefined)));
    await Promise.all(tempDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  async function createMain(content?: string): Promise<{
    directory: string;
    mainPath: string;
    original: string;
    store: AdifFileStore;
  }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-backup-service-'));
    tempDirectories.push(directory);
    const mainPath = path.join(directory, 'station.adi');
    const original = content ?? `<ADIF_VER:5>3.1.4<EOH>\n${adifRecord('BG5AA')}`;
    await writeFile(mainPath, original);
    const store = new AdifFileStore(mainPath);
    stores.push(store);
    await store.open();
    return { directory, mainPath, original, store };
  }

  it('keeps a fixed latest pair and reports any committed mutation as dirty', async () => {
    const { directory, mainPath, original, store } = await createMain();
    const backup = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await backup.initialize();
    await backup.createBackup();

    expect((await readdir(backup.backupDirectory)).sort()).toEqual(['latest.adi', 'latest.json']);
    expect(await readFile(backup.latestPath, 'utf8')).toBe(original);
    expect(backup.getStatus(HEALTHY, generationRevision(store.getCurrentGeneration()))).toMatchObject({
      dirty: false,
      pendingMutations: 0,
      latest: { recordCount: 1, opaqueRecordCount: 0 },
    });

    await store.commitAppend([Buffer.from(adifRecord('BG5AB'))], store.getCurrentGeneration());
    backup.markMutationCommitted();
    expect(backup.getStatus(HEALTHY, generationRevision(store.getCurrentGeneration()))).toMatchObject({
      dirty: true,
      pendingMutations: 1,
    });
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['station.adi', '.tx5dr-backups']));
  });

  it('refreshes a below-threshold dirty backup during graceful shutdown', async () => {
    const { mainPath, store } = await createMain();
    const backup = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await backup.initialize();
    await backup.createBackup();

    const appended = adifRecord('BG5AB');
    await store.commitAppend([Buffer.from(appended)], store.getCurrentGeneration());
    backup.markMutationCommitted();
    expect(backup.shouldRefresh()).toBe(false);

    await backup.flushWithin(10_000);

    expect(await readFile(backup.latestPath, 'utf8')).toBe(await readFile(mainPath, 'utf8'));
    expect(backup.pendingMutations).toBe(0);
  });

  it('recreates an unsafe or missing latest before allowing a rewrite', async () => {
    const { mainPath, store } = await createMain();
    const backup = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await backup.initialize();
    await backup.createBackup();
    await unlink(backup.latestPath);

    await backup.ensureBeforeRewrite();

    expect(await readFile(backup.latestPath, 'utf8')).toBe(await readFile(mainPath, 'utf8'));
    expect(backup.getStatus(HEALTHY, generationRevision(store.getCurrentGeneration())).latest)
      .toMatchObject({ recordCount: 1 });
  });

  it('repairs a stale manifest from the valid latest bytes without touching main', async () => {
    const { mainPath, original, store } = await createMain();
    const first = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await first.initialize();
    await first.createBackup();
    const replacement = `<ADIF_VER:5>3.1.4<EOH>\n${adifRecord('BG5ZZ')}${adifRecord('BG5ZY')}`;
    await writeFile(first.latestPath, replacement);

    const reopened = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await reopened.initialize();
    const manifest = JSON.parse(await readFile(reopened.manifestPath, 'utf8')) as {
      sha256: string;
      recordCount: number;
    };

    expect(manifest.sha256).toBe(createHash('sha256').update(replacement).digest('hex'));
    expect(manifest.recordCount).toBe(2);
    expect(await readFile(mainPath, 'utf8')).toBe(original);
  });

  it('backs up the fixed source EOF while a queued append continues', async () => {
    const { mainPath, original, store } = await createMain();
    let appendPromise: Promise<unknown> | undefined;
    let backup!: AdifBackupService;
    class ConcurrentAppendWorker extends AdifBackupWorker {
      override copyAndScan(
        sourcePath: string,
        targetPath: string,
        onProgress?: Parameters<AdifBackupWorker['copyAndScan']>[2],
        onSourceOpened?: Parameters<AdifBackupWorker['copyAndScan']>[3],
      ) {
        return super.copyAndScan(sourcePath, targetPath, onProgress, () => {
          onSourceOpened?.();
          appendPromise = store
            .commitAppend([Buffer.from(adifRecord('BG5AB'))], store.getCurrentGeneration())
            .then(() => backup.markMutationCommitted());
        });
      }
    }
    backup = new AdifBackupService('logbook-BG5AA', mainPath, store, {
      worker: new ConcurrentAppendWorker(),
    });
    await backup.initialize();

    await backup.createBackup();
    await appendPromise;

    expect(await readFile(backup.latestPath, 'utf8')).toBe(original);
    expect(await readFile(mainPath, 'utf8')).toBe(original + adifRecord('BG5AB'));
    expect(backup.pendingMutations).toBe(1);
    expect(backup.getStatus(HEALTHY, generationRevision(store.getCurrentGeneration())).dirty).toBe(true);
  });

  it('restores latest explicitly, preserves pre-restore bytes, and consumes the token once', async () => {
    const { mainPath, original, store } = await createMain();
    const backup = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await backup.initialize();
    await backup.createBackup();
    const appended = adifRecord('BG5AB');
    await store.commitAppend([Buffer.from(appended)], store.getCurrentGeneration());
    backup.markMutationCommitted();
    const revision = generationRevision(store.getCurrentGeneration());
    const preflight = await backup.prepareRestore(
      'admin-token',
      revision,
      HEALTHY,
      revision,
      store.getCurrentGeneration(),
    );
    expect(preflight.estimatedLoss).toBe(1);

    let finalAuthorizationChecks = 0;
    await backup.restore({
      tokenId: 'admin-token',
      preflightToken: preflight.preflightToken,
      expectedRevision: revision,
      currentRevision: revision,
      beforeReplace: async () => { finalAuthorizationChecks += 1; },
    });

    expect(finalAuthorizationChecks).toBe(1);
    expect(await readFile(mainPath, 'utf8')).toBe(original);
    expect(await readFile(backup.preRestorePath, 'utf8')).toBe(original + appended);
    await expect(backup.restore({
      tokenId: 'admin-token',
      preflightToken: preflight.preflightToken,
      expectedRevision: revision,
      currentRevision: revision,
    })).rejects.toBeInstanceOf(LogbookBackupError);
  }, 15_000);

  it('prepares a high-risk restore when the formal main file is missing', async () => {
    const { mainPath, store } = await createMain();
    const backup = new AdifBackupService('logbook-BG5AA', mainPath, store);
    await backup.initialize();
    await backup.createBackup();
    await unlink(mainPath);

    const preflight = await backup.prepareRestore(
      'admin-token',
      'unavailable',
      { ...HEALTHY, state: 'unavailable', readable: false, writable: false },
      'unavailable',
      undefined,
    );

    expect(preflight.main).toMatchObject({ size: 0, recordCount: 0, incompleteTail: false });
    expect(preflight.backup.recordCount).toBe(1);
    expect(preflight.highRisk).toBe(true);

    await backup.restore({
      tokenId: 'admin-token',
      preflightToken: preflight.preflightToken,
      expectedRevision: 'unavailable',
      currentRevision: 'unavailable',
    });
    expect(await readFile(mainPath, 'utf8')).toContain('<CALL:5>BG5AA');
  });

  it('never exposes a filesystem error message through backup status', async () => {
    const { mainPath, store } = await createMain();
    const secretPath = `/private/recovery/${path.basename(mainPath)}`;
    class FailingBackupWorker extends AdifBackupWorker {
      override copyAndScan(): ReturnType<AdifBackupWorker['copyAndScan']> {
        return Promise.reject(Object.assign(
          new Error(`ENOENT: cannot open '${secretPath}', bearer secret-jwt-token`),
          { code: 'ENOENT' },
        ));
      }
    }
    const backup = new AdifBackupService('logbook-BG5AA', mainPath, store, {
      worker: new FailingBackupWorker(),
    });
    await backup.initialize();
    await expect(backup.createBackup()).rejects.toBeInstanceOf(LogbookBackupError);

    const serialized = JSON.stringify(backup.getStatus(
      HEALTHY,
      generationRevision(store.getCurrentGeneration()),
      { admin: false },
    ));
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain('secret-jwt-token');
    expect(serialized).toContain('The logbook backup operation failed');
  });
});
