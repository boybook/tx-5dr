import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { wwDigiSimulationScenarios } from './simulation-scenarios.js';
import {
  definePlugin,
  composeFT8ContestPlugin,
  generateADIFFile,
  type PluginContextFor,
  type PluginLogbookSessionAccess,
  type QSORecord,
  type StrategyMessagePresentationProjection,
  type StrategyPluginContext,
  type StrategyRuntimeSnapshot,
  type PluginUIHandler,
} from '@tx5dr/plugin-api';
import type { PluginQuickSetting } from '@tx5dr/plugin-api';
import { getCallsignInfo, getStandardDigitalFrequencyMatch } from '@tx5dr/core';
import {
  ContestSessionNotifier,
  ContestSessionRepository,
  cabrilloSubmission,
  defaultContestLogbook,
  defineFT8Contest,
  distancePoints,
  fixedWeekendEdition,
  gridExchange,
  gridFieldMultiplier,
  requireExchangeAndFinalAck,
  type ContestLogbookAdapter,
  type ContestLogbookViewModel,
  type FT8ContestQso,
} from '@tx5dr/plugin-api/toolkit';
import {
  WWDigiStrategyRuntime,
  type WWDigiPracticeOperatingIndex,
  type WWDigiRuntimeConfig,
} from './WWDigiStrategyRuntime.js';
import {
  generateWWDigiCabrillo,
  isWithinWWDigiContestPeriod,
  resolveWWDigiBand,
  resolveWWDigiContestPeriod,
  resolveWWDigiLogDeadline,
  validateContestConfig,
  WW_DIGI_MAX_CONTEST_YEAR,
  WW_DIGI_MIN_CONTEST_YEAR,
  WW_DIGI_BANDS,
  type ContestConfig,
  type ContestQso,
} from './contest-log.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };
import {
  WW_DIGI_ADIF_IMPORT_MAX_BYTES,
  parseWWDigiAdifImport,
  planWWDigiAdifImport,
  summarizeWWDigiAdifImport,
  type WWDigiParsedImport,
} from './adif-import.js';
import { summarizeWWDigiScore } from './score.js';
import {
  createWWDigiContestEntry,
  readWWDigiContestEntry,
  wwDigiEditionId,
  wwDigiRulesetVersion,
  WW_DIGI_CONTEST_ID,
  WW_DIGI_RULESET_VERSION,
  type WWDigiContestEntryView,
} from './contest-entry.js';

export const BUILTIN_WW_DIGI_PLUGIN_NAME = 'ww-digi';
const DEFAULT_CONTEST_YEAR = new Date().getUTCFullYear();
type WWDigiContext = PluginContextFor<readonly ['logbook:session', 'operator:transmit-control', 'plugin:event-bus']>;

interface ContestQsoOverride {
  status?: ContestQso['status'];
  operatorId?: string;
  transmitterId?: 0 | 1;
  source?: ContestQso['source'];
}

interface WWDigiContestSession {
  schemaVersion: 3;
  revision: number;
  contestId: typeof WW_DIGI_CONTEST_ID;
  editionId: string;
  rulesetVersion: ReturnType<typeof wwDigiRulesetVersion>;
  config: ContestConfig;
  overrides: Record<string, ContestQsoOverride>;
  operatorTransmitters: Record<string, 0 | 1>;
  migratedOperators: Record<string, true>;
  health: ContestLedgerHealth;
  setup: ContestSetupState;
  operatingIndex: ContestOperatingIndex;
}

const SESSION_CHANGED_TOPIC = 'ww-digi.session.changed';
const RUNTIME_LOGBOOK_ID_PREFIX = 'contest-logbook-id:';

const practiceRuntimes = new Map<string, WWDigiStrategyRuntime>();
const ADIF_IMPORT_PREVIEW_TTL_MS = 15 * 60_000;

interface PendingAdifImport {
  operatorId: string;
  pageSessionId: string;
  contestYear: number;
  createdAt: number;
  fileName: string;
  parsed: WWDigiParsedImport;
}

const pendingAdifImports = new Map<string, PendingAdifImport>();
const legacyPageHandlers = new Map<string, PluginUIHandler>();

function prunePendingAdifImports(now = Date.now()): void {
  for (const [token, pending] of pendingAdifImports) {
    if (now - pending.createdAt > ADIF_IMPORT_PREVIEW_TTL_MS) pendingAdifImports.delete(token);
  }
}

function practiceLogbookSessionKey(operatorId: string): string {
  return `practice:${operatorId}`;
}

function contestLogbookSessionKey(contestYear: number): string {
  return `ww-digi:${contestYear}`;
}

function runtimeLogbookIdKey(contestYear: number): string {
  return `${RUNTIME_LOGBOOK_ID_PREFIX}${contestYear}`;
}

async function openContestLogbook(
  ctx: WWDigiContext,
  contestYear: number,
): Promise<PluginLogbookSessionAccess> {
  const logbook = await ctx.logbook.sessions.open({
    sessionKey: contestLogbookSessionKey(contestYear),
    stationCallsign: ctx.operator.callsign,
    title: `WW Digi ${contestYear} - ${ctx.operator.callsign.trim().toUpperCase()}`,
  });
  await logbook.awaitReady();
  const runtimeKey = runtimeLogbookIdKey(contestYear);
  if (ctx.store.operator.get<string | undefined>(runtimeKey) !== logbook.id) {
    ctx.store.operator.set(runtimeKey, logbook.id);
  }
  return logbook;
}

interface ContestLedgerHealth {
  state: 'healthy' | 'degraded' | 'unknown';
  updatedAt?: number;
  error?: string;
}

interface ContestSetupState {
  status: 'unconfirmed' | 'confirmed';
  fingerprint?: string;
  confirmedAt?: number;
  confirmedByOperatorId?: string;
}

interface ContestOperatingIndex {
  revision: number;
  contestYear: number;
  callsign: string;
  workedByBand: Record<string, string[]>;
  workedFieldsByBand: Record<string, string[]>;
}

type WWDigiIdentityContext = {
  config: Readonly<Record<string, unknown>>;
  operator: { callsign: string; grid: string; id: string };
};

function configuredContestYear(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_CONTEST_YEAR;
  const numeric = typeof value === 'number' ? value : Number(value);
  return resolveWWDigiContestPeriod(numeric).contestYear;
}

function legacyLedgerKey(contestYear: number): string {
  return `contestQsos:${contestYear}`;
}

function legacyHealthKey(contestYear: number): string {
  return `ledgerHealth:${contestYear}`;
}

function sessionKey(callsign: string, contestYear: number): string {
  return `contestSession:${callsign.trim().toUpperCase()}:${contestYear}`;
}

function createSession(ctx: WWDigiIdentityContext, _contestYear: number): WWDigiContestSession {
  return {
    schemaVersion: 3,
    revision: 0,
    contestId: WW_DIGI_CONTEST_ID,
    editionId: wwDigiEditionId(_contestYear),
    rulesetVersion: wwDigiRulesetVersion(_contestYear),
    config: seedContestConfig(ctx),
    overrides: {},
    operatorTransmitters: {},
    migratedOperators: {},
    health: { state: 'unknown' },
    setup: { status: 'unconfirmed' },
    operatingIndex: {
      revision: 0,
      contestYear: _contestYear,
      callsign: ctx.operator.callsign.trim().toUpperCase(),
      workedByBand: {},
      workedFieldsByBand: {},
    },
  };
}

function normalizeSession(
  ctx: WWDigiIdentityContext,
  contestYear: number,
  stored: Omit<Partial<WWDigiContestSession>, 'schemaVersion'> & {
    schemaVersion?: number;
    revision?: number;
  },
): WWDigiContestSession {
  const created = createSession(ctx, contestYear);
  const setup = (stored.schemaVersion === 2 || stored.schemaVersion === 3)
      && stored.setup?.status === 'confirmed'
    ? { ...stored.setup }
    : { status: 'unconfirmed' as const };
  const workedByBand = Object.fromEntries(Object.entries(stored.operatingIndex?.workedByBand ?? {})
    .filter(([, callsigns]) => Array.isArray(callsigns))
    .map(([band, callsigns]) => [band.toUpperCase(), Array.from(new Set(callsigns.map((value) => String(value).trim().toUpperCase()).filter(Boolean))).sort()]));
  const workedFieldsByBand = Object.fromEntries(Object.entries(stored.operatingIndex?.workedFieldsByBand ?? {})
    .filter(([, fields]) => Array.isArray(fields))
    .map(([band, fields]) => [band.toUpperCase(), Array.from(new Set(fields.map((value) => String(value).trim().toUpperCase()).filter((value) => /^[A-R]{2}$/.test(value)))).sort()]));
  return {
    ...created,
    config: stored.config ?? created.config,
    overrides: stored.overrides ?? {},
    operatorTransmitters: stored.operatorTransmitters ?? {},
    migratedOperators: stored.migratedOperators ?? {},
    health: stored.health ?? created.health,
    schemaVersion: 3,
    revision: stored.revision ?? 0,
    contestId: WW_DIGI_CONTEST_ID,
    editionId: wwDigiEditionId(contestYear),
    rulesetVersion: wwDigiRulesetVersion(contestYear),
    setup,
    operatingIndex: {
      revision: stored.operatingIndex?.revision ?? 0,
      contestYear,
      callsign: ctx.operator.callsign.trim().toUpperCase(),
      workedByBand,
      workedFieldsByBand,
    },
  };
}

