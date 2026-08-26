import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  ImageHistoryRecordSchema,
  type ImageArtifact,
  type ImageFamily,
  type ImageHistoryRecord,
  type SstvTxEnvelopeSnapshot,
} from '@tx5dr/contracts';

import { SafeFileWriter, loadJsonWithRecovery } from '../utils/persistence/index.js';

interface HistoryIndex { records: ImageHistoryRecord[] }

interface HistoryCursor { occurredAt: number; id: string }

export interface ImageHistoryListOptions {
  family?: ImageFamily;
  direction?: 'all' | 'rx' | 'tx';
  txOperatorId?: string;
  includeAllTx?: boolean;
  limit?: number;
  cursor?: string;
}

function encodeCursor(record: ImageHistoryRecord): string {
  return Buffer.from(JSON.stringify({ occurredAt: record.occurredAt, id: record.id } satisfies HistoryCursor)).toString('base64url');
}

function decodeCursor(value?: string): HistoryCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<HistoryCursor>;
    return typeof parsed.occurredAt === 'number' && Number.isFinite(parsed.occurredAt) && typeof parsed.id === 'string'
      ? { occurredAt: parsed.occurredAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

export class ImageHistoryStore {
  private readonly writer = new SafeFileWriter({ backups: 3 });
  private readonly filePath: string;
  private readonly records = new Map<string, ImageHistoryRecord>();
  private initialized = false;
  private persistTail: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'history.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await loadJsonWithRecovery<HistoryIndex>(this.filePath, {
      defaultValue: () => ({ records: [] }),
      validate: (value) => ({ records: ImageHistoryRecordSchema.array().parse((value as HistoryIndex)?.records ?? []) }),
      writer: this.writer,
    });
    for (const record of loaded.value.records) this.records.set(record.id, record);
    this.initialized = true;
  }

  async reconcileReceivedArtifacts(artifacts: ImageArtifact[]): Promise<void> {
    await this.initialize();
    const recordedArtifacts = new Set([...this.records.values()].map((record) => record.artifactId));
    let changed = false;
    for (const artifact of artifacts) {
      if (artifact.direction !== 'rx' || recordedArtifacts.has(artifact.id)) continue;
      const record = ImageHistoryRecordSchema.parse({
        id: `rx-${artifact.id}`,
        artifactId: artifact.id,
        family: artifact.family,
        direction: 'rx',
        operatorId: artifact.operatorId,
        occurredAt: artifact.captureEndedAt ?? artifact.createdAt,
        saveReason: artifact.saveReason ?? 'manual',
        complete: artifact.complete,
        truncated: artifact.truncated,
        qsoId: artifact.qsoId,
      });
      this.records.set(record.id, record);
      changed = true;
    }
    if (changed) await this.persist();
  }

  list(options: ImageHistoryListOptions = {}): { records: ImageHistoryRecord[]; nextCursor?: string } {
    const direction = options.direction ?? 'all';
    const cursor = decodeCursor(options.cursor);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const records = [...this.records.values()]
      .filter((record) => !options.family || record.family === options.family)
      .filter((record) => direction === 'all' || record.direction === direction)
      .filter((record) => record.direction === 'rx' || options.includeAllTx || (options.txOperatorId && record.operatorId === options.txOperatorId))
      .filter((record) => !cursor
        || record.occurredAt < cursor.occurredAt
        || (record.occurredAt === cursor.occurredAt && record.id.localeCompare(cursor.id) < 0))
      .sort((a, b) => b.occurredAt - a.occurredAt || b.id.localeCompare(a.id));
    const page = records.slice(0, limit);
    return {
      records: page,
      nextCursor: records.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : undefined,
    };
  }

  get(id: string): ImageHistoryRecord | null {
    return this.records.get(id) ?? null;
  }

  referencesArtifact(artifactId: string): boolean {
    return [...this.records.values()].some((record) => record.artifactId === artifactId);
  }

  async recordReceived(artifact: ImageArtifact): Promise<ImageHistoryRecord> {
    await this.initialize();
    if (artifact.direction !== 'rx') throw new Error('IMAGE_HISTORY_DIRECTION_INVALID');
    const record = ImageHistoryRecordSchema.parse({
      id: randomUUID(),
      artifactId: artifact.id,
      family: artifact.family,
      direction: 'rx',
      operatorId: artifact.operatorId,
      occurredAt: artifact.captureEndedAt ?? artifact.createdAt,
      saveReason: artifact.saveReason ?? 'manual',
      complete: artifact.complete,
      truncated: artifact.truncated,
      qsoId: artifact.qsoId,
    });
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  async recordTransmitStarted(input: {
    id?: string;
    artifact: ImageArtifact;
    operatorId: string;
    sessionId: string;
    startedAt: number;
    envelope: SstvTxEnvelopeSnapshot;
    sampleRate: number;
    estimatedTotalSamples: number;
  }): Promise<ImageHistoryRecord> {
    await this.initialize();
    if (input.artifact.direction !== 'tx' || input.artifact.family !== 'sstv') throw new Error('IMAGE_HISTORY_DIRECTION_INVALID');
    const record = ImageHistoryRecordSchema.parse({
      id: input.id ?? randomUUID(),
      artifactId: input.artifact.id,
      family: input.artifact.family,
      direction: 'tx',
      operatorId: input.operatorId,
      sessionId: input.sessionId,
      occurredAt: input.startedAt,
      startedAt: input.startedAt,
      outcome: 'transmitting',
      envelope: input.envelope,
      sampleRate: input.sampleRate,
      estimatedTotalSamples: input.estimatedTotalSamples,
    });
    this.records.set(record.id, record);
    await this.persist();
    return record;
  }

  async finishTransmit(id: string, outcome: 'completed' | 'interrupted', errorCode?: string): Promise<ImageHistoryRecord> {
    await this.initialize();
    const current = this.records.get(id);
    if (!current || current.direction !== 'tx') throw new Error('IMAGE_HISTORY_NOT_FOUND');
    const updated = ImageHistoryRecordSchema.parse({
      ...current,
      outcome,
      endedAt: Date.now(),
      errorCode: outcome === 'interrupted' ? errorCode : undefined,
    });
    this.records.set(id, updated);
    await this.persist();
    return updated;
  }

  async linkQso(id: string, qsoId: string): Promise<ImageHistoryRecord> {
    await this.initialize();
    const current = this.records.get(id);
    if (!current) throw new Error('IMAGE_HISTORY_NOT_FOUND');
    const updated = ImageHistoryRecordSchema.parse({ ...current, qsoId });
    this.records.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<ImageHistoryRecord> {
    await this.initialize();
    const current = this.records.get(id);
    if (!current) throw new Error('IMAGE_HISTORY_NOT_FOUND');
    this.records.delete(id);
    await this.persist();
    return current;
  }

  async removeByArtifact(artifactId: string): Promise<void> {
    await this.initialize();
    const matching = [...this.records.values()].filter((record) => record.artifactId === artifactId);
    if (matching.length === 0) return;
    for (const record of matching) this.records.delete(record.id);
    await this.persist();
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify({ records: [...this.records.values()] }, null, 2)}\n`;
    const operation = this.persistTail.catch(() => undefined).then(() => this.writer.writeFile(this.filePath, serialized));
    this.persistTail = operation;
    return operation;
  }
}
