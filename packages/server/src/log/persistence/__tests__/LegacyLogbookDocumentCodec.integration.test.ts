import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { QSORecord } from '@tx5dr/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  decodeAdifRecord,
  encodeAdifHeader,
  encodeAdifRecord,
  scanAdifBuffer,
} from '../AdifCodec.js';
import { AdifFileStore } from '../AdifFileStore.js';
import { LegacyLogbookDocumentCodec } from '../LegacyLogbookDocumentCodec.js';
import { NodeLegacyLogbookFileStore } from '../LegacyLogbookFileStore.js';
import {
  LegacyLogbookMigrator,
  legacyMigrationPaths,
} from '../LegacyLogbookMigrator.js';
import { scanLogbookFileInline } from '../LogbookScanCore.js';
import {
  inventoryLegacyLogbookArtifacts,
  inventoryOrphanLegacyLogbookArtifacts,
} from '../legacyLogbookArtifacts.js';

const START_TIME = Date.parse('2026-08-10T01:02:03Z');
const LEGACY_FALLBACK_ID = 'K1ABC_20260810_010203_N0CALL';
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-adif-integration-'));
  tempDirs.push(dir);
  return dir;
}

function field(name: string, value: string): string {
  return `<${name}:${Buffer.byteLength(value, 'utf8')}>${value}`;
}

function externalRecord(comment = 'external', callsign = 'K1ABC'): Buffer {
  return Buffer.from([
    field('CALL', callsign),
    field('QSO_DATE', '20260810'),
    field('TIME_ON', '010203'),
    field('MODE', 'FT8'),
    field('FREQ', '14.074000'),
    field('OPERATOR', 'N0CALL'),
    field('COMMENT', comment),
    '<EOR>\n',
  ].join(''), 'utf8');
}

function qso(id: string, overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id,
    callsign: 'K1ABC',
    frequency: 14_074_000,
    mode: 'FT8',
    startTime: START_TIME,
    messageHistory: [],
    ...overrides,
  };
}

function journalLine(
  txId: string,
  operation: 'add' | 'update' | 'delete',
  payload: Record<string, unknown>,
): string {
  const withoutChecksum = {
    txId,
    timestamp: Date.parse('2026-08-10T02:00:00Z'),
    operation,
    payload,
  };
  const checksum = createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex');
  return `${JSON.stringify({ ...withoutChecksum, checksum })}\n`;
}

async function migrate(mainPath: string, store = new NodeLegacyLogbookFileStore()) {
  return new LegacyLogbookMigrator(new LegacyLogbookDocumentCodec(), store).migrate(mainPath);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('legacy 35-entry directory fixture', () => {
  it('inventories only exact generated names and leaves unrelated entries untouched', async () => {
    const fixture = JSON.parse(await fs.readFile(
      new URL('./fixtures/legacy-directory-35.json', import.meta.url),
      'utf8',
    )) as {
      entries: Array<{
        name: string;
        type: 'file' | 'directory';
        role: 'main' | 'artifact' | 'unknown';
        owner?: string;
      }>;
    };
    expect(fixture.entries).toHaveLength(35);

    const dir = await makeTempDir();
    for (const entry of fixture.entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.type === 'directory') await fs.mkdir(entryPath);
      else await fs.writeFile(entryPath, entry.role === 'main' ? encodeAdifHeader() : Buffer.alloc(0));
    }

    const mainPath = path.join(dir, 'BG5DRB.adi');
    const inventory = await inventoryLegacyLogbookArtifacts(mainPath);
    const expectedMainArtifacts = fixture.entries
      .filter(entry => entry.role === 'artifact' && entry.owner === 'BG5DRB.adi')
      .map(entry => entry.name)
      .sort();
    expect(inventory.artifacts.map(artifact => artifact.name)).toEqual(expectedMainArtifacts);

    const orphanGroups = await inventoryOrphanLegacyLogbookArtifacts(dir);
    expect(orphanGroups).toHaveLength(1);
    expect(path.basename(orphanGroups[0]!.mainPath)).toBe('ORPHAN.adi');
    expect(orphanGroups[0]!.artifacts.map(artifact => artifact.name)).toEqual([
      'ORPHAN.adi.bak.1',
      'ORPHAN.journal.jsonl',
    ]);

    for (const entry of fixture.entries.filter(candidate => candidate.role === 'unknown')) {
      await expect(fs.access(path.join(dir, entry.name))).resolves.toBeUndefined();
    }
  });
});