function sessionRepository(ctx: WWDigiContext, contestYear: number) {
  const repository = new ContestSessionRepository<WWDigiContestSession>(
    ctx.store.global,
    sessionKey(ctx.operator.callsign, contestYear),
    () => createSession(ctx, contestYear),
  );
  return {
    read: () => normalizeSession(ctx, contestYear, repository.read()),
    update: (mutator: (session: WWDigiContestSession) => WWDigiContestSession) => repository.update(
      (session) => mutator(normalizeSession(ctx, contestYear, session)),
    ),
    flush: () => repository.flush(),
  };
}

function normalizedOperators(operators: readonly string[] | undefined): string[] {
  return Array.from(new Set((operators ?? []).map((value) => value.trim().toUpperCase()).filter(Boolean))).sort();
}

function sessionFingerprint(ctx: WWDigiIdentityContext, contestYear: number, config: ContestConfig): string {
  return JSON.stringify({
    callsign: ctx.operator.callsign.trim().toUpperCase(),
    contestYear,
    editionId: wwDigiEditionId(contestYear),
    rulesetVersion: wwDigiRulesetVersion(contestYear),
    grid: ctx.operator.grid.trim().toUpperCase().slice(0, 4),
    location: config.location.trim().toUpperCase(),
    categoryBand: config.categoryBand,
    categoryPower: config.categoryPower,
    categoryOperator: config.categoryOperator,
    categoryTransmitter: config.categoryTransmitter,
    operators: normalizedOperators(config.operators),
  });
}

function isSessionConfirmed(ctx: WWDigiIdentityContext, contestYear: number, session: WWDigiContestSession): boolean {
  const grid = ctx.operator.grid.trim().toUpperCase().slice(0, 4);
  if (!/^[A-R]{2}\d{2}$/.test(grid)) return false;
  if (session.config.callsign.trim().toUpperCase() !== ctx.operator.callsign.trim().toUpperCase()) return false;
  try {
    validateSessionConfig(ctx, session.config);
  } catch {
    return false;
  }
  return session.setup.status === 'confirmed'
    && session.setup.fingerprint === sessionFingerprint(ctx, contestYear, session.config);
}

function buildOperatingIndex(
  callsign: string,
  contestYear: number,
  records: readonly ContestQso[],
  revision: number,
): ContestOperatingIndex {
  const worked = new Map<string, Set<string>>();
  const workedFields = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.status === 'x-qso') continue;
    const normalized = record.callsign.trim().toUpperCase();
    if (!normalized) continue;
    const band = record.band.toUpperCase();
    const bucket = worked.get(band) ?? new Set<string>();
    bucket.add(normalized);
    worked.set(band, bucket);
    const field = record.receivedGrid?.trim().toUpperCase().slice(0, 2);
    if (field && /^[A-R]{2}$/.test(field)) {
      const fieldBucket = workedFields.get(band) ?? new Set<string>();
      fieldBucket.add(field);
      workedFields.set(band, fieldBucket);
    }
  }
  return {
    revision,
    contestYear,
    callsign: callsign.trim().toUpperCase(),
    workedByBand: Object.fromEntries(Array.from(worked, ([band, values]) => [band, Array.from(values).sort()])),
    workedFieldsByBand: Object.fromEntries(Array.from(workedFields, ([band, values]) => [band, Array.from(values).sort()])),
  };
}

function resolveContestLocation(callsign: string, configured: unknown): string {
  const location = typeof configured === 'string' ? configured.trim().toUpperCase() : '';
  const countryCode = getCallsignInfo(callsign)?.countryCode?.toUpperCase();
  if (countryCode === 'US' || countryCode === 'CA') {
    return location === 'DX' ? '' : location;
  }
  return 'DX';
}

function requiresContestSection(callsign: string): boolean {
  const countryCode = getCallsignInfo(callsign)?.countryCode?.toUpperCase();
  return countryCode === 'US' || countryCode === 'CA';
}

function validateSessionConfig(ctx: WWDigiIdentityContext, config: ContestConfig): ContestConfig {
  const normalized = validateContestConfig(config);
  const location = normalized.location.trim().toUpperCase();
  if (requiresContestSection(ctx.operator.callsign)) {
    if (!location || location === 'DX') {
      throw new Error('ARRL/RAC section is required for US and Canadian stations');
    }
  } else if (location !== 'DX') {
    throw new Error('LOCATION must be DX for stations outside the US and Canada');
  }
  return normalized;
}

function modeOf(record: QSORecord): 'FT4' | 'FT8' | null {
  const mode = record.mode.trim().toUpperCase();
  const submode = record.submode?.trim().toUpperCase();
  if (mode === 'FT4' || submode === 'FT4') return 'FT4';
  if (mode === 'FT8' || submode === 'FT8') return 'FT8';
  return null;
}

function readWWDigiContestEntryForYear(
  record: Pick<QSORecord, 'contestId' | 'contestEntry'>,
  contestYear: number,
): WWDigiContestEntryView | undefined {
  if (record.contestEntry?.editionId !== wwDigiEditionId(contestYear)
      || record.contestEntry.rulesetVersion !== wwDigiRulesetVersion(contestYear)) return undefined;
  return readWWDigiContestEntry(record);
}

function toContestQso(
  record: QSORecord,
  contestYear: number,
  existing?: ContestQso,
  includeOutsideContestPeriod = false,
): ContestQso | null {
  if (!includeOutsideContestPeriod && !isWithinWWDigiContestPeriod(record.startTime, contestYear)) return null;
  const band = resolveWWDigiBand(record.frequency);
  const mode = modeOf(record);
  const contestEntry = readWWDigiContestEntryForYear(record, contestYear);
  const contestIdentityConflict = record.contestEntry !== undefined && contestEntry === undefined;
  const myCallsign = record.myCallsign?.trim().toUpperCase();
  const sentGrid = contestEntry?.sentGrid ?? record.myGrid?.trim().toUpperCase().slice(0, 4);
  if (!band || !mode || !myCallsign || !sentGrid) return null;
  return {
    qsoId: record.id,
    callsign: record.callsign,
    myCallsign,
    sentGrid,
    receivedGrid: contestEntry?.receivedGrid ?? record.grid?.trim().toUpperCase().slice(0, 4),
    frequencyHz: Math.round(record.frequency),
    band,
    mode,
    startTime: record.startTime,
    status: contestEntry?.status ?? existing?.status
      ?? (contestIdentityConflict || !record.grid ? 'review' : 'included'),
    streamId: contestEntry?.streamId ?? existing?.streamId,
    authorizationId: contestEntry?.authorizationId ?? existing?.authorizationId,
    operatorId: contestEntry?.operatorId ?? existing?.operatorId,
    transmitterId: contestEntry?.transmitterId ?? existing?.transmitterId,
    source: contestEntry?.source ?? existing?.source
      ?? (record.contestId?.toUpperCase() === WW_DIGI_CONTEST_ID ? 'ww-digi' : 'reconciled'),
  };
}

function hasLegacyOverrideConflict(
  envelope: WWDigiContestEntryView,
  override: ContestQsoOverride,
): boolean {
  return (override.status !== undefined && envelope.status !== undefined && override.status !== envelope.status)
    || (override.operatorId !== undefined && envelope.operatorId !== undefined && override.operatorId !== envelope.operatorId)
    || (override.transmitterId !== undefined && envelope.transmitterId !== undefined
      && override.transmitterId !== envelope.transmitterId)
    || (override.source !== undefined && envelope.source !== undefined && override.source !== envelope.source);
}

