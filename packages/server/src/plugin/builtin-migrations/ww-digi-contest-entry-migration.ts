import { createHash } from 'node:crypto';

import {
  createWWDigiContestEntry,
  readWWDigiContestEntry,
  wwDigiEditionId,
  wwDigiRulesetVersion,
  WW_DIGI_CONTEST_ID,
  type WWDigiContestSource,
  type WWDigiContestStatus,
} from '@tx5dr/builtin-plugins';
import type {
  ContestQsoEnvelope,
  PluginContext,
  PluginLogbookSessionAccess,
  QSORecord,
} from '@tx5dr/plugin-api';

type WWDigiMigrationContext = PluginContext & {
  logbook: { sessions: {
    open(descriptor: {
      sessionKey: string;
      stationCallsign: string;
      title: string;
    }): Promise<PluginLogbookSessionAccess>;
  } };
};

interface LegacyOverride {
  status?: WWDigiContestStatus;
  source?: WWDigiContestSource;
  streamId?: string;
  authorizationId?: string;
  operatorId?: string;
  transmitterId?: 0 | 1;
}

interface LegacySession {
  config?: { categoryTransmitter?: string };
  overrides?: Record<string, LegacyOverride>;
}

interface MigrationJournal {
  phase: 'detected' | 'target_written' | 'verified' | 'completed';
  contestYear: number;
  callsign: string;
  startedAt: number;
  updatedAt: number;
  migratedRecordIds: string[];
  sourceRecordCount?: number;
  targetRecordCount?: number;
  sourceRecordHash?: string;
  expectedTargetRecordHash?: string;
  targetRecordHash?: string;
}

const SESSION_KEY_PREFIX = 'contestSession:';
const MAIDENHEAD_4_PATTERN = /^[A-R]{2}[0-9]{2}$/;

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function migrationBasePath(callsign: string, contestYear: number): string {
  return `migration/ww-digi-contest-entry/${safePathSegment(callsign)}-${contestYear}`;
}

