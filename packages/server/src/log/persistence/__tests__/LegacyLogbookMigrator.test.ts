import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LegacyLogbookMigrator,
  legacyMigrationPaths,
  type LegacyDecodedSnapshot,
  type LegacyLogbookMigrationCodec,
} from '../LegacyLogbookMigrator.js';
import {
  LEGACY_RECOVERY_RETENTION_MS,
  LegacyLogbookRecoveryManager,
  legacyLogbookPathHash,
} from '../LegacyLogbookRecovery.js';
import { NodeLegacyLogbookFileStore } from '../LegacyLogbookFileStore.js';
import {
  inventoryLegacyLogbookArtifacts,
  inventoryOrphanLegacyLogbookArtifacts,
} from '../legacyLogbookArtifacts.js';

interface TestRecord extends Record<string, unknown> {
  id: string;
  value: string;
}

interface TestDocument {
  records: TestRecord[];
  raw: string[];
}

const codec: LegacyLogbookMigrationCodec<TestDocument, TestRecord> = {
  async decodeSnapshot(data): Promise<LegacyDecodedSnapshot<TestDocument>> {
    if (data.toString('utf8') === 'INVALID') {
      return { health: 'invalid', document: { records: [], raw: [] }, recordCount: 0 };
    }
    const parsed = JSON.parse(data.toString('utf8')) as TestDocument & {
      health?: LegacyDecodedSnapshot<TestDocument>['health'];
      trailingPartial?: boolean;
    };
    return {
      health: parsed.health ?? 'healthy',
      document: { records: parsed.records, raw: parsed.raw },
      recordCount: parsed.records.length,
      trailingPartial: parsed.trailingPartial,
    };
  },
  createEmptyDocument: () => ({ records: [], raw: [] }),
  cloneDocument: document => structuredClone(document),
  getRecordMatch(document, id) {
    const count = document.records.filter(record => record.id === id).length;
    return count === 0 ? 'missing' : count === 1 ? 'unique' : 'ambiguous';
  },
  associateRecordByRaw() {
    return 'missing';
  },
  isRecordEquivalent(document, id, candidate) {
    const matches = document.records.filter(record => record.id === id);
    return matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(candidate);
  },
  replaceRecordInPlace(document, id, record) {
    const index = document.records.findIndex(candidate => candidate.id === id);
    if (index < 0) return false;
    document.records[index] = structuredClone(record);
    return true;
  },
  appendRecord(document, record) {
    document.records.push(structuredClone(record));
  },
  removeRecord(document, id) {
    const previous = document.records.length;
    document.records = document.records.filter(record => record.id !== id);
    return previous - document.records.length;
  },
  containsRaw: (document, rawLine) => document.raw.includes(rawLine),
  appendRaw(document, rawLine) {
    document.raw.push(rawLine);
  },
  async encodeDocument(document) {
    return Buffer.from(JSON.stringify(document), 'utf8');
  },
  async validateCandidate(data, expectedDocument) {
    try {
      const parsed = JSON.parse(data.toString('utf8')) as TestDocument;
      return {
        valid: JSON.stringify(parsed) === JSON.stringify(expectedDocument),
        reason: 'Candidate differs from expected document',
      };
    } catch (error) {
      return { valid: false, reason: (error as Error).message };
    }
  },
};

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-migration-'));
  tempDirs.push(dir);
  return dir;
}

async function writeDocument(filePath: string, document: TestDocument): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(document), 'utf8');
}

function journalLine(
  txId: string,
  timestamp: number,
  operation: 'add' | 'update' | 'delete' | 'import',
  payload: Record<string, unknown>,
): string {
  const withoutChecksum = { txId, timestamp, operation, payload };
  const checksum = createHash('sha256').update(JSON.stringify(withoutChecksum)).digest('hex');
  return `${JSON.stringify({ ...withoutChecksum, checksum })}\n`;
}

function record(id: string, value: string): TestRecord {
  return { id, value };
}

async function readDocument(filePath: string): Promise<TestDocument> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as TestDocument;
}