function mergeLegacyOverride(
  record: QSORecord,
  qso: ContestQso,
  override: ContestQsoOverride | undefined,
  contestYear: number,
): ContestQso {
  if (!override) return qso;
  const envelope = readWWDigiContestEntryForYear(record, contestYear);
  if (!envelope) return { ...qso, ...override };
  if (envelope.legacyOverrideResolved) return qso;
  return {
    ...qso,
    status: hasLegacyOverrideConflict(envelope, override) ? 'review' : qso.status,
    operatorId: qso.operatorId ?? override.operatorId,
    transmitterId: qso.transmitterId ?? override.transmitterId,
    source: qso.source ?? override.source,
  };
}

async function markLedgerDegraded(
  ctx: WWDigiContext,
  contestYear: number,
  error: unknown,
): Promise<void> {
  const repository = sessionRepository(ctx, contestYear);
  repository.update((session) => ({
    ...session,
    health: {
      state: 'degraded',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    },
  }));
  await repository.flush().catch((flushError) => {
    ctx.log.error('WW Digi degraded health could not be flushed', flushError);
  });
}

async function readContestRecords(ctx: WWDigiContext, contestYear: number): Promise<ContestQso[]> {
  const period = resolveWWDigiContestPeriod(contestYear);
  const logbook = await openContestLogbook(ctx, contestYear);
  const session = sessionRepository(ctx, contestYear).read();
  const projected: ContestQso[] = [];
  const pageSize = 5_000;
  for (let offset = 0; ; offset += pageSize) {
    const records = await logbook.queryQSOs({
      orderDirection: 'asc', limit: pageSize, offset,
      ...(!ctx.radio.isSimulation ? {
        timeRange: { start: period.startTime, end: period.endTime - 1 },
      } : {}),
    });
    for (const record of records) {
      if (record.contestId?.toUpperCase() !== 'WW-DIGI') continue;
      const qso = toContestQso(record, contestYear, undefined, ctx.radio.isSimulation);
      if (!qso || qso.myCallsign !== ctx.operator.callsign.trim().toUpperCase()) continue;
      const merged = mergeLegacyOverride(record, qso, session.overrides[qso.qsoId], contestYear);
      projected.push({
        ...merged,
        status: session.config.categoryTransmitter === 'TWO' && merged.transmitterId === undefined && merged.status !== 'x-qso'
          ? 'review'
          : merged.status,
      });
    }
    if (records.length < pageSize) break;
  }
  return projected;
}

async function renderADIF(ctx: WWDigiContext, contestYear: number): Promise<string> {
  const period = resolveWWDigiContestPeriod(contestYear);
  const logbook = await openContestLogbook(ctx, contestYear);
  const records = await logbook.queryQSOs({
    orderDirection: 'asc',
    ...(!ctx.radio.isSimulation ? {
      timeRange: { start: period.startTime, end: period.endTime - 1 },
    } : {}),
  });
  const selected = records.filter((record) => (
    record.contestId?.toUpperCase() === 'WW-DIGI'
      && record.myCallsign?.trim().toUpperCase() === ctx.operator.callsign.trim().toUpperCase()
  ));
  const session = sessionRepository(ctx, contestYear).read();
  for (const record of selected) {
    const projected = toContestQso(record, contestYear, undefined, ctx.radio.isSimulation);
    if (!projected || !readWWDigiContestEntryForYear(record, contestYear)) {
      throw new Error(`WW Digi QSO ${record.id} requires review before export`);
    }
    const merged = mergeLegacyOverride(
      record,
      projected,
      session.overrides[record.id],
      contestYear,
    );
    if (merged.status === 'review'
        || (session.config.categoryTransmitter === 'TWO' && merged.transmitterId === undefined)) {
      throw new Error(`WW Digi QSO ${record.id} requires review before export`);
    }
  }
  return generateADIFFile(selected, {
    programId: 'TX5DR-WW-DIGI',
    includeStationCallsign: true,
  });
}

async function commitAdifImport(
  ctx: WWDigiContext,
  contestYear: number,
  pending: PendingAdifImport,
  confirmations: { stationCallsign: boolean; stationGrid: boolean },
): Promise<{
  imported: number;
  merged: number;
  duplicates: number;
  rejected: number;
  review: number;
}> {
  const logbook = await openContestLogbook(ctx, contestYear);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await logbook.readQsoSnapshot();
    const plan = planWWDigiAdifImport(pending.parsed.candidates, snapshot.records, confirmations);
    if (plan.withheld > 0) throw new Error('adif_import_confirmation_required');
    try {
      const batch = await logbook.applyQsoBatch(
        plan.items.map((item) => item.mutation),
        { expectedRevision: snapshot.revision },
      );
      await refreshContestProjectionWithHealth(ctx, contestYear);
      notifyContestLogChanged(ctx, contestYear);
      return {
        imported: batch.outcomes.filter((outcome) => outcome.status === 'added').length,
        merged: batch.outcomes.filter((outcome) => outcome.status === 'updated').length,
        duplicates: plan.duplicates,
        rejected: pending.parsed.rejected.length,
        review: plan.items.filter((item) => item.candidate.reviewIssues.length > 0).length,
      };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'LOGBOOK_REVISION_CONFLICT') {
        if (attempt < 2) continue;
        throw new Error('adif_import_revision_conflict');
      }
      throw error;
    }
  }
  throw new Error('adif_import_revision_conflict');
}