describe('LegacyLogbookDocumentCodec ADIF migration integration', () => {
  it('deletes a baseline external record through its legacy fallback id', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BASELINE-DELETE.adi');
    await fs.writeFile(mainPath, Buffer.concat([encodeAdifHeader(), externalRecord()]));
    await fs.writeFile(
      path.join(dir, 'BASELINE-DELETE.journal.jsonl'),
      journalLine('delete-external', 'delete', { id: LEGACY_FALLBACK_ID }),
      'utf8',
    );

    const result = await migrate(mainPath);

    expect(result).toMatchObject({ committed: true, unappliedOperations: 0 });
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(0);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_DELETE_TARGET_AMBIGUOUS')).toBe(false);
  });

  it('keeps an already-checkpointed raw add associated through a following update and delete', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'RAW-SEQUENCE.adi');
    const raw = externalRecord();
    const legacyId = 'K1ABC_1770000000000_import';
    await fs.writeFile(mainPath, Buffer.concat([encodeAdifHeader(), raw]));
    await fs.writeFile(
      path.join(dir, 'RAW-SEQUENCE.journal.jsonl'),
      [
        journalLine('raw-add', 'add', {
          record: qso(legacyId),
          rawLine: raw.toString('utf8'),
        }),
        journalLine('raw-update', 'update', {
          record: qso(legacyId, { comment: 'updated after import' }),
        }),
        journalLine('raw-delete', 'delete', { id: legacyId }),
      ].join(''),
      'utf8',
    );

    const result = await migrate(mainPath);

    expect(result).toMatchObject({ appliedTransactions: 3, unappliedOperations: 0 });
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(0);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOURNAL_ADD_ALREADY_PRESENT_SKIPPED' }),
    ]));
    expect(result.issues.map(issue => issue.code)).not.toEqual(expect.arrayContaining([
      'JOURNAL_UPDATE_TARGET_MISSING',
      'JOURNAL_DELETE_TARGET_MISSING',
    ]));
  });

  it.each([
    {
      name: 'duplicate legacy business keys',
      records: () => [externalRecord('first'), externalRecord('second')],
      deleteId: LEGACY_FALLBACK_ID,
    },
    {
      name: 'byte-identical duplicate raw records',
      records: () => {
        const raw = externalRecord('same bytes');
        return [raw, raw];
      },
      deleteId: LEGACY_FALLBACK_ID,
    },
    {
      name: 'duplicate explicit TX-5DR ids',
      records: () => [
        encodeAdifRecord(qso('duplicate-id', { comment: 'first' })),
        encodeAdifRecord(qso('duplicate-id', { comment: 'second' })),
      ],
      deleteId: 'duplicate-id',
    },
  ])('does not guess a delete target for $name', async ({ records, deleteId }) => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'AMBIGUOUS.adi');
    const original = Buffer.concat([encodeAdifHeader(), ...records()]);
    await fs.writeFile(mainPath, original);
    await fs.writeFile(
      path.join(dir, 'AMBIGUOUS.journal.jsonl'),
      journalLine('ambiguous-delete', 'delete', { id: deleteId }),
      'utf8',
    );

    const result = await migrate(mainPath);

    expect(result).toMatchObject({ committed: false, unappliedOperations: 1 });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOURNAL_DELETE_TARGET_AMBIGUOUS' }),
    ]));
    expect(await fs.readFile(mainPath)).toEqual(original);
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(2);
  });

  it('recognizes an already-checkpointed raw add without rewriting and preserves the final recovery point', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'RAW-IDEMPOTENT.adi');
    const raw = externalRecord();
    const original = Buffer.concat([encodeAdifHeader(), raw]);
    const importedId = 'K1ABC_1770000000000_import';
    await fs.writeFile(mainPath, original);
    await fs.writeFile(
      path.join(dir, 'RAW-IDEMPOTENT.journal.jsonl'),
      journalLine('already-checkpointed-add', 'add', {
        record: qso(importedId, { dxccId: 291 }),
        rawLine: raw.toString('utf8'),
      }),
      'utf8',
    );

    const result = await migrate(mainPath);

    expect(result).toMatchObject({ committed: false, appliedTransactions: 1, unappliedOperations: 0 });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JOURNAL_ADD_ALREADY_PRESENT_SKIPPED' }),
    ]));
    expect(await fs.readFile(mainPath)).toEqual(original);
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(1);
    await expect(fs.readFile(legacyMigrationPaths(mainPath).lastGoodPath)).resolves.toEqual(original);
    await expect(fs.access(path.join(result.recoveryPath!, 'manifest.json'))).resolves.toBeUndefined();
  });

  it('refreshes last-good after a commit-before-refresh crash before quarantining the journal', async () => {
    class FailFinalLastGoodOnceStore extends NodeLegacyLogbookFileStore {
      private lastGoodCopies = 0;

      override async copyFileDurable(sourcePath: string, targetPath: string): Promise<void> {
        if (targetPath.endsWith(`${path.sep}last-good.tmp`)) {
          this.lastGoodCopies += 1;
          if (this.lastGoodCopies === 2) {
            throw new Error('injected post-commit last-good failure');
          }
        }
        await super.copyFileDurable(sourcePath, targetPath);
      }
    }

    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'LAST-GOOD-RETRY.adi');
    const journalPath = path.join(dir, 'LAST-GOOD-RETRY.journal.jsonl');
    const before = qso('kept', { comment: 'before migration' });
    const after = qso('kept', { comment: 'after migration' });
    const deleted = qso('deleted', { callsign: 'K2DELETE' });
    await fs.writeFile(mainPath, Buffer.concat([
      encodeAdifHeader(),
      encodeAdifRecord(before),
      encodeAdifRecord(deleted),
    ]));
    await fs.utimes(mainPath, new Date(START_TIME), new Date(START_TIME));
    await fs.writeFile(journalPath, [
      journalLine('update-kept', 'update', { record: after }),
      journalLine('delete-old', 'delete', { id: deleted.id }),
    ].join(''), 'utf8');

    const store = new FailFinalLastGoodOnceStore();
    const first = await new LegacyLogbookMigrator(
      new LegacyLogbookDocumentCodec(),
      store,
    ).migrate(mainPath);

    expect(first).toMatchObject({ status: 'FAILED', committed: true });
    expect(first.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LAST_GOOD_REFRESH_FAILED' }),
    ]));
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(1);
    expect(scanAdifBuffer(
      await fs.readFile(legacyMigrationPaths(mainPath).lastGoodPath),
    ).records).toHaveLength(2);
    await expect(fs.access(journalPath)).resolves.toBeUndefined();

    // A fresh migrator simulates restart: candidate already equals main, while
    // the fixed last-good still points at the pre-migration snapshot.
    const second = await new LegacyLogbookMigrator(
      new LegacyLogbookDocumentCodec(),
      store,
    ).migrate(mainPath);
    const migrated = await fs.readFile(mainPath);

    expect(second).toMatchObject({ committed: false });
    expect(second.status).not.toBe('FAILED');
    await expect(fs.readFile(legacyMigrationPaths(mainPath).lastGoodPath)).resolves.toEqual(migrated);
    await expect(fs.access(journalPath)).rejects.toThrow();

    await fs.writeFile(mainPath, 'not recoverable as ADIF', 'utf8');
    const adifStore = new AdifFileStore(mainPath, {
      scanner: { scan: scanLogbookFileInline },
    });
    const opened = await adifStore.open();
    const recovered = await fs.readFile(mainPath);
    const recoveredScan = scanAdifBuffer(recovered);
    const recoveredRecords = recoveredScan.records
      .map(record => decodeAdifRecord(record))
      .filter((record): record is QSORecord => record !== undefined);

    expect(opened).toMatchObject({ status: 'degraded', recoveredFrom: 'last-good.adi' });
    expect(recoveredRecords).toHaveLength(1);
    expect(recoveredRecords[0]).toMatchObject({ id: after.id, comment: after.comment });
    expect(recoveredRecords.map(record => record.id)).not.toContain(deleted.id);
    await adifStore.close();
  });

  it('retries after commit-before-cleanup without duplicating the preserved raw record', async () => {
    class FailManifestOnceStore extends NodeLegacyLogbookFileStore {
      failManifest = true;

      override async writeFileDurable(filePath: string, data: Buffer, mode?: number): Promise<void> {
        if (this.failManifest && filePath.endsWith(`${path.sep}manifest.json.tmp`)) {
          this.failManifest = false;
          throw new Error('injected cleanup manifest failure');
        }
        await super.writeFileDurable(filePath, data, mode);
      }
    }

    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'RETRY.adi');
    const journalPath = path.join(dir, 'RETRY.journal.jsonl');
    const raw = externalRecord();
    const importedId = 'K1ABC_1770000000000_import';
    await fs.writeFile(mainPath, encodeAdifHeader());
    await fs.writeFile(
      journalPath,
      journalLine('retry-add', 'add', {
        record: qso(importedId),
        rawLine: raw.toString('utf8'),
      }),
      'utf8',
    );
    const store = new FailManifestOnceStore();
    const migrator = new LegacyLogbookMigrator(new LegacyLogbookDocumentCodec(), store);

    const first = await migrator.migrate(mainPath);
    expect(first).toMatchObject({ status: 'FAILED', committed: true });
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(1);
    await expect(fs.access(journalPath)).resolves.toBeUndefined();

    const second = await migrator.migrate(mainPath);

    expect(second.status).not.toBe('FAILED');
    expect(second.unappliedOperations).toBe(0);
    expect(scanAdifBuffer(await fs.readFile(mainPath)).records).toHaveLength(1);
    await expect(fs.access(journalPath)).rejects.toThrow();
  });
});
