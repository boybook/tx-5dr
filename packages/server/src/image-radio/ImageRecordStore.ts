import { createHash } from 'node:crypto';
import path from 'node:path';
import type { z } from 'zod';
import type { ImagePersistenceStoreStatus } from '@tx5dr/contracts';
import { SafeFileWriter, listRecoveryCandidates, readOptionalFile, jsonFailureCode } from '../utils/persistence/SafeFileWriter.js';
import { createLogger } from '../utils/logger.js';
import { migrateImageRecord } from './ImagePersistenceSchema.js';

const logger = createLogger('ImageRecordStore');
const VERSION = 1;
class FutureVersionError extends Error {}
interface Decoded<T> { records: T[]; rejected: number; version: number; issues: { path: (string | number)[]; code: string }[] }
interface Candidate<T> { path: string; raw: Buffer; decoded?: Decoded<T>; error?: string }

/** One disk collection, one initialization, one serial commit owner. */
export class ImageRecordStore<T> {
  private records = new Map<string, T>();
  private initialization?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly writer = new SafeFileWriter({ backups: 3 });
  private health: ImagePersistenceStoreStatus;

  constructor(
    readonly filePath: string,
    private readonly collection: string,
    store: ImagePersistenceStoreStatus['store'],
    private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    private readonly key: (record: T) => string,
  ) { this.health = { store, state: 'loading', retainedRecords: 0, rejectedRecords: 0 }; }

  get values(): ReadonlyMap<string, T> { return this.records; }
  getStatus(): ImagePersistenceStoreStatus { return { ...this.health }; }

  markUnavailable(): void { this.health = { ...this.health, state: 'unavailable', reason: 'io_error' }; }

  initialize(): Promise<void> {
    this.initialization ??= this.load().catch(error => {
      this.health = { ...this.health, state: 'unavailable', reason: error instanceof FutureVersionError ? 'future_version' : 'io_error' };
      logger.error('Image persistence unavailable', { filePath: this.filePath, reason: this.health.reason, code: jsonFailureCode(error) });
      throw error;
    });
    return this.initialization;
  }

  async transaction<R>(mutate: (records: Map<string, T>) => R | Promise<R>): Promise<R> {
    await this.initialize();
    const operation = this.tail.catch(() => undefined).then(async () => {
      if (this.health.state === 'unavailable') throw new Error('IMAGE_PERSISTENCE_UNAVAILABLE');
      // Isolate both the map and its records from rejected mutations.
      const next = new Map([...this.records].map(([key, record]) => [key, structuredClone(record)]));
      const result = await mutate(next);
      const parsed = this.decode({ schemaVersion: VERSION, [this.collection]: [...next.values()] });
      if (parsed.rejected) throw new Error('IMAGE_PERSISTENCE_INVALID_WRITE');
      const serialized = this.serialize(parsed.records);
      if (serialized !== this.serialize([...this.records.values()])) await this.writer.writeFile(this.filePath, serialized);
      this.records = new Map(parsed.records.map(record => [this.key(record), record]));
      return result;
    });
    this.tail = operation;
    return operation;
  }

  private serialize(records: T[]): string {
    return `${JSON.stringify({ schemaVersion: VERSION, [this.collection]: records }, null, 2)}\n`;
  }