async function updateContestRecordEntry(
  ctx: WWDigiContext,
  contestYear: number,
  qsoId: string,
  mutate: (current: WWDigiContestEntryView) => WWDigiContestEntryView,
): Promise<QSORecord> {
  const logbook = await openContestLogbook(ctx, contestYear);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await logbook.readQsoSnapshot();
    const record = snapshot.records.find((candidate) => candidate.id === qsoId);
    if (!record) throw new Error('Unknown contest QSO');
    const fallback = sessionRepository(ctx, contestYear).read().overrides[qsoId];
    const projected = toContestQso(record, contestYear, undefined, ctx.radio.isSimulation);
    if (!projected) throw new Error('Invalid contest QSO');
    const qso = mergeLegacyOverride(record, projected, fallback, contestYear);
    const existing = readWWDigiContestEntryForYear(record, contestYear);
    const current: WWDigiContestEntryView = existing ?? {
      sentGrid: qso.sentGrid,
      receivedGrid: qso.receivedGrid,
      status: qso.status,
      source: qso.source,
      streamId: qso.streamId,
      authorizationId: qso.authorizationId,
      operatorId: qso.operatorId,
      transmitterId: qso.transmitterId,
      practice: false,
      legacyOverrideResolved: false,
    };
    const next = mutate(structuredClone(current));
    try {
      const result = await logbook.applyQsoBatch([{
        type: 'update',
        qsoId,
        updates: {
          contestId: WW_DIGI_CONTEST_ID,
          contestEntry: createWWDigiContestEntry({
            contestYear,
            sentGrid: next.sentGrid ?? qso.sentGrid,
            receivedGrid: next.receivedGrid,
            status: next.status ?? 'review',
            source: next.source ?? 'reconciled',
            streamId: next.streamId,
            authorizationId: next.authorizationId,
            operatorId: next.operatorId,
            transmitterId: next.transmitterId,
            practice: next.practice,
            legacyOverrideResolved: next.legacyOverrideResolved || fallback !== undefined,
          }),
        },
      }], { expectedRevision: snapshot.revision });
      return result.outcomes[0]!.record;
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'LOGBOOK_REVISION_CONFLICT' && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error('LOGBOOK_REVISION_CONFLICT');
}

async function refreshContestProjection(
  ctx: WWDigiContext,
  contestYear: number,
): Promise<{ total: number; claimedScore: number }> {
  const records = await readContestRecords(ctx, contestYear);
  const repository = sessionRepository(ctx, contestYear);
  const claimedScore = summarizeWWDigiScore(records, repository.read().config.categoryBand).claimedScore;
  repository.update((session) => ({
    ...session,
    health: { state: 'healthy', updatedAt: Date.now() },
    operatingIndex: buildOperatingIndex(
      ctx.operator.callsign,
      contestYear,
      records,
      session.operatingIndex.revision + 1,
    ),
  }));
  await repository.flush();
  return { total: records.length, claimedScore };
}

async function refreshContestProjectionWithHealth(
  ctx: WWDigiContext,
  contestYear: number,
): Promise<{ total: number; claimedScore: number }> {
  try {
    return await refreshContestProjection(ctx, contestYear);
  } catch (error) {
    await markLedgerDegraded(ctx, contestYear, error);
    throw error;
  }
}

async function renderCabrillo(ctx: WWDigiContext, contestYear: number): Promise<string> {
  const repository = sessionRepository(ctx, contestYear);
  if (repository.read().health.state !== 'healthy') {
    await refreshContestProjectionWithHealth(ctx, contestYear);
  }
  const session = repository.read();
  const health = session.health;
  if (health.state !== 'healthy') {
    throw new Error(health.error
      ? `WW Digi ${contestYear} log is unavailable: ${health.error}`
      : `WW Digi ${contestYear} log is unavailable`);
  }
  if (!isSessionConfirmed(ctx, contestYear, session)) {
    throw new Error(`WW Digi ${contestYear} contest settings are not confirmed`);
  }
  return generateWWDigiCabrillo(session.config, await readContestRecords(ctx, contestYear));
}

function notifyLocalContestLogChanged(ctx: WWDigiContext): void {
  for (const session of ctx.ui.listActivePageSessions('contest-log')) {
    ctx.ui.pushToSession(session.sessionId, 'stateChanged');
  }
}

function notifyContestLogChanged(ctx: WWDigiContext, contestYear: number): void {
  notifyLocalContestLogChanged(ctx);
  ctx.ui.refreshOperatorProjection();
  new ContestSessionNotifier(ctx.eventBus, SESSION_CHANGED_TOPIC).publish({
    callsign: ctx.operator.callsign.trim().toUpperCase(),
    contestYear,
  });
}

function seedContestConfig(ctx: WWDigiIdentityContext): ContestConfig {
  return {
    callsign: ctx.operator.callsign,
    location: resolveContestLocation(ctx.operator.callsign, ctx.config.location),
    categoryBand: typeof ctx.config.categoryBand === 'string'
      ? ctx.config.categoryBand as ContestConfig['categoryBand']
      : 'ALL',
    categoryPower: typeof ctx.config.categoryPower === 'string'
      ? ctx.config.categoryPower as ContestConfig['categoryPower']
      : 'LOW',
    categoryOperator: typeof ctx.config.categoryOperator === 'string'
      ? ctx.config.categoryOperator as ContestConfig['categoryOperator']
      : 'SINGLE-OP',
    categoryTransmitter: typeof ctx.config.categoryTransmitter === 'string'
      ? ctx.config.categoryTransmitter as ContestConfig['categoryTransmitter']
      : 'ONE',
    operators: typeof ctx.config.operators === 'string'
      ? ctx.config.operators.split(/[\s,]+/).map((value) => value.trim().toUpperCase()).filter(Boolean)
      : [],
    createdBy: 'TX-5DR WW Digi',
  };
}

function runtimeSession(ctx: StrategyPluginContext, contestYear: number): WWDigiContestSession {
  const stored = ctx.store.global.get<Partial<WWDigiContestSession> & { schemaVersion?: number; revision?: number }>(
    sessionKey(ctx.operator.callsign, contestYear),
    {},
  );
  return normalizeSession(ctx, contestYear, stored);
}

function practiceModeName(ctx: StrategyPluginContext): 'FT8' | 'FT4' {
  return ctx.operator.mode.name.trim().toUpperCase() === 'FT4' ? 'FT4' : 'FT8';
}

function canStartPractice(ctx: StrategyPluginContext, contestYear: number): boolean {
  return !ctx.radio.isSimulation
    && Boolean(resolveWWDigiBand(ctx.radio.frequency))
    && !isWithinWWDigiContestPeriod(Date.now(), contestYear)
    && !getStandardDigitalFrequencyMatch(practiceModeName(ctx), ctx.radio.frequency);
}

function runtimePresentation(
  ctx: StrategyPluginContext,
  practiceEnabled = false,
  practiceIndex?: WWDigiPracticeOperatingIndex,
): Pick<
  StrategyRuntimeSnapshot,
  'actions' | 'attentions' | 'messagePresentation' | 'transmitGate'
> {
  const contestYear = configuredContestYear(ctx.config.contestYear);
  const session = runtimeSession(ctx, contestYear);
  const operatingIndex = practiceEnabled
    ? practiceIndex ?? buildOperatingIndex(ctx.operator.callsign, contestYear, [], 0)
    : session.operatingIndex;
  const callableMessageMatchers = [
    { firstTokenIn: ['CQ'] },
    { anyTokenIn: ['RR73', 'RRR', '73'] },
  ];
  const messagePresentation: StrategyMessagePresentationProjection = {
    revision: operatingIndex.revision,
    mode: 'replace-logbook',
    subject: 'sender-callsign',
    partitionBy: 'band',
    eligiblePartitions: [...WW_DIGI_BANDS],
    defaultClass: 'contest-new-call',
    classes: {
      'contest-new-field': {
        badges: [{ label: 'contestNewGridField', tone: 'secondary' }],
        row: { tone: 'secondary', background: 'soft', accent: true },
        emphasisWhen: callableMessageMatchers,
      },
      'contest-new-call': {
        badges: [{ label: 'contestNewCallsign', tone: 'warning' }],
        row: { tone: 'warning', background: 'soft', accent: true },
        emphasisWhen: callableMessageMatchers,
      },
      'contest-worked': { textDecoration: 'line-through', opacity: 'muted' },
    },
    assignments: Object.entries(operatingIndex.workedByBand).flatMap(([band, callsigns]) => (
      callsigns.map((subject) => ({ subject, partition: band, classId: 'contest-worked' }))
    )),
    noveltyRules: [{
      fact: 'grid-field-2',
      knownValuesByPartition: operatingIndex.workedFieldsByBand,
      classId: 'contest-new-field',
    }],
  };
  const confirmed = isSessionConfirmed(ctx, contestYear, session);
  const sessionGateReason = !confirmed
    ? 'transmitBlockedSetupUnconfirmed'
    : session.health.state !== 'healthy'
      ? 'transmitBlockedLedgerUnhealthy'
      : undefined;
  if (sessionGateReason) {
    return {
      messagePresentation,
      transmitGate: { allowed: false, reason: sessionGateReason, actionId: 'open-contest-settings' },
      actions: [{
        id: 'open-contest-settings',
        label: 'actionOpenContestSettings',
        icon: 'file-lines',
        tone: 'warning',
        presentation: 'primary',
        navigation: { kind: 'plugin-page', pageId: 'contest-log' },
      }],
      attentions: [{
        id: `contest-session-gate:${contestYear}:${sessionGateReason}`,
        tone: session.health.state === 'degraded' ? 'danger' : 'warning',
        title: !confirmed ? 'attentionContestSetupRequired' : 'attentionContestLedgerUnhealthy',
        description: !confirmed ? 'attentionContestSetupRequiredDesc' : 'attentionContestLedgerUnhealthyDesc',
        actionIds: ['open-contest-settings'],
      }],
    };
  }

  const operatingGate = !resolveWWDigiBand(ctx.radio.frequency)
    ? {
        reason: 'transmitBlockedBand',
        title: 'attentionContestBandUnavailable',
        description: 'attentionContestBandUnavailableDesc',
      }
    : !ctx.radio.isSimulation && !practiceEnabled && !isWithinWWDigiContestPeriod(Date.now(), contestYear)
      ? {
          reason: 'transmitBlockedOutsidePeriod',
          title: 'attentionContestOutsidePeriod',
          description: 'attentionContestOutsidePeriodDesc',
        }
      : undefined;
  if (!operatingGate) {
    return practiceEnabled ? {
      messagePresentation,
      actions: [{
        id: 'stop-practice', label: 'actionStopPractice', icon: 'xmark',
        tone: 'warning', presentation: 'secondary',
      }],
      attentions: [{
        id: `contest-practice:${contestYear}`,
        tone: 'warning', title: 'attentionContestOutsidePeriod',
        description: 'attentionContestOutsidePeriodDesc', actionIds: ['stop-practice'],
      }],
    } : { messagePresentation };
  }
  const practiceAvailable = operatingGate.reason === 'transmitBlockedOutsidePeriod'
    && canStartPractice(ctx, contestYear);
  return {
    messagePresentation,
    transmitGate: { allowed: false, reason: operatingGate.reason },
    actions: practiceAvailable ? [{
      id: 'start-practice', label: 'actionStartPractice', icon: 'flask-conical',
      tone: 'warning', presentation: 'secondary',
      confirmation: {
        title: 'practiceConfirmTitle',
        description: 'practiceConfirmDescription',
        confirmLabel: 'practiceConfirmAction',
        cancelLabel: 'practiceConfirmCancel',
      },
    }] : undefined,
    attentions: [{
      id: `contest-operating-gate:${contestYear}:${operatingGate.reason}`,
      tone: 'warning',
      title: operatingGate.title,
      description: operatingGate.description,
      actionIds: practiceAvailable ? ['start-practice'] : undefined,
    }],
  };
}

function hasWorkedInRuntimeSession(
  ctx: StrategyPluginContext,
  callsign: string,
  practiceEnabled = false,
  practiceIndex?: WWDigiPracticeOperatingIndex,
): boolean {
  const contestYear = configuredContestYear(ctx.config.contestYear);
  const session = practiceEnabled
    ? practiceIndex ?? buildOperatingIndex(ctx.operator.callsign, contestYear, [], 0)
    : runtimeSession(ctx, contestYear).operatingIndex;
  const band = ctx.radio.band.trim().toUpperCase();
  return (session.workedByBand[band] ?? []).includes(callsign.trim().toUpperCase());
}

function parallelStreams(value: unknown, fallback = 1): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(3, Math.trunc(numeric))) : fallback;
}