async function retentionProof(
  filePath: string,
  recordCount: number,
  options: { complete?: boolean; recoveredDuringOpen?: boolean } = {},
) {
  const [stat, data] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
  return {
    complete: options.complete ?? true,
    recoveredDuringOpen: options.recoveredDuringOpen ?? false,
    recordCount,
    generation: {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: createHash('sha256').update(data).digest('hex'),
      dev: stat.dev,
      ino: stat.ino,
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('legacy logbook artifact inventory', () => {
  it('matches only exact generated basenames and reports orphan groups', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BG5DRB.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    const recognized = [
      'BG5DRB.adi.bak.1',
      'BG5DRB.adi.tmp-10-1000-1',
      'BG5DRB.journal.jsonl',
      'BG5DRB.journal.jsonl.2026-05-10T05-18-01-661Z',
      'BG5DRB.journal.jsonl.2026-05-10T05-18-01-661Z.corrupt-2026-05-10T06-00-00-000Z.tmp-10-1001-2',
      'BG5DRB.adi.journal.jsonl.corrupt-2026-05-10T05-18-01-661Z',
      'BG5DRB.meta.json.bak.2',
      'BG5DRB.adi.meta.json',
    ];
    for (const name of recognized) await fs.writeFile(path.join(dir, name), '', 'utf8');
    await fs.writeFile(path.join(dir, 'BG5DRB.adi.bak.4'), 'unknown', 'utf8');
    await fs.writeFile(path.join(dir, 'BG5DRB.journal.jsonl.notes'), 'unknown', 'utf8');
    await fs.writeFile(path.join(dir, 'BG5DRB.journal.jsonl.tmp-1-2-3.tmp-4-5-6'), 'unknown', 'utf8');
    await fs.writeFile(
      path.join(dir, 'BG5DRB.journal.jsonl.2026-05-10T05-18-01-661Z.tmp-1-2-3'),
      'unknown',
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'ORPHAN.journal.jsonl'), '', 'utf8');

    const inventory = await inventoryLegacyLogbookArtifacts(mainPath);
    expect(inventory.artifacts.map(artifact => artifact.name)).toEqual([...recognized].sort());

    const orphans = await inventoryOrphanLegacyLogbookArtifacts(dir);
    expect(orphans).toHaveLength(1);
    expect(path.basename(orphans[0].mainPath)).toBe('ORPHAN.adi');
    expect(orphans[0].artifacts.map(artifact => artifact.name)).toEqual(['ORPHAN.journal.jsonl']);
  });
});

describe('LegacyLogbookMigrator', () => {
  it('keeps a healthy empty main authoritative over a stale non-empty backup', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'EMPTY-MAIN.adi');
    const backupPath = `${mainPath}.bak.1`;
    await writeDocument(mainPath, { records: [], raw: [] });
    await writeDocument(backupPath, { records: [record('deleted', 'stale backup')], raw: [] });

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.baselinePath).toBe(mainPath);
    expect((await readDocument(mainPath)).records).toEqual([]);
    await expect(fs.access(legacyMigrationPaths(mainPath).lastGoodPath)).rejects.toThrow();
  });

  it('keeps a salvageable main authoritative over a larger healthy backup', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'SALVAGEABLE-MAIN.adi');
    const backupPath = `${mainPath}.bak.1`;
    await writeDocument(mainPath, {
      records: [record('newer', 'kept from main')],
      raw: [],
      health: 'salvageable',
      trailingPartial: true,
    } as TestDocument);
    await writeDocument(backupPath, {
      records: [record('old-a', 'stale'), record('old-b', 'stale')],
      raw: [],
    });

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.baselinePath).toBe(mainPath);
    expect((await readDocument(mainPath)).records).toEqual([record('newer', 'kept from main')]);
  });

  it('prefers the newest valid empty fallback over an older non-empty snapshot', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'EMPTY-FALLBACK.adi');
    const olderBackupPath = `${mainPath}.bak.1`;
    const newerTempPath = `${mainPath}.tmp-10-1000-1`;
    await fs.writeFile(mainPath, 'INVALID', 'utf8');
    await writeDocument(olderBackupPath, {
      records: [record('deleted', 'must not be resurrected')],
      raw: [],
    });
    await writeDocument(newerTempPath, { records: [], raw: [] });
    await fs.utimes(
      olderBackupPath,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    await fs.utimes(
      newerTempPath,
      new Date('2026-01-02T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z'),
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.status).toBe('RECOVERED');
    expect(result.baselinePath).toBe(newerTempPath);
    expect(await readDocument(mainPath)).toEqual({ records: [], raw: [] });
  });

  it('preserves the formal ADIF permission mode when migration rewrites it', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'MODE.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.chmod(mainPath, 0o640);
    const baseline = Date.parse('2026-01-01T00:00:00Z');
    await fs.utimes(mainPath, new Date(baseline), new Date(baseline));
    await fs.writeFile(
      path.join(dir, 'MODE.journal.jsonl'),
      journalLine('mode-add', baseline + 1, 'add', { record: record('saved', 'yes') }),
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.status).toBe('MIGRATED');
    expect((await fs.stat(mainPath)).mode & 0o777).toBe(0o640);
  });

  it('replays journal transactions in physical line order even when timestamps run backwards', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'LINE-ORDER.adi');
    const baselineTime = Date.parse('2026-03-01T00:00:00Z');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.utimes(mainPath, new Date(baselineTime), new Date(baselineTime));
    await fs.writeFile(
      path.join(dir, 'LINE-ORDER.journal.jsonl'),
      [
        journalLine('physical-add', baselineTime + 2, 'add', { record: record('ordered', 'value') }),
        journalLine('physical-delete', baselineTime + 1, 'delete', { id: 'ordered' }),
      ].join(''),
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.appliedTransactions).toBe(2);
    expect(result.unappliedOperations).toBe(0);
    expect((await readDocument(mainPath)).records).toEqual([]);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_DELETE_TARGET_MISSING')).toBe(false);
  });

  it('replays only the current journal over a healthy main and never resurrects an archived add', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BG5DRB.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    const baselineTime = new Date('2026-08-09T02:30:00Z');
    await fs.utimes(mainPath, baselineTime, baselineTime);
    await fs.writeFile(
      path.join(dir, 'BG5DRB.journal.jsonl.2026-08-09T02-02-15-374Z'),
      journalLine('archived-add', Date.parse('2026-08-09T02:00:00Z'), 'add', { record: record('deleted', 'old') }),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'BG5DRB.journal.jsonl'),
      [
        journalLine('current-stale', Date.parse('2026-08-09T02:20:00Z'), 'add', { record: record('stale-current', 'old') }),
        journalLine('current-add', Date.parse('2026-08-09T03:00:00Z'), 'add', { record: record('current', 'new') }),
      ].join(''),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'BG5DRB.adi.journal.jsonl'),
      journalLine('old-current-stale', Date.parse('2026-08-09T02:15:00Z'), 'add', { record: record('stale', 'old') }),
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'BG5DRB.adi.journal.jsonl.corrupt-2026-08-09T03-31-00-000Z'),
      journalLine('old-current-later', Date.parse('2026-08-09T03:30:00Z'), 'add', { record: record('old-later', 'recovered') }),
      'utf8',
    );
    await fs.writeFile(path.join(dir, 'BG5DRB.meta.json'), '{}', 'utf8');
    await fs.writeFile(path.join(dir, 'do-not-touch.txt'), 'user data', 'utf8');

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.status).toBe('RECOVERED');
    expect(result.committed).toBe(true);
    // The final-generation current journal is the authoritative uncheckpointed
    // stream. Only the stale old-generation transaction is skipped here.
    expect(result.skippedTransactions).toBe(1);
    expect((await readDocument(mainPath)).records).toEqual([
      record('old-later', 'recovered'),
      record('stale-current', 'old'),
      record('current', 'new'),
    ]);
    expect(await fs.readFile(path.join(dir, 'do-not-touch.txt'), 'utf8')).toBe('user data');
    expect(await fs.readdir(dir)).not.toContain('BG5DRB.journal.jsonl');
    const recoveryFiles = await fs.readdir(path.join(result.recoveryPath!, 'legacy'));
    expect(recoveryFiles).toContain('BG5DRB.journal.jsonl.2026-08-09T02-02-15-374Z');
    expect(await readDocument(path.join(result.recoveryPath!, 'last-good.adi'))).toEqual({
      records: [
        record('old-later', 'recovered'),
        record('stale-current', 'old'),
        record('current', 'new'),
      ],
      raw: [],
    });
  });

  it('keeps add-at-tail and update-in-place semantics while globally deduplicating txIds', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'N0CALL.adi');
    await writeDocument(mainPath, { records: [record('a', 'A'), record('b', 'B')], raw: [] });
    const baselineTime = Date.parse('2026-01-01T00:00:00Z');
    await fs.utimes(mainPath, new Date(baselineTime), new Date(baselineTime));
    const add = journalLine('add-c', baselineTime + 10, 'add', { record: record('c', 'C') });
    const journal = [
      journalLine('add-a-already-checkpointed', baselineTime + 5, 'add', { record: record('a', 'A') }),
      add,
      journalLine('update-a', baselineTime + 11, 'update', { record: record('a', 'A2') }),
      journalLine('delete-b', baselineTime + 12, 'delete', { id: 'b' }),
    ].join('');
    await fs.writeFile(path.join(dir, 'N0CALL.journal.jsonl'), journal, 'utf8');
    await fs.writeFile(
      path.join(dir, 'N0CALL.journal.jsonl.corrupt-2026-08-09T03-00-00-000Z'),
      add,
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.appliedTransactions).toBe(4);
    expect(result.unappliedOperations).toBe(0);
    expect((await readDocument(mainPath)).records).toEqual([
      record('a', 'A2'),
      record('c', 'C'),
    ]);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_TX_DUPLICATE_SKIPPED')).toBe(true);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_ADD_ALREADY_PRESENT_SKIPPED')).toBe(true);
  });

  it('skips a duplicated add already represented by the baseline without replacing or appending it', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'IDEMPOTENT.adi');
    const baselineTime = Date.parse('2026-02-01T00:00:00Z');
    await writeDocument(mainPath, { records: [record('same', 'value')], raw: [] });
    await fs.utimes(mainPath, new Date(baselineTime), new Date(baselineTime));
    const duplicateAdd = journalLine(
      'same-add-tx',
      baselineTime + 1,
      'add',
      { record: record('same', 'value') },
    );
    await fs.writeFile(path.join(dir, 'IDEMPOTENT.journal.jsonl'), duplicateAdd, 'utf8');
    await fs.writeFile(
      path.join(dir, 'IDEMPOTENT.journal.jsonl.corrupt-2026-02-01T00-00-01-000Z'),
      duplicateAdd,
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.appliedTransactions).toBe(1);
    expect(result.unappliedOperations).toBe(0);
    expect((await readDocument(mainPath)).records).toEqual([record('same', 'value')]);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_TX_DUPLICATE_SKIPPED')).toBe(true);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_ADD_ALREADY_PRESENT_SKIPPED')).toBe(true);
  });

  it('keeps missing update and delete operations unapplied and preserves their journal in recovery', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'UNAPPLIED.adi');
    const baselineTime = Date.parse('2026-02-02T00:00:00Z');
    await writeDocument(mainPath, { records: [record('kept', 'value')], raw: [] });
    await fs.utimes(mainPath, new Date(baselineTime), new Date(baselineTime));
    await fs.writeFile(
      path.join(dir, 'UNAPPLIED.journal.jsonl'),
      [
        journalLine('missing-update', baselineTime + 1, 'update', { record: record('missing', 'new') }),
        journalLine('missing-delete', baselineTime + 2, 'delete', { id: 'also-missing' }),
      ].join(''),
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.status).toBe('RECOVERED');
    expect(result.unappliedOperations).toBe(2);
    expect((await readDocument(mainPath)).records).toEqual([record('kept', 'value')]);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_UPDATE_TARGET_MISSING')).toBe(true);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_DELETE_TARGET_MISSING')).toBe(true);
    expect(await fs.readdir(path.join(result.recoveryPath!, 'legacy'))).toContain('UNAPPLIED.journal.jsonl');
  });

  it('uses the newest fallback snapshot and only later archives, skipping bad middle lines', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BG4IAJ.adi');
    const backupPath = `${mainPath}.bak.1`;
    await fs.writeFile(mainPath, 'INVALID', 'utf8');
    await writeDocument(backupPath, { records: [record('a', 'A')], raw: [] });
    const backupTime = new Date('2026-01-02T00:00:00Z');
    await fs.utimes(backupPath, backupTime, backupTime);

    await fs.writeFile(
      path.join(dir, 'BG4IAJ.journal.jsonl.2026-01-01T00-00-00-000Z'),
      journalLine('old-add', 1, 'add', { record: record('old', 'OLD') }),
      'utf8',
    );
    const laterArchive = [
      journalLine('delete-a', 2, 'delete', { id: 'a' }),
      '{broken json}\n',
      journalLine('bad-schema', 2.1, 'add', { record: { value: 'missing-id' } }),
      journalLine('bad-checksum', 2.2, 'add', { record: record('bad', 'BAD') })
        .replace(/[a-f0-9]{64}(?="})/, '0'.repeat(64)),
      journalLine('add-b', 3, 'add', { record: record('b', 'B') }),
      journalLine('update-missing', 3.1, 'update', { record: record('missing', 'MISSING') }),
      journalLine('delete-missing', 3.2, 'delete', { id: 'also-missing' }),
    ].join('');
    await fs.writeFile(
      path.join(dir, 'BG4IAJ.journal.jsonl.2026-01-03T00-00-00-000Z'),
      laterArchive,
      'utf8',
    );
    await fs.writeFile(
      path.join(dir, 'BG4IAJ.journal.jsonl'),
      journalLine('add-c', Date.parse('2026-01-04T00:00:00Z'), 'add', { record: record('c', 'C') }),
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.status).toBe('RECOVERED');
    expect(result.baselinePath).toBe(backupPath);
    expect((await readDocument(mainPath)).records).toEqual([record('b', 'B'), record('c', 'C')]);
    expect(result.unappliedOperations).toBe(2);
    expect(result.issues.filter(issue => issue.code === 'JOURNAL_LINE_INVALID')).toHaveLength(3);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_UPDATE_TARGET_MISSING')).toBe(true);
    expect(result.issues.some(issue => issue.code === 'JOURNAL_DELETE_TARGET_MISSING')).toBe(true);
    expect(await fs.readdir(path.join(result.recoveryPath!, 'legacy'))).toContain(
      'BG4IAJ.journal.jsonl.2026-01-03T00-00-00-000Z',
    );
  });

  it('preserves a completely unrecoverable original before creating an empty logbook', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'BROKEN.adi');
    await fs.writeFile(mainPath, 'INVALID', 'utf8');
    await fs.writeFile(path.join(dir, 'BROKEN.meta.json'), '{}', 'utf8');

    const result = await new LegacyLogbookMigrator(codec).migrate(mainPath);

    expect(result.status).toBe('RECOVERED');
    expect(await readDocument(mainPath)).toEqual({ records: [], raw: [] });
    expect(result.issues.some(issue => issue.code === 'UNRECOVERABLE_SOURCE_REPLACED')).toBe(true);
    expect(await fs.readFile(path.join(result.recoveryPath!, 'unrecoverable-original.adi'), 'utf8')).toBe('INVALID');
  });

  it('returns NOT_NEEDED without reading or decoding the main file when no legacy sidecar exists', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'DIRECT.adi');
    await fs.writeFile(mainPath, 'the worker-owned store will inspect this later', 'utf8');
    let decodeCalls = 0;
    class NoMainReadStore extends NodeLegacyLogbookFileStore {
      override async readFile(filePath: string): Promise<Buffer> {
        if (filePath === mainPath) throw new Error('legacy migrator must not read the main file');
        return super.readFile(filePath);
      }
    }
    const noDecodeCodec: LegacyLogbookMigrationCodec<TestDocument, TestRecord> = {
      ...codec,
      async decodeSnapshot(data, sourcePath) {
        decodeCalls += 1;
        return codec.decodeSnapshot(data, sourcePath);
      },
    };

    const result = await new LegacyLogbookMigrator(noDecodeCodec, new NoMainReadStore()).migrate(mainPath);

    expect(result).toMatchObject({ status: 'NOT_NEEDED', committed: false });
    expect(decodeCalls).toBe(0);
    expect(await fs.readFile(mainPath, 'utf8')).toBe('the worker-owned store will inspect this later');
    expect(await fs.readdir(dir)).toEqual(['DIRECT.adi']);
  });

  it('retries cleanup without replaying committed transactions over later user mutations', async () => {
    class FailOneRecoveryMoveStore extends NodeLegacyLogbookFileStore {
      failMove = true;

      override async rename(sourcePath: string, targetPath: string): Promise<void> {
        if (this.failMove
          && sourcePath.endsWith('PENDING.journal.jsonl')
          && targetPath.includes(`${path.sep}.tx5dr-recovery${path.sep}`)) {
          throw new Error('injected cleanup failure');
        }
        await super.rename(sourcePath, targetPath);
      }
    }

    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'PENDING.adi');
    await writeDocument(mainPath, {
      records: [record('saved', 'baseline'), record('deleted', 'baseline')],
      raw: [],
    });
    const pendingBaseline = Date.parse('2026-01-01T00:00:00Z');
    await fs.utimes(mainPath, new Date(pendingBaseline), new Date(pendingBaseline));
    await fs.writeFile(
      path.join(dir, 'PENDING.journal.jsonl'),
      [
        journalLine('pending-update', pendingBaseline + 1, 'update', {
          record: record('saved', 'legacy-final'),
        }),
        journalLine('pending-delete', pendingBaseline + 2, 'delete', { id: 'deleted' }),
      ].join(''),
      'utf8',
    );
    const store = new FailOneRecoveryMoveStore();
    const migrator = new LegacyLogbookMigrator(codec, store);

    const first = await migrator.migrate(mainPath);
    expect(first.status).toBe('CLEANUP_PENDING');
    expect((await readDocument(mainPath)).records).toEqual([record('saved', 'legacy-final')]);
    expect(await fs.readFile(path.join(dir, 'PENDING.journal.jsonl'), 'utf8')).toContain('pending-update');

    const userState = {
      records: [
        record('saved', 'user-update'),
        record('deleted', 'user-readded'),
        record('new', 'user-add'),
      ],
      raw: [],
    };
    await writeDocument(mainPath, userState);

    const stillPending = await migrator.migrate(mainPath);
    expect(stillPending.status).toBe('CLEANUP_PENDING');
    expect(await readDocument(mainPath)).toEqual(userState);

    store.failMove = false;
    const completed = await migrator.migrate(mainPath);
    expect(completed.status).not.toBe('FAILED');
    await expect(fs.access(path.join(dir, 'PENDING.journal.jsonl'))).rejects.toThrow();
    expect(await readDocument(mainPath)).toEqual(userState);
  });

  it('blocks writes when committed legacy state lacks a durable cleanup manifest', async () => {
    class FailManifestStore extends NodeLegacyLogbookFileStore {
      override async writeFileDurable(filePath: string, data: Buffer): Promise<void> {
        if (filePath.endsWith(`${path.sep}manifest.json.tmp`)) {
          throw new Error('injected manifest durability failure');
        }
        await super.writeFileDurable(filePath, data);
      }
    }

    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'UNPROVEN.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    const baseline = Date.parse('2026-01-01T00:00:00Z');
    await fs.utimes(mainPath, new Date(baseline), new Date(baseline));
    await fs.writeFile(
      path.join(dir, 'UNPROVEN.journal.jsonl'),
      journalLine('unproven-add', baseline + 1, 'add', { record: record('saved', 'yes') }),
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(codec, new FailManifestStore()).migrate(mainPath);

    expect(result.status).toBe('FAILED');
    expect(result.committed).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECOVERY_COMMIT_PROOF_MISSING' }),
    ]));
    expect((await readDocument(mainPath)).records).toEqual([record('saved', 'yes')]);
    await expect(fs.access(path.join(dir, 'UNPROVEN.journal.jsonl'))).resolves.toBeUndefined();
  });

  it('fails migration if the formal ADIF rename cannot be durably synced', async () => {
    class FailMainDirectorySyncStore extends NodeLegacyLogbookFileStore {
      override async syncDirectory(dirPath: string): Promise<void> {
        if (dirPath === path.dirname(mainPath)) {
          throw Object.assign(new Error('injected directory fsync failure'), { code: 'EIO' });
        }
        await super.syncDirectory(dirPath);
      }
    }

    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'DIRSYNC.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    const baseline = Date.parse('2026-01-01T00:00:00Z');
    await fs.utimes(mainPath, new Date(baseline), new Date(baseline));
    const journalPath = path.join(dir, 'DIRSYNC.journal.jsonl');
    await fs.writeFile(
      journalPath,
      journalLine('dirsync-add', baseline + 1, 'add', { record: record('saved', 'yes') }),
      'utf8',
    );

    const result = await new LegacyLogbookMigrator(
      codec,
      new FailMainDirectorySyncStore(),
    ).migrate(mainPath);

    expect(result.status).toBe('FAILED');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MIGRATION_FAILED', message: 'injected directory fsync failure' }),
    ]));
    expect((await readDocument(mainPath)).records).toEqual([record('saved', 'yes')]);
    await expect(fs.access(journalPath)).resolves.toBeUndefined();
  });

  it('retains completed recovery sets for 30 days and removes now-empty directories after expiry', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'TTL.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.writeFile(path.join(dir, 'TTL.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const result = await migrator.migrate(mainPath);
    const recoveryBase = path.join(dir, '.tx5dr-recovery');

    now += LEGACY_RECOVERY_RETENTION_MS - 1;
    expect((await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0))).removedRecoverySets).toBe(0);
    await expect(fs.access(result.recoveryPath!)).resolves.toBeUndefined();

    now += 2;
    expect((await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0))).removedRecoverySets).toBe(1);
    await expect(fs.access(recoveryBase)).rejects.toThrow();
    await expect(fs.access(mainPath)).resolves.toBeUndefined();
  });

  it('expires only legacy-owned files when the recovery root contains active store artifacts', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'SHARED.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.writeFile(path.join(dir, 'SHARED.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const result = await migrator.migrate(mainPath);
    const lastGoodPath = path.join(result.recoveryPath!, 'last-good.adi');
    const tailFragmentPath = path.join(result.recoveryPath!, 'tail-fragment.bin');
    const unrecoverableOriginalPath = path.join(result.recoveryPath!, 'unrecoverable-original.adi');
    await fs.writeFile(lastGoodPath, 'last good', 'utf8');
    await fs.writeFile(tailFragmentPath, 'partial tail', 'utf8');
    await fs.writeFile(unrecoverableOriginalPath, 'broken original', 'utf8');

    now += LEGACY_RECOVERY_RETENTION_MS + 1;
    const cleanup = await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0));

    expect(cleanup).toEqual({ removedRecoverySets: 1, issues: [] });
    await expect(fs.access(path.join(result.recoveryPath!, 'manifest.json'))).rejects.toThrow();
    await expect(fs.access(path.join(result.recoveryPath!, 'legacy'))).rejects.toThrow();
    await expect(fs.readFile(lastGoodPath, 'utf8')).resolves.toBe('last good');
    await expect(fs.readFile(tailFragmentPath, 'utf8')).resolves.toBe('partial tail');
    await expect(fs.readFile(unrecoverableOriginalPath, 'utf8')).resolves.toBe('broken original');
  });

  it('runs expired legacy cleanup after a later healthy no-sidecar startup', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'AUTO-CLEAN.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.writeFile(path.join(dir, 'AUTO-CLEAN.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const first = await migrator.migrate(mainPath);
    const recoveryPath = first.recoveryPath!;
    await expect(fs.access(path.join(recoveryPath, 'manifest.json'))).resolves.toBeUndefined();

    now += LEGACY_RECOVERY_RETENTION_MS + 1;
    const second = await migrator.migrate(mainPath);
    const cleanup = await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0));

    expect(second.status).toBe('NOT_NEEDED');
    expect(cleanup).toEqual({ removedRecoverySets: 1, issues: [] });
    await expect(fs.access(recoveryPath)).rejects.toThrow();
    await expect(fs.access(mainPath)).resolves.toBeUndefined();
  });

  it('ages a corrupt manifest by the recovery directory and deletes only recognized legacy files', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'CORRUPT-MANIFEST.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    let now = Date.parse('2026-02-15T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const recoveryRoot = recovery.getRecoveryRoot(mainPath);
    const legacyDir = path.join(recoveryRoot, 'legacy');
    const manifestPath = path.join(recoveryRoot, 'manifest.json');
    const recognizedPath = path.join(legacyDir, 'CORRUPT-MANIFEST.meta.json');
    const unknownPath = path.join(legacyDir, 'user-note.txt');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(recognizedPath, '{}', 'utf8');
    await fs.writeFile(unknownPath, 'keep me', 'utf8');
    await fs.writeFile(manifestPath, '{not-json', 'utf8');
    const retentionAnchor = now - LEGACY_RECOVERY_RETENTION_MS + 1;
    await fs.utimes(legacyDir, retentionAnchor / 1000, retentionAnchor / 1000);
    await fs.utimes(manifestPath, retentionAnchor / 1000, retentionAnchor / 1000);

    const deferred = await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0));
    expect(deferred).toMatchObject({
      removedRecoverySets: 0,
      issues: [expect.objectContaining({ code: 'RECOVERY_MANIFEST_INVALID' })],
    });
    await expect(fs.access(recognizedPath)).resolves.toBeUndefined();

    now += 2;
    const cleaned = await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0));
    expect(cleaned).toMatchObject({
      removedRecoverySets: 1,
      issues: [expect.objectContaining({ code: 'RECOVERY_RETENTION_UNKNOWN_FILES' })],
    });
    await expect(fs.access(recognizedPath)).rejects.toThrow();
    await expect(fs.readFile(unknownPath, 'utf8')).resolves.toBe('keep me');
    await expect(fs.access(manifestPath)).rejects.toThrow();
    await expect(fs.access(mainPath)).resolves.toBeUndefined();
  });

  it('treats a schema-valid manifest that names an unknown file as invalid and preserves that file', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'UNKNOWN-MANIFEST.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    let now = Date.parse('2026-02-15T00:00:00Z');
    const recovery = new LegacyLogbookRecoveryManager(
      new NodeLegacyLogbookFileStore(),
      () => now,
    );
    const recoveryRoot = recovery.getRecoveryRoot(mainPath);
    const legacyDir = path.join(recoveryRoot, 'legacy');
    const manifestPath = path.join(recoveryRoot, 'manifest.json');
    const unknownPath = path.join(legacyDir, 'user-note.txt');
    const unknown = Buffer.from('keep me', 'utf8');
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(unknownPath, unknown);
    await fs.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      mainPath,
      pathHash: legacyLogbookPathHash(mainPath),
      state: 'complete',
      createdAt: now - LEGACY_RECOVERY_RETENTION_MS - 1,
      completedAt: now - LEGACY_RECOVERY_RETENTION_MS - 1,
      expiresAt: now - 1,
      candidateSha256: 'candidate',
      candidateRecordCount: 0,
      artifacts: [{
        name: 'user-note.txt',
        size: unknown.length,
        sha256: createHash('sha256').update(unknown).digest('hex'),
      }],
    }), 'utf8');
    const retentionAnchor = now - LEGACY_RECOVERY_RETENTION_MS - 1;
    await fs.utimes(legacyDir, retentionAnchor / 1000, retentionAnchor / 1000);
    await fs.utimes(manifestPath, retentionAnchor / 1000, retentionAnchor / 1000);

    const cleanup = await recovery.cleanupExpiredFor(mainPath, await retentionProof(mainPath, 0));

    expect(cleanup).toMatchObject({
      removedRecoverySets: 1,
      issues: [expect.objectContaining({ code: 'RECOVERY_RETENTION_UNKNOWN_FILES' })],
    });
    await expect(fs.readFile(unknownPath, 'utf8')).resolves.toBe('keep me');
    await expect(fs.access(manifestPath)).rejects.toThrow();
  });

  it('defers expired cleanup when a quarantined legacy artifact has changed', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'CHANGED-RECOVERY.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.writeFile(path.join(dir, 'CHANGED-RECOVERY.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const migration = await migrator.migrate(mainPath);
    const artifactPath = path.join(
      migration.recoveryPath!,
      'legacy',
      'CHANGED-RECOVERY.meta.json',
    );
    await fs.appendFile(artifactPath, 'changed', 'utf8');

    now += LEGACY_RECOVERY_RETENTION_MS + 1;
    const cleanup = await migrator.cleanupExpired(mainPath, await retentionProof(mainPath, 0));

    expect(cleanup).toMatchObject({
      removedRecoverySets: 0,
      issues: [expect.objectContaining({ code: 'RECOVERY_RETENTION_ARTIFACT_CHANGED' })],
    });
    await expect(fs.readFile(artifactPath, 'utf8')).resolves.toBe('{}changed');
    await expect(fs.access(path.join(migration.recoveryPath!, 'manifest.json'))).resolves.toBeUndefined();
  });

  it('retains expired legacy recovery when the current main is damaged', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'DAMAGED.adi');
    await writeDocument(mainPath, { records: [record('only-copy', 'kept')], raw: [] });
    await fs.writeFile(path.join(dir, 'DAMAGED.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const migration = await migrator.migrate(mainPath);
    const manifestPath = path.join(migration.recoveryPath!, 'manifest.json');
    const legacyDir = path.join(migration.recoveryPath!, 'legacy');

    now += LEGACY_RECOVERY_RETENTION_MS + 1;
    await fs.writeFile(mainPath, 'INVALID', 'utf8');
    const cleanup = await migrator.cleanupExpired(
      mainPath,
      await retentionProof(mainPath, 0, { complete: false, recoveredDuringOpen: true }),
    );

    expect(cleanup).toEqual({ removedRecoverySets: 0, issues: [] });
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
    await expect(fs.access(legacyDir)).resolves.toBeUndefined();
  });

  it('retains expired legacy recovery when the healthy scan proof is stale', async () => {
    const dir = await makeTempDir();
    const mainPath = path.join(dir, 'STALE.adi');
    await writeDocument(mainPath, { records: [], raw: [] });
    await fs.writeFile(path.join(dir, 'STALE.meta.json'), '{}', 'utf8');
    let now = Date.parse('2026-01-01T00:00:00Z');
    const store = new NodeLegacyLogbookFileStore();
    const recovery = new LegacyLogbookRecoveryManager(store, () => now);
    const migrator = new LegacyLogbookMigrator(codec, store, recovery);
    const migration = await migrator.migrate(mainPath);

    now += LEGACY_RECOVERY_RETENTION_MS + 1;
    const proof = await retentionProof(mainPath, 0);
    await fs.appendFile(mainPath, 'changed', 'utf8');
    const cleanup = await migrator.cleanupExpired(mainPath, proof);

    expect(cleanup.removedRecoverySets).toBe(0);
    expect(cleanup.issues.map(issue => issue.code)).toEqual(['RECOVERY_RETENTION_PROOF_STALE']);
    await expect(fs.access(path.join(migration.recoveryPath!, 'manifest.json'))).resolves.toBeUndefined();
  });
});
