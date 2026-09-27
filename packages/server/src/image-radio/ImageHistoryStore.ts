import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  ImageHistoryRecordSchema,
  type ImageArtifact,
  type ImageFamily,
  type ImageHistoryRecord,
  type SstvTxEnvelopeSnapshot,
} from '@tx5dr/contracts';

import { ImageRecordStore } from './ImageRecordStore.js';
import { PersistedHistorySchema } from './ImagePersistenceSchema.js';

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
  readonly persistence: ImageRecordStore<ImageHistoryRecord>;
  private get records() { return this.persistence.values; }

  constructor(baseDir: string) {
    this.persistence = new ImageRecordStore(path.join(baseDir, 'history.json'), 'records', 'history', PersistedHistorySchema, item => item.id);
  }

  initialize(): Promise<void> { return this.persistence.initialize(); }

  async reconcileReceivedArtifacts(artifacts: ImageArtifact[]): Promise<void> {
    return this.persistence.transaction(records => {
      const recordedArtifacts = new Set([...records.values()].map((record) => record.artifactId));
      for (const artifact of artifacts) {
        if (artifact.direction !== 'rx' || recordedArtifacts.has(artifact.id)) continue;
        const record = ImageHistoryRecordSchema.parse({
          id: records.has(`rx-${artifact.id}`) ? randomUUID() : `rx-${artifact.id}`,
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
        records.set(record.id, record);
      }
    });
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
    return this.persistence.transaction(records => {
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
      records.set(record.id, record);
      return record;
    });
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
    return this.persistence.transaction(records => {
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
      records.set(record.id, record);
      return record;
    });
  }

  async finishTransmit(id: string, outcome: 'completed' | 'interrupted', errorCode?: string): Promise<ImageHistoryRecord> {
    return this.persistence.transaction(records => {
      const current = records.get(id);
      if (!current || current.direction !== 'tx') throw new Error('IMAGE_HISTORY_NOT_FOUND');
      const updated = ImageHistoryRecordSchema.parse({
        ...current,
        outcome,
        endedAt: Date.now(),
        errorCode: outcome === 'interrupted' ? errorCode : undefined,
      });
      records.set(id, updated);
      return updated;
    });
  }

  async linkQso(id: string, qsoId: string): Promise<ImageHistoryRecord> {
    return this.persistence.transaction(records => {
      const current = records.get(id);
      if (!current) throw new Error('IMAGE_HISTORY_NOT_FOUND');
      const updated = ImageHistoryRecordSchema.parse({ ...current, qsoId });
      records.set(id, updated);
      return updated;
    });
  }

  async delete(id: string): Promise<ImageHistoryRecord> {
    return this.persistence.transaction(records => {
      const current = records.get(id);
      if (!current) throw new Error('IMAGE_HISTORY_NOT_FOUND');
      records.delete(id);
      return current;
    });
  }

  async removeByArtifact(artifactId: string): Promise<void> {
    return this.persistence.transaction(records => {
      const matching = [...records.values()].filter((record) => record.artifactId === artifactId);
      if (matching.length === 0) return;
      for (const record of matching) records.delete(record.id);
    });
  }

}