export const wwDigiQuickSettings: PluginQuickSetting[] = [
  { settingKey: 'parallelStreams' },
  { settingKey: 'replaceQueueOnManualTarget' },
  { settingKey: 'maxAttempts' },
  { settingKey: 'cqMaxAttempts' },
  { settingKey: 'cqSelectionPolicy' },
  { settingKey: 'authorizedStaleReceiveCycles' },
];

const wwDigiBasePlugin = definePlugin({
  apiVersion: 2,
  name: BUILTIN_WW_DIGI_PLUGIN_NAME,
  version: '1.0.0',
  type: 'strategy',
  description: 'WW Digi FT8/FT4 contest workflow with operator-selected parallel QSOs',
  strategyFeatures: {
    targetQueue: 1,
    parallelTargetQueue: 1,
    queueActivation: 'immediate',
    manualInitiation: 1,
    maxConcurrentStreams: 3,
  },
  simulationScenarios: wwDigiSimulationScenarios,
  permissions: ['logbook:session', 'operator:transmit-control', 'plugin:event-bus'],
  storage: { scopes: ['global', 'operator'] },
  settings: {
    strategyOverview: { type: 'info', default: '', label: 'strategyOverview', description: 'strategyOverviewDesc', scope: 'operator' },
    contestYear: {
      type: 'number', default: DEFAULT_CONTEST_YEAR, label: 'contestYear', description: 'contestYearDesc', scope: 'operator',
      min: WW_DIGI_MIN_CONTEST_YEAR, max: WW_DIGI_MAX_CONTEST_YEAR,
    },
    parallelStreams: { type: 'number', default: 1, label: 'parallelStreams', description: 'parallelStreamsDesc', scope: 'operator', min: 1, max: 3 },
    replaceQueueOnManualTarget: {
      type: 'boolean', default: false, label: 'replaceQueueOnManualTarget',
      description: 'replaceQueueOnManualTargetDesc', scope: 'operator',
    },
    maxAttempts: { type: 'number', default: 5, label: 'maxAttempts', description: 'maxAttemptsDesc', scope: 'operator', min: 1, max: 20 },
    cqMaxAttempts: {
      type: 'number', default: 6, label: 'cqMaxAttempts', description: 'cqMaxAttemptsDesc', scope: 'operator', min: 1, max: 20,
    },
    cqSelectionPolicy: {
      type: 'string', default: 'MAX_DISTANCE', label: 'cqSelectionPolicy', description: 'cqSelectionPolicyDesc', scope: 'operator',
      options: ['FIRST', 'MAX_DISTANCE', 'MAX_SNR', 'MIN_SNR'].map((value) => ({ label: `selection${value}`, value })),
    },
    authorizedStaleReceiveCycles: {
      type: 'number', default: 12, label: 'authorizedStaleReceiveCycles', description: 'authorizedStaleReceiveCyclesDesc', scope: 'operator', min: 1, max: 60,
    },
    location: { type: 'string', default: '', label: 'location', description: 'locationDesc', scope: 'operator' },
    categoryBand: {
      type: 'string', default: 'ALL', label: 'categoryBand', description: 'categoryBandDesc', scope: 'operator',
      options: ['ALL', '160M', '80M', '40M', '20M', '15M', '10M'].map((value) => ({ label: value, value })),
    },
    categoryPower: {
      type: 'string', default: 'LOW', label: 'categoryPower', description: 'categoryPowerDesc', scope: 'operator',
      options: ['HIGH', 'LOW', 'QRP'].map((value) => ({ label: value, value })),
    },
    categoryOperator: {
      type: 'string', default: 'SINGLE-OP', label: 'categoryOperator', description: 'categoryOperatorDesc', scope: 'operator',
      options: ['SINGLE-OP', 'MULTI-OP', 'CHECKLOG'].map((value) => ({ label: value, value })),
    },
    categoryTransmitter: {
      type: 'string', default: 'ONE', label: 'categoryTransmitter', description: 'categoryTransmitterDesc', scope: 'operator',
      options: ['ONE', 'TWO', 'UNLIMITED'].map((value) => ({ label: value, value })),
    },
    operators: { type: 'string', default: '', label: 'operators', description: 'operatorsDesc', scope: 'operator' },
    transmitterId: {
      type: 'number', default: 0, label: 'transmitterId', description: 'transmitterIdDesc', scope: 'operator', min: 0, max: 1,
    },
  },
  quickSettings: wwDigiQuickSettings,
  panels: [{
    id: 'contest-log', title: 'contestLogTitle', component: 'iframe', pageId: 'contest-log',
    slot: 'operator-action', openMode: 'page', icon: 'file-lines',
  }],
  ui: {
    dir: 'ui',
    pages: [{
      id: 'contest-log', title: 'contestLogTitle', entry: 'contest-log.html', accessScope: 'operator', resourceBinding: 'operator',
    }],
  },
  createStrategyRuntime(ctx) {
    const resolveBaseFrequency = () => Math.max(
      300,
      Math.min(4700, Math.round(ctx.operator.frequency || 1500)),
    );
    const runtimeRef: { current?: WWDigiStrategyRuntime } = {};
    const operator = {
      get config(): WWDigiRuntimeConfig {
        const modeName = ctx.operator.mode.name.toUpperCase() === 'FT4' ? 'FT4' : 'FT8';
        const base = resolveBaseFrequency();
        return {
          myCallsign: ctx.operator.callsign,
          myGrid: ctx.operator.grid.slice(0, 4).toUpperCase(),
          frequency: base,
          modeName,
          contestYear: configuredContestYear(ctx.config.contestYear),
          operatorId: ctx.operator.id,
          transmitterId: Number(ctx.config.transmitterId) === 1 ? 1 : 0,
          slotMs: ctx.operator.mode.slotMs,
          transmitCycles: [...ctx.operator.transmitCycles],
          parallelStreams: parallelStreams(ctx.config.parallelStreams),
          replaceQueueOnManualTarget: ctx.config.replaceQueueOnManualTarget === true,
          maxConcurrentStreams: ctx.operator.maxConcurrentStreams,
          maxAttempts: Math.max(1, Math.min(20, Math.trunc(Number(ctx.config.maxAttempts) || 5))),
          cqMaxAttempts: Math.max(1, Math.min(20, Math.trunc(Number(ctx.config.cqMaxAttempts) || 6))),
          cqSelectionPolicy: ['FIRST', 'MAX_DISTANCE', 'MAX_SNR', 'MIN_SNR'].includes(String(ctx.config.cqSelectionPolicy))
            ? String(ctx.config.cqSelectionPolicy) as WWDigiRuntimeConfig['cqSelectionPolicy'] : 'MAX_DISTANCE',
          authorizedStaleReceiveCycles: Math.max(1, Math.min(60, Math.trunc(Number(ctx.config.authorizedStaleReceiveCycles) || 12))),
        };
      },
      get isTransmitting() { return ctx.operator.isTransmitting; },
      isTargetBeingWorkedByOthers(callsign: string) {
        return ctx.operator.isTargetBeingWorkedByOthers(callsign);
      },
      hasWorkedCallsign(callsign: string) {
        const runtime = runtimeRef.current;
        return Promise.resolve(hasWorkedInRuntimeSession(
          ctx,
          callsign,
          runtime?.isPracticeEnabled() === true,
          runtime?.getPracticeOperatingIndex(),
        ));
      },
    };
    const runtime = new WWDigiStrategyRuntime(operator, ctx.log, () => {
      const base = resolveBaseFrequency();
      return [base - 100, base, base + 100];
    }, async (text, mode) => ctx.digitalMessagePreflight.check({ text, mode }), () => (
      runtimePresentation(
        ctx,
        runtimeRef.current?.isPracticeEnabled() === true,
        runtimeRef.current?.getPracticeOperatingIndex(),
      )
    ), () => {
      const contestYear = configuredContestYear(ctx.config.contestYear);
      if (runtimeRef.current?.isPracticeEnabled()) {
        return { kind: 'plugin-session-key', sessionKey: practiceLogbookSessionKey(ctx.operator.id) };
      }
      const sessionId = ctx.store.operator.get<string | undefined>(runtimeLogbookIdKey(contestYear));
      if (!sessionId) throw new Error('WW Digi logbook session is not ready');
      return { kind: 'plugin-session', sessionId };
    }, {
      canStart: () => canStartPractice(ctx, configuredContestYear(ctx.config.contestYear)),
      sessionKey: practiceLogbookSessionKey(ctx.operator.id),
      title: `WW Digi Practice - ${ctx.operator.callsign.trim().toUpperCase()}`,
    });
    runtimeRef.current = runtime;
    practiceRuntimes.set(ctx.operator.id, runtime);
    return runtime;
  },
  isTransmitControlEnabled: () => true,
  async onLoad(ctx) {
    const typed = ctx as WWDigiContext;
    const contestYear = configuredContestYear(typed.config.contestYear);
    await openContestLogbook(typed, contestYear);
    const notifier = new ContestSessionNotifier<{ callsign: string; contestYear: number }>(typed.eventBus, SESSION_CHANGED_TOPIC);
    notifier.subscribe((event) => {
      const activeContestYear = configuredContestYear(typed.config.contestYear);
      if (event.callsign === typed.operator.callsign.trim().toUpperCase()
          && event.contestYear === activeContestYear) {
        notifyLocalContestLogChanged(typed);
        typed.ui.refreshOperatorProjection();
      }
    });
    await refreshContestProjection(typed, contestYear).catch(async (error) => {
      await markLedgerDegraded(typed, contestYear, error);
      typed.log.warn('WW Digi ledger reconciliation failed', { error: error instanceof Error ? error.message : String(error) });
    });
    typed.ui.refreshOperatorProjection();
    const handler: PluginUIHandler = {
      async onMessage(pageId, action, data, requestContext) {
        if (pageId !== 'contest-log') throw new Error(`Unknown page: ${pageId}`);
        const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const selectedYear = configuredContestYear(typed.config.contestYear);
        if (action === 'previewADIFImport') {
          prunePendingAdifImports();
          const uploadPath = typeof payload.path === 'string' ? payload.path : '';
          if (!uploadPath.startsWith('imports/')) throw new Error('adif_import_path_invalid');
          const uploaded = await requestContext.files.read(uploadPath);
          await requestContext.files.delete(uploadPath).catch(() => false);
          if (!uploaded) throw new Error('adif_import_file_missing');
          if (uploaded.byteLength > WW_DIGI_ADIF_IMPORT_MAX_BYTES) throw new Error('adif_import_file_too_large');
          if (!/^[A-R]{2}\d{2}$/.test(typed.operator.grid.trim().toUpperCase().slice(0, 4))) {
            throw new Error('adif_import_station_grid_invalid');
          }
          const parsed = parseWWDigiAdifImport(uploaded.toString('utf8'), {
            contestYear: selectedYear,
            stationCallsign: typed.operator.callsign,
            stationGrid: typed.operator.grid,
            requireTransmitterId: sessionRepository(typed, selectedYear).read().config.categoryTransmitter === 'TWO',
          });
          const logbook = await openContestLogbook(typed, selectedYear);
          const snapshot = await logbook.readQsoSnapshot();
          const token = randomUUID();
          pendingAdifImports.set(token, {
            operatorId: typed.operator.id,
            pageSessionId: requestContext.pageSessionId,
            contestYear: selectedYear,
            createdAt: Date.now(),
            fileName: typeof payload.fileName === 'string' ? payload.fileName.slice(0, 128) : 'log.adi',
            parsed,
          });
          return {
            token,
            fileName: pendingAdifImports.get(token)!.fileName,
            summary: summarizeWWDigiAdifImport(parsed, snapshot.records),
          };
        }
        if (action === 'cancelADIFImport') {
          const token = typeof payload.token === 'string' ? payload.token : '';
          const pending = pendingAdifImports.get(token);
          if (pending?.operatorId === typed.operator.id
              && pending.pageSessionId === requestContext.pageSessionId) {
            pendingAdifImports.delete(token);
          }
          return { cancelled: true };
        }
        if (action === 'commitADIFImport') {
          prunePendingAdifImports();
          const token = typeof payload.token === 'string' ? payload.token : '';
          const pending = pendingAdifImports.get(token);
          if (!pending
              || pending.operatorId !== typed.operator.id
              || pending.pageSessionId !== requestContext.pageSessionId
              || pending.contestYear !== selectedYear) {
            throw new Error('adif_import_preview_expired');
          }
          try {
            const result = await commitAdifImport(typed, selectedYear, pending, {
              stationCallsign: payload.confirmStationCallsign === true,
              stationGrid: payload.confirmStationGrid === true,
            });
            pendingAdifImports.delete(token);
            return result;
          } catch (error) {
            if ((error as Error).message.startsWith('adif_import_')) throw error;
            await markLedgerDegraded(typed, selectedYear, error);
            notifyContestLogChanged(typed, selectedYear);
            throw error;
          }
        }
        if (action === 'getState') {
          const period = resolveWWDigiContestPeriod(selectedYear);
          const repository = sessionRepository(typed, selectedYear);
          if (repository.read().health.state !== 'healthy') {
            await refreshContestProjectionWithHealth(typed, selectedYear);
          }
          const session = repository.read();
          return {
            config: session.config,
            contestYear: selectedYear,
            period,
            deadline: resolveWWDigiLogDeadline(selectedYear),
            records: await readContestRecords(typed, selectedYear),
            health: session.health,
            station: {
              callsign: typed.operator.callsign.trim().toUpperCase(),
              grid: typed.operator.grid.trim().toUpperCase().slice(0, 4),
              requiresSection: requiresContestSection(typed.operator.callsign),
            },
            setup: {
              ...session.setup,
              status: isSessionConfirmed(typed, selectedYear, session) ? 'confirmed' : 'unconfirmed',
            },
          };
        }
        if (action === 'renderCabrillo') {
          return { text: await renderCabrillo(typed, selectedYear) };
        }
        if (action === 'renderADIF') {
          return { text: await renderADIF(typed, selectedYear) };
        }
        if (action === 'setStatus') {
          const qsoId = typeof payload.qsoId === 'string' ? payload.qsoId : '';
          const status = payload.status === 'x-qso' ? 'x-qso'
            : payload.status === 'review' ? 'review' : 'included';
          await updateContestRecordEntry(typed, selectedYear, qsoId, (entry) => ({ ...entry, status }));
          await refreshContestProjectionWithHealth(typed, selectedYear);
          notifyContestLogChanged(typed, selectedYear);
          return { records: await readContestRecords(typed, selectedYear) };
        }
        if (action === 'setTransmitter') {
          const qsoId = typeof payload.qsoId === 'string' ? payload.qsoId : '';
          const transmitterId = payload.transmitterId === 1 ? 1 : payload.transmitterId === 0 ? 0 : undefined;
          if (transmitterId === undefined) throw new Error('Invalid transmitter ID');
          await updateContestRecordEntry(typed, selectedYear, qsoId, (entry) => ({
            ...entry,
            transmitterId,
            status: 'included',
          }));
          await refreshContestProjectionWithHealth(typed, selectedYear);
          notifyContestLogChanged(typed, selectedYear);
          return { records: await readContestRecords(typed, selectedYear) };
        }
        if (action === 'updateSession') {
          const repository = sessionRepository(typed, selectedYear);
          repository.update((session) => {
            const config = validateSessionConfig(typed, {
              ...session.config,
              callsign: typed.operator.callsign.trim().toUpperCase(),
              ...(typeof payload.location === 'string' ? { location: payload.location } : {}),
              ...(typeof payload.categoryBand === 'string' ? { categoryBand: payload.categoryBand as ContestConfig['categoryBand'] } : {}),
              ...(typeof payload.categoryPower === 'string' ? { categoryPower: payload.categoryPower as ContestConfig['categoryPower'] } : {}),
              ...(typeof payload.categoryOperator === 'string' ? { categoryOperator: payload.categoryOperator as ContestConfig['categoryOperator'] } : {}),
              ...(typeof payload.categoryTransmitter === 'string' ? { categoryTransmitter: payload.categoryTransmitter as ContestConfig['categoryTransmitter'] } : {}),
              ...(Array.isArray(payload.operators) ? { operators: payload.operators.filter((value): value is string => typeof value === 'string') } : {}),
            });
            const grid = typed.operator.grid.trim().toUpperCase().slice(0, 4);
            if (!/^[A-R]{2}\d{2}$/.test(grid)) {
              throw new Error('Operator grid must be a four-character Maidenhead grid');
            }
            return {
              ...session,
              config,
              setup: {
                status: 'confirmed',
                fingerprint: sessionFingerprint(typed, selectedYear, config),
                confirmedAt: Date.now(),
                confirmedByOperatorId: typed.operator.id,
              },
            };
          });
          await repository.flush();
          notifyContestLogChanged(typed, selectedYear);
          const session = repository.read();
          return { config: session.config, setup: session.setup };
        }
        throw new Error(`Unknown action: ${action}`);
      },
    };
    legacyPageHandlers.set(typed.operator.id, handler);
    typed.ui.registerPageHandler(handler);
  },
  onUnload(ctx) {
    const typed = ctx as WWDigiContext;
    for (const [token, pending] of pendingAdifImports) {
      if (pending.operatorId === typed.operator.id) pendingAdifImports.delete(token);
    }
    practiceRuntimes.delete(typed.operator.id);
    legacyPageHandlers.delete(typed.operator.id);
  },
  hooks: {
    async onConfigChange(changes, ctx) {
      if (!Object.prototype.hasOwnProperty.call(changes, 'contestYear')) return;
      const typed = ctx as WWDigiContext;
      practiceRuntimes.get(typed.operator.id)?.revokePractice();
      await typed.logbook.sessions.destroy(practiceLogbookSessionKey(typed.operator.id));
      const contestYear = configuredContestYear(typed.config.contestYear);
      await openContestLogbook(typed, contestYear);
      await refreshContestProjectionWithHealth(typed, contestYear);
      notifyContestLogChanged(typed, contestYear);
    },
    async onQSOComplete(record, ctx) {
      const typed = ctx as WWDigiContext;
      if (record.contestId?.toUpperCase() !== 'WW-DIGI') return;
      const selectedYear = configuredContestYear(typed.config.contestYear);
      const runtime = practiceRuntimes.get(typed.operator.id);
      const isPracticeQso = readWWDigiContestEntry(record)?.practice === true;
      if (isPracticeQso) {
        if (!runtime?.isPracticeEnabled()) return;
        const logbook = await typed.logbook.sessions.open({
          sessionKey: practiceLogbookSessionKey(typed.operator.id),
          stationCallsign: typed.operator.callsign,
          title: `WW Digi Practice - ${typed.operator.callsign.trim().toUpperCase()}`,
          retention: 'runtime',
        });
        const records = await logbook.queryQSOs({ orderDirection: 'asc' });
        const projected = records.flatMap((practiceRecord) => {
          if (practiceRecord.contestId?.toUpperCase() !== 'WW-DIGI') return [];
          const qso = toContestQso(practiceRecord, selectedYear, undefined, true);
          return qso ? [qso] : [];
        });
        const previous = runtime.getPracticeOperatingIndex()
          ?? buildOperatingIndex(typed.operator.callsign, selectedYear, [], 0);
        runtime.setPracticeOperatingIndex(buildOperatingIndex(
          typed.operator.callsign,
          selectedYear,
          projected,
          previous.revision + 1,
        ));
        runtime.notifyQsoLogged(
          record.id,
          record.callsign,
          record.grid,
          summarizeWWDigiScore(projected, String(typed.config.categoryBand ?? 'ALL')).claimedScore,
        );
        typed.ui.refreshOperatorProjection();
        return;
      }
      const contestYear = new Date(record.startTime).getUTCFullYear();
      const contestQso = toContestQso(record, contestYear, undefined, typed.radio.isSimulation);
      if (!contestQso) return;
      try {
        const transmitterId = Number(typed.config.transmitterId) === 1 ? 1 : 0;
        if (!readWWDigiContestEntry(record)) {
          await updateContestRecordEntry(typed, contestYear, record.id, (entry) => ({
            ...entry,
            status: contestQso.status,
            operatorId: typed.operator.id,
            transmitterId,
            source: record.messageHistory.length > 0 ? 'standard' : 'manual',
          }));
        }
        const projection = await refreshContestProjectionWithHealth(typed, contestYear);
        runtime?.notifyQsoLogged(record.id, record.callsign, record.grid, projection.claimedScore);
        notifyContestLogChanged(typed, contestYear);
      } catch (error) {
        await markLedgerDegraded(typed, contestYear, error);
        notifyContestLogChanged(typed, contestYear);
        await typed.operatorCommands.submit({ type: 'stop-automation' });
        throw error;
      }
    },
  },
});