  private decode(value: unknown): Decoded<T> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ROOT');
    const root = value as Record<string, unknown>;
    const version = root.schemaVersion === undefined ? 0 : root.schemaVersion;
    if (typeof version === 'number' && version > VERSION) throw new FutureVersionError('IMAGE_PERSISTENCE_FUTURE_VERSION');
    if (version !== 0 && version !== VERSION) throw new Error('INVALID_VERSION');
    const input = root[this.collection];
    if (!Array.isArray(input)) throw new Error('INVALID_COLLECTION');
    const parsed: T[] = [];
    const issues: Decoded<T>['issues'] = [];
    const counts = new Map<string, number>();
    for (const [index, item] of input.entries()) {
      const result = this.schema.safeParse(migrateImageRecord(item, version, this.collection));
      if (!result.success) {
        issues.push(...result.error.issues.map(issue => ({ path: [this.collection, index, ...issue.path], code: issue.code })));
        continue;
      }
      const key = this.key(result.data);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      parsed.push(result.data);
    }
    // Reject every member of a conflicting identity, never choose an arbitrary winner.
    const records = parsed.filter(record => counts.get(this.key(record)) === 1);
    if (records.length !== parsed.length) issues.push({ path: [this.collection], code: 'duplicate_identity' });
    return { records, rejected: input.length - records.length, version, issues };
  }

  private async candidate(candidatePath: string): Promise<Candidate<T> | null> {
    const raw = await readOptionalFile(candidatePath);
    if (raw === null) return null;
    try { return { path: candidatePath, raw, decoded: this.decode(JSON.parse(raw.toString('utf8'))) }; }
    catch (error) {
      if (error instanceof FutureVersionError) throw error;
      return { path: candidatePath, raw, error: jsonFailureCode(error) };
    }
  }

  private async load(): Promise<void> {
    const main = await this.candidate(this.filePath);
    if (main?.decoded && main.decoded.rejected === 0 && main.decoded.version === VERSION) {
      this.publish(main.decoded.records, 'ready');
      return;
    }
    const candidates: Candidate<T>[] = [];
    // Read every file that a repair could affect before attempting any mutation.
    for (const candidatePath of await listRecoveryCandidates(this.filePath)) {
      const candidate = await this.candidate(candidatePath);
      if (candidate) candidates.push(candidate);
    }
    const all = main ? [main, ...candidates] : candidates;
    if (all.length === 0) {
      await this.writer.writeFile(this.filePath, this.serialize([]), { backups: 0 });
      this.publish([], 'ready');
      return;
    }
    const completeMain = main?.decoded?.rejected === 0 ? main : undefined;
    const completeBackup = candidates.find(candidate => candidate.decoded?.rejected === 0);
    const chosen = completeMain ?? completeBackup ?? (main?.decoded ? main : candidates.find(candidate => candidate.decoded));
    const records = chosen?.decoded?.records ?? [];
    const reason: ImagePersistenceStoreStatus['reason'] = completeMain ? 'migrated'
      : completeBackup ? 'backup_restored' : records.length ? 'salvaged' : 'rebuilt';
    const rejected = chosen?.decoded?.rejected ?? 0;
    await this.archive(all, { reason, source: chosen ? path.basename(chosen.path) : null, retainedRecords: records.length, rejectedRecords: rejected });
    await this.writer.writeFile(this.filePath, this.serialize(records), { backups: 0 });
    this.publish(records, reason === 'migrated' ? 'ready' : 'recovered', reason, rejected);
    logger.warn('Image persistence repaired', { filePath: this.filePath, reason, retainedRecords: records.length, rejectedRecords: rejected });
  }

  private publish(records: T[], state: ImagePersistenceStoreStatus['state'], reason?: ImagePersistenceStoreStatus['reason'], rejected = 0): void {
    this.records = new Map(records.map(record => [this.key(record), record]));
    this.health = { store: this.health.store, state, reason, retainedRecords: records.length, rejectedRecords: rejected };
  }

  private async archive(candidates: Candidate<T>[], outcome: Record<string, unknown>): Promise<void> {
    const recoveryDir = path.join(path.dirname(this.filePath), 'recovery', path.basename(this.filePath));
    const entries = [];
    for (const candidate of candidates) {
      const digest = createHash('sha256').update(candidate.raw).digest('hex');
      const archivePath = path.join(recoveryDir, `${digest}.original`);
      const existing = await readOptionalFile(archivePath);
      if (existing && !existing.equals(candidate.raw)) throw new Error('IMAGE_RECOVERY_ARCHIVE_MISMATCH');
      if (!existing) await this.writer.writeFile(archivePath, candidate.raw, { backups: 0 });
      entries.push({ source: path.basename(candidate.path), digest, error: candidate.error, issues: candidate.decoded?.issues });
    }
    const report = `${JSON.stringify({ ...outcome, candidates: entries }, null, 2)}\n`;
    const digest = createHash('sha256').update(report).digest('hex');
    await this.writer.writeFile(path.join(recoveryDir, `${digest}.report.json`), report, { backups: 0 });
  }
}