async function readJson<T>(ctx: PluginContext, path: string): Promise<T | undefined> {
  const data = await ctx.files.read(path);
  if (!data) return undefined;
  try {
    return JSON.parse(data.toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(ctx: PluginContext, path: string, value: unknown): Promise<void> {
  await ctx.files.write(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function sessionKey(callsign: string, contestYear: number): string {
  return `${SESSION_KEY_PREFIX}${callsign}:${contestYear}`;
}

function discoverContestYears(ctx: PluginContext, callsign: string): number[] {
  const years = new Set<number>();
  for (const key of Object.keys(ctx.store.global.getAll())) {
    if (!key.startsWith(`${SESSION_KEY_PREFIX}${callsign}:`)) continue;
    const year = Number(key.slice(`${SESSION_KEY_PREFIX}${callsign}:`.length));
    if (Number.isInteger(year) && year >= 2019 && year <= 2100) years.add(year);
  }
  const configured = Number(ctx.config.contestYear);
  if (Number.isInteger(configured) && configured >= 2019 && configured <= 2100) years.add(configured);
  return [...years].sort((left, right) => left - right);
}

function legacySource(record: QSORecord, override: LegacyOverride | undefined): WWDigiContestSource {
  if (override?.source) return override.source;
  return record.messageHistory.length > 0 ? 'ww-digi' : 'reconciled';
}

function isWWDigiRecord(record: QSORecord): boolean {
  return record.contestId?.toUpperCase() === WW_DIGI_CONTEST_ID;
}

function hasExpectedContestEntry(record: QSORecord, contestYear: number): boolean {
  return Boolean(
    readWWDigiContestEntry(record)
    && record.contestEntry?.editionId === wwDigiEditionId(contestYear)
    && record.contestEntry.rulesetVersion === wwDigiRulesetVersion(contestYear),
  );
}

function normalizeMaidenhead4(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase().slice(0, 4);
  return normalized && MAIDENHEAD_4_PATTERN.test(normalized) ? normalized : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

function migrationSourceFact(record: QSORecord) {
  return {
    id: record.id,
    callsign: record.callsign.trim().toUpperCase(),
    contestId: record.contestId?.trim().toUpperCase() ?? null,
    startTime: record.startTime,
    frequency: Math.round(record.frequency),
    mode: record.mode.trim().toUpperCase(),
    submode: record.submode?.trim().toUpperCase() ?? null,
    myCallsign: record.myCallsign?.trim().toUpperCase() ?? null,
    myGrid: record.myGrid?.trim().toUpperCase() ?? null,
    grid: record.grid?.trim().toUpperCase() ?? null,
    messageHistory: [...record.messageHistory],
  };
}

function migrationFactHash(
  records: readonly QSORecord[],
  contestEntry: (record: QSORecord) => ContestQsoEnvelope | undefined,
): string {
  return createHash('sha256')
    .update(records
      .map((record) => ({
        ...migrationSourceFact(record),
        contestEntry: contestEntry(record) ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(stableJson)
      .join('\n'), 'utf8')
    .digest('hex');
}

function migrationReceipt(
  records: readonly QSORecord[],
  contestYear: number,
  session: LegacySession,
  migratedRecordIds: ReadonlySet<string>,
) {
  const source = records.filter(isWWDigiRecord);
  const target = source.filter((record) => hasExpectedContestEntry(record, contestYear));
  return {
    sourceRecordCount: source.length,
    targetRecordCount: target.length,
    sourceRecordHash: migrationFactHash(source, () => undefined),
    expectedTargetRecordHash: migrationFactHash(source, (record) => (
      migratedRecordIds.has(record.id)
        ? buildContestEntry(record, contestYear, session)
        : record.contestEntry
    )),
    targetRecordHash: migrationFactHash(target, (record) => record.contestEntry),
  };
}

type WWDigiMigrationReceipt = ReturnType<typeof migrationReceipt>;

function isVerifiedReceipt(receipt: WWDigiMigrationReceipt): boolean {
  return receipt.sourceRecordCount === receipt.targetRecordCount
    && receipt.expectedTargetRecordHash === receipt.targetRecordHash;
}

function journalMatchesReceipt(
  journal: MigrationJournal,
  receipt: WWDigiMigrationReceipt,
): boolean {
  return journal.sourceRecordCount === receipt.sourceRecordCount
    && journal.targetRecordCount === receipt.targetRecordCount
    && journal.sourceRecordHash === receipt.sourceRecordHash
    && journal.expectedTargetRecordHash === receipt.expectedTargetRecordHash
    && journal.targetRecordHash === receipt.targetRecordHash;
}

function buildContestEntry(
  record: QSORecord,
  contestYear: number,
  session: LegacySession,
) {
  const override = session.overrides?.[record.id];
  const transmitterRequired = session.config?.categoryTransmitter === 'TWO';
  const sentGrid = normalizeMaidenhead4(record.myGrid);
  const receivedGrid = normalizeMaidenhead4(record.grid);
  const requiresReview = !sentGrid || !receivedGrid
    || (transmitterRequired && override?.transmitterId === undefined);
  const status = !sentGrid || !receivedGrid
    ? 'review'
    : override?.status ?? (requiresReview ? 'review' : 'included');
  return createWWDigiContestEntry({
    contestYear,
    sentGrid: sentGrid ?? '',
    receivedGrid,
    status,
    source: legacySource(record, override),
    streamId: override?.streamId,
    authorizationId: override?.authorizationId,
    operatorId: override?.operatorId,
    transmitterId: override?.transmitterId,
  });
}

async function auditOrphanOperatorKeys(ctx: PluginContext, callsign: string): Promise<void> {
  const orphanEntries = Object.fromEntries(Object.entries(ctx.store.operator.getAll()).filter(([key]) => (
    key.startsWith('contestQsos:') || key.startsWith('ledgerHealth:')
  )));
  if (Object.keys(orphanEntries).length === 0) return;
  const path = `migration/ww-digi-contest-entry/${safePathSegment(callsign)}-orphan-operator-kv.json`;
  if (!await ctx.files.read(path)) {
    await writeJson(ctx, path, { detectedAt: Date.now(), entries: orphanEntries });
  }
  ctx.log.warn('WW Digi legacy operator KV was backed up but not treated as authoritative', {
    keys: Object.keys(orphanEntries),
  });
}

async function migrateContestYear(
  ctx: WWDigiMigrationContext,
  callsign: string,
  contestYear: number,
): Promise<void> {
  const basePath = migrationBasePath(callsign, contestYear);
  const journalPath = `${basePath}-journal.json`;
  const existingJournal = await readJson<MigrationJournal>(ctx, journalPath);
  const storedSession = ctx.store.global.get<LegacySession | undefined>(sessionKey(callsign, contestYear)) ?? {};
  if (!await ctx.files.read(`${basePath}-backup.json`)) {
    await writeJson(ctx, `${basePath}-backup.json`, {
      detectedAt: Date.now(),
      session: storedSession,
    });
  }
  const startedAt = existingJournal?.startedAt ?? Date.now();
  const migratedIds = new Set(existingJournal?.migratedRecordIds ?? []);
  const logbook = await ctx.logbook.sessions.open({
    sessionKey: `ww-digi:${contestYear}`,
    stationCallsign: callsign,
    title: `WW Digi ${contestYear} - ${callsign}`,
  });
  await logbook.awaitReady();

  if (existingJournal?.phase === 'completed') {
    const current = await logbook.readQsoSnapshot();
    const observed = migrationReceipt(current.records, contestYear, storedSession, new Set());
    if (isVerifiedReceipt(observed)) {
      if (!journalMatchesReceipt(existingJournal, observed)) {
        await writeJson(ctx, journalPath, {
          ...existingJournal,
          ...observed,
          updatedAt: Date.now(),
        } satisfies MigrationJournal);
      }
      return;
    }
  }

  await writeJson(ctx, journalPath, {
    phase: existingJournal?.phase === 'completed'
      ? 'detected'
      : existingJournal?.phase ?? 'detected',
    contestYear,
    callsign,
    startedAt,
    updatedAt: Date.now(),
    migratedRecordIds: [...migratedIds],
  } satisfies MigrationJournal);

  const repairedIds = new Set<string>();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await logbook.readQsoSnapshot();
    const missing = snapshot.records.filter((record) => (
      isWWDigiRecord(record)
      && !record.contestEntry
    ));
    if (missing.length === 0) break;
    try {
      const result = await logbook.applyQsoBatch(missing.map((record) => ({
        type: 'update' as const,
        qsoId: record.id,
        updates: {
          contestId: WW_DIGI_CONTEST_ID,
          contestEntry: buildContestEntry(record, contestYear, storedSession),
        },
      })), { expectedRevision: snapshot.revision });
      result.outcomes.forEach((outcome) => {
        migratedIds.add(outcome.record.id);
        repairedIds.add(outcome.record.id);
      });
      break;
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'LOGBOOK_REVISION_CONFLICT' && attempt < 2) continue;
      throw error;
    }
  }

  const verified = await logbook.readQsoSnapshot();
  const expectedIds = existingJournal?.phase === 'completed' ? repairedIds : migratedIds;
  const receipt = migrationReceipt(verified.records, contestYear, storedSession, expectedIds);
  await writeJson(ctx, journalPath, {
    phase: 'target_written',
    contestYear,
    callsign,
    startedAt,
    updatedAt: Date.now(),
    migratedRecordIds: [...migratedIds],
    ...receipt,
  } satisfies MigrationJournal);
  if (!isVerifiedReceipt(receipt)) {
    const detail = receipt.sourceRecordCount !== receipt.targetRecordCount
      ? `${receipt.sourceRecordCount - receipt.targetRecordCount} QSO(s) missing an expected envelope`
      : 'migrated QSO content hash mismatch';
    throw new Error(
      `WW Digi contest-entry migration verification failed: ${detail}`,
    );
  }
  await writeJson(ctx, journalPath, {
    phase: 'verified',
    contestYear,
    callsign,
    startedAt,
    updatedAt: Date.now(),
    migratedRecordIds: [...migratedIds],
    ...receipt,
  } satisfies MigrationJournal);
  await writeJson(ctx, journalPath, {
    phase: 'completed',
    contestYear,
    callsign,
    startedAt,
    updatedAt: Date.now(),
    migratedRecordIds: [...migratedIds],
    ...receipt,
  } satisfies MigrationJournal);
}

export async function migrateWWDigiContestEntries(context: PluginContext): Promise<void> {
  const ctx = context as WWDigiMigrationContext;
  if (!ctx.logbook?.sessions) throw new Error('WW Digi migration requires plugin logbook sessions');
  const callsign = ctx.operator.callsign.trim().toUpperCase();
  await auditOrphanOperatorKeys(ctx, callsign);
  for (const contestYear of discoverContestYears(ctx, callsign)) {
    await migrateContestYear(ctx, callsign, contestYear);
  }
}