type WWDigiFrameworkQso = FT8ContestQso<{ grid: string }> & {
  operatorCallsign?: string;
  operatorGrid?: string;
  frequencyHz?: number;
};

const wwDigiFrameworkContest = defineFT8Contest<{ grid: string }, WWDigiFrameworkQso>({
  id: WW_DIGI_CONTEST_ID,
  rulesetVersion: WW_DIGI_RULESET_VERSION,
  edition: fixedWeekendEdition({
    id: wwDigiEditionId(DEFAULT_CONTEST_YEAR),
    startAt: new Date(resolveWWDigiContestPeriod(DEFAULT_CONTEST_YEAR).startTime),
    endAt: new Date(resolveWWDigiContestPeriod(DEFAULT_CONTEST_YEAR).endTime),
    source: { url: 'https://ww-digi.com/rules/' },
  }),
  modes: ['FT8', 'FT4'],
  bands: WW_DIGI_BANDS,
  exchange: gridExchange(),
  completion: requireExchangeAndFinalAck(),
  scoring: distancePoints<WWDigiFrameworkQso>({
    stepKm: 3_000,
    multiplierKeys: gridFieldMultiplier({
      grid: (qso) => qso.receivedExchange?.grid,
      band: (qso) => qso.band,
    }),
  }),
  submission: cabrilloSubmission<WWDigiFrameworkQso>({
    headers: () => [['CONTEST', 'WW-DIGI']],
    qsoLine: (qso) => `QSO: ${qso.frequencyHz ?? 0} DG ${new Date(qso.startTime).toISOString()} ${qso.callsign}`,
  }),
  operating: {
    humanInitiation: 'required',
    maxConcurrentQsos: 3,
    maxSimultaneousSignals: 3,
    cycleRelation: 'any',
  },
});

const wwDigiContestLogbookSettings = {
  settings: {
    contestYear: { type: 'number' as const, default: DEFAULT_CONTEST_YEAR, label: 'contestYear', description: 'contestYearDesc', scope: 'operator' as const },
    location: { type: 'string' as const, default: '', label: 'location', description: 'locationDesc', scope: 'operator' as const },
    categoryBand: { type: 'string' as const, default: 'ALL', label: 'categoryBand', description: 'categoryBandDesc', scope: 'operator' as const, options: [...WW_DIGI_BANDS.map((value) => ({ label: value as string, value: value as string })), { label: 'ALL', value: 'ALL' }] },
    categoryPower: { type: 'string' as const, default: 'LOW', label: 'categoryPower', description: 'categoryPowerDesc', scope: 'operator' as const, options: ['HIGH', 'LOW', 'QRP'].map((value) => ({ label: value, value })) },
    categoryOperator: { type: 'string' as const, default: 'SINGLE-OP', label: 'categoryOperator', description: 'categoryOperatorDesc', scope: 'operator' as const, options: ['SINGLE-OP', 'MULTI-OP', 'CHECKLOG'].map((value) => ({ label: value, value })) },
    categoryTransmitter: { type: 'string' as const, default: 'ONE', label: 'categoryTransmitter', description: 'categoryTransmitterDesc', scope: 'operator' as const, options: ['ONE', 'TWO', 'UNLIMITED'].map((value) => ({ label: value, value })) },
    operators: { type: 'string' as const, default: '', label: 'operators', description: 'operatorsDesc', scope: 'operator' as const },
  },
  seed: (contest: typeof wwDigiFrameworkContest, context: import('@tx5dr/plugin-api').ContestSessionContext) => createSession(context as unknown as WWDigiIdentityContext, configuredContestYear(context.config.contestYear)),
  validate: (session: WWDigiContestSession, _contest: typeof wwDigiFrameworkContest, context: import('@tx5dr/plugin-api').ContestSessionContext) => {
    try {
      validateSessionConfig(context as unknown as WWDigiIdentityContext, session.config);
      return [];
    } catch (error) {
      return [{ code: 'invalid_contest_settings', message: error instanceof Error ? error.message : String(error), severity: 'error' as const }];
    }
  },
  title: (_contest: typeof wwDigiFrameworkContest, context: import('@tx5dr/plugin-api').ContestSessionContext) => `WW Digi ${configuredContestYear(context.config.contestYear)} - ${context.operator.callsign.trim().toUpperCase()}`,
};

const wwDigiContestLogbookAdapter: ContestLogbookAdapter<
  typeof wwDigiFrameworkContest,
  WWDigiContestSession,
  ContestConfig,
  Readonly<Record<string, unknown>>,
  unknown,
  unknown,
  void,
  readonly ['logbook:session', 'operator:transmit-control', 'plugin:event-bus']
> = {
  settings: wwDigiContestLogbookSettings,
  presentation: {
    columns: [
      { key: 'callsign', label: 'Callsign' },
      { key: 'band', label: 'Band' },
      { key: 'mode', label: 'Mode' },
      { key: 'receivedGrid', label: 'Exchange' },
      { key: 'status', label: 'Status' },
    ],
  },
  async getState(_contest, session, context) {
    const typed = context as WWDigiContext;
    const year = configuredContestYear(typed.config.contestYear);
    const records = await readContestRecords(typed, year);
    const score = summarizeWWDigiScore(records, session.config.categoryBand);
    const rows = score.rows.map((row) => ({
      id: row.record.qsoId,
      callsign: row.record.callsign,
      band: row.record.band,
      mode: row.record.mode,
      time: row.record.startTime,
      status: row.record.status,
      fields: {
        receivedGrid: row.record.receivedGrid ?? 'ZZ00',
        dupe: row.dupe,
        points: row.creditedPoints,
        newMultiplier: row.newMultiplier,
      },
      receivedExchange: row.record.receivedGrid,
      operatorCallsign: row.record.myCallsign,
    }));
    return {
      schemaVersion: 1,
      contest: {
        id: WW_DIGI_CONTEST_ID,
        editionId: wwDigiEditionId(year),
        rulesetVersion: WW_DIGI_RULESET_VERSION,
        officialUrl: 'https://ww-digi.com/rules/',
        startAt: new Date(resolveWWDigiContestPeriod(year).startTime).toISOString(),
        endAt: new Date(resolveWWDigiContestPeriod(year).endTime).toISOString(),
        modes: ['FT8', 'FT4'],
        bands: [...WW_DIGI_BANDS],
        exchangeId: 'grid-4',
        exchangeSummary: 'Four-character Maidenhead grid',
        completionId: wwDigiFrameworkContest.completion.id,
        ruleSummary: 'FT4/FT8, four-character grid exchange, distance scoring and per-band grid-field multipliers.',
        scoringSummary: 'One point plus one point per 3000 km step; grid fields multiply the score per band.',
      },
      health: {
        state: session.health.state === 'healthy' ? 'healthy' as const : session.health.state === 'degraded' ? 'degraded' as const : 'opening' as const,
        readable: session.health.state !== 'degraded',
        writable: session.health.state === 'healthy',
        updatedAt: session.health.updatedAt ?? Date.now(),
        error: session.health.error,
      },
      settings: {
        value: session.config,
        valid: isSessionConfirmed(typed, year, session),
        issues: isSessionConfirmed(typed, year, session) ? [] : ['Contest settings require confirmation'],
        fields: Object.entries(wwDigiContestLogbookSettings.settings).map(([key, descriptor]) => ({ key, label: descriptor.label, description: descriptor.description, type: descriptor.type, options: 'options' in descriptor ? descriptor.options : undefined })),
      },
      score: {
        claimedScore: score.claimedScore,
        qsoPoints: score.qsoPoints,
        multiplierCount: score.gridFields,
        details: {
          moduleId: wwDigiFrameworkContest.scoring.id,
          summary: 'One point plus one point per 3000 km step; grid fields multiply the score per band.',
          qsoCount: rows.length,
          multiplierCount: score.gridFields,
          total: score.claimedScore,
        },
      },
      qsos: rows,
      review: { pendingCount: score.reviewCount, issues: score.rows.flatMap((row) => row.record.status === 'review' || row.qsoPoints === null ? [{ code: row.qsoPoints === null ? 'missing_grid' : 'review', message: row.qsoPoints === null ? 'Missing valid grid exchange' : 'Marked for review', qsoId: row.record.qsoId, severity: 'warning' as const }] : []) },
      import: { state: 'idle' as const },
      export: { formats: [{ id: 'adif', label: 'ADIF', extension: '.adi', enabled: session.health.state === 'healthy' }, { id: 'cabrillo', label: 'Cabrillo', extension: '.log', enabled: session.health.state === 'healthy' && isSessionConfirmed(typed, year, session) }] },
      columns: wwDigiContestLogbookAdapter.presentation?.columns,
      presentation: wwDigiContestLogbookAdapter.presentation,
    } satisfies ContestLogbookViewModel<ContestConfig>;
  },
  decode(action, data) {
    const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    if (action === 'save-settings' || action === 'set-qso-status' || action === 'preview-import' || action === 'commit-import' || action === 'cancel-import' || action === 'export') return { action, payload };
    throw new Error(`contest_logbook_unknown_action:${action}`);
  },
  async handle(request, _contest, _session, requestContext) {
    const operatorId = requestContext.instanceTarget.kind === 'operator' ? requestContext.instanceTarget.operatorId : '';
    const handler = legacyPageHandlers.get(operatorId);
    if (!handler) throw new Error('ww_digi_page_handler_unavailable');
    const actionMap: Record<string, string> = {
      'save-settings': 'updateSession',
      'set-qso-status': 'setStatus',
      'preview-import': 'previewADIFImport',
      'commit-import': 'commitADIFImport',
      'cancel-import': 'cancelADIFImport',
    };
    if (request.action === 'export') {
      const formatId = (request.payload as { formatId?: unknown }).formatId;
      const result = await handler.onMessage('contest-log', formatId === 'adif' ? 'renderADIF' : 'renderCabrillo', {}, requestContext) as { text?: string };
      return { fileName: `ww-digi.${formatId === 'adif' ? 'adi' : 'log'}`, mediaType: 'text/plain', text: result.text ?? '' };
    }
    return handler.onMessage('contest-log', actionMap[request.action] ?? request.action, request.payload, requestContext);
  },
};

const wwDigiContestLogbook = defaultContestLogbook({
  contest: wwDigiFrameworkContest,
  adapter: wwDigiContestLogbookAdapter,
  resolveContest: (context) => ({
    ...wwDigiFrameworkContest,
    edition: fixedWeekendEdition({
      id: wwDigiEditionId(configuredContestYear(context.config.contestYear)),
      startAt: new Date(resolveWWDigiContestPeriod(configuredContestYear(context.config.contestYear)).startTime),
      endAt: new Date(resolveWWDigiContestPeriod(configuredContestYear(context.config.contestYear)).endTime),
      source: { url: 'https://ww-digi.com/rules/' },
    }),
  }),
  sessionKey: (_contest, context) => contestLogbookSessionKey(configuredContestYear(context.config.contestYear)),
  stateKey: (_contest, context) => sessionKey(context.operator.callsign, configuredContestYear(context.config.contestYear)),
});

const { createStrategyRuntime: createWWDigiStrategyRuntime, ...wwDigiPluginMetadata } = wwDigiBasePlugin;

export const wwDigiStrategyPlugin = composeFT8ContestPlugin({
  ...wwDigiPluginMetadata,
  permissions: ['logbook:session', 'operator:transmit-control', 'plugin:event-bus'] as const,
  contest: wwDigiFrameworkContest,
  logbook: wwDigiContestLogbook,
  runtime: (_contest, context) => createWWDigiStrategyRuntime!(context),
});

export const wwDigiTestables = {
  configuredContestYear,
  legacyLedgerKey,
  legacyHealthKey,
  sessionKey,
  resolveContestLocation,
  buildOperatingIndex,
  sessionFingerprint,
  runtimePresentation,
  isSessionConfirmed,
  requiresContestSection,
  validateSessionConfig,
  updateContestRecordEntry,
  refreshContestProjection,
  refreshContestProjectionWithHealth,
  renderCabrillo,
  renderADIF,
  commitAdifImport,
  readContestRecords,
  openContestLogbook,
  runtimeLogbookIdKey,
};

export const wwDigiLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};

// Contest logbook pages are built once in the shared FT contest asset directory.
export const wwDigiDirPath = fileURLToPath(new URL('../ft-contests/', import.meta.url));

export { WWDigiStrategyRuntime } from './WWDigiStrategyRuntime.js';
