import { fileURLToPath } from 'node:url';
import { wwDigiSimulationScenarios } from './simulation-scenarios.js';
import {
  definePlugin,
  type PluginContextFor,
  type QSORecord,
  type StrategyMessagePresentationProjection,
  type StrategyPluginContext,
  type StrategyRuntimeSnapshot,
} from '@tx5dr/plugin-api';
import type { PluginQuickSetting } from '@tx5dr/plugin-api';
import { getCallsignInfo } from '@tx5dr/core';
import { ContestSessionNotifier, ContestSessionRepository } from '@tx5dr/plugin-api/toolkit';
import { WWDigiStrategyRuntime, type WWDigiRuntimeConfig } from './WWDigiStrategyRuntime.js';
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

export const BUILTIN_WW_DIGI_PLUGIN_NAME = 'ww-digi';
const DEFAULT_CONTEST_YEAR = new Date().getUTCFullYear();
type WWDigiContext = PluginContextFor<readonly ['logbook:read', 'operator:transmit-control', 'plugin:event-bus']>;

interface ContestQsoOverride {
  status?: ContestQso['status'];
  operatorId?: string;
  transmitterId?: 0 | 1;
  source?: ContestQso['source'];
}

interface WWDigiContestSession {
  schemaVersion: 2;
  revision: number;
  config: ContestConfig;
  overrides: Record<string, ContestQsoOverride>;
  operatorTransmitters: Record<string, 0 | 1>;
  migratedOperators: Record<string, true>;
  health: ContestLedgerHealth;
  setup: ContestSetupState;
  operatingIndex: ContestOperatingIndex;
}

const SESSION_CHANGED_TOPIC = 'ww-digi.session.changed';

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

function ledgerKey(contestYear: number): string {
  return `contestQsos:${contestYear}`;
}

function healthKey(contestYear: number): string {
  return `ledgerHealth:${contestYear}`;
}

function sessionKey(callsign: string, contestYear: number): string {
  return `contestSession:${callsign.trim().toUpperCase()}:${contestYear}`;
}

function createSession(ctx: WWDigiIdentityContext, _contestYear: number): WWDigiContestSession {
  return {
    schemaVersion: 2,
    revision: 0,
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
  stored: Partial<WWDigiContestSession> & { schemaVersion?: number; revision?: number },
): WWDigiContestSession {
  const created = createSession(ctx, contestYear);
  const setup = stored.schemaVersion === 2 && stored.setup?.status === 'confirmed'
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
    schemaVersion: 2,
    revision: stored.revision ?? 0,
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

function readLedger(ctx: WWDigiContext, contestYear: number): ContestQso[] {
  const value = ctx.store.operator.get<unknown>(ledgerKey(contestYear), []);
  return Array.isArray(value)
    ? (value as ContestQso[]).filter((record) => (
      isWithinWWDigiContestPeriod(record.startTime, contestYear)
    ))
    : [];
}

function readLedgerHealth(ctx: WWDigiContext, contestYear: number): ContestLedgerHealth {
  const value = ctx.store.operator.get<unknown>(healthKey(contestYear));
  if (!value || typeof value !== 'object' || !('state' in value)) return { state: 'unknown' };
  const state = (value as { state?: unknown }).state;
  return state === 'healthy' || state === 'degraded' || state === 'unknown'
    ? value as ContestLedgerHealth
    : { state: 'unknown' };
}

function toContestQso(
  record: QSORecord,
  contestYear: number,
  existing?: ContestQso,
): ContestQso | null {
  if (!isWithinWWDigiContestPeriod(record.startTime, contestYear)) return null;
  const band = resolveWWDigiBand(record.frequency);
  const mode = modeOf(record);
  const myCallsign = record.myCallsign?.trim().toUpperCase();
  const sentGrid = record.myGrid?.trim().toUpperCase().slice(0, 4);
  if (!band || !mode || !myCallsign || !sentGrid) return null;
  return {
    qsoId: record.id,
    callsign: record.callsign,
    myCallsign,
    sentGrid,
    receivedGrid: record.grid?.trim().toUpperCase().slice(0, 4),
    frequencyHz: Math.round(record.frequency),
    band,
    mode,
    startTime: record.startTime,
    status: existing?.status ?? 'included',
    streamId: existing?.streamId,
    authorizationId: existing?.authorizationId,
    operatorId: existing?.operatorId,
    transmitterId: existing?.transmitterId,
    source: existing?.source ?? (record.contestId?.toUpperCase() === 'WW-DIGI' ? 'ww-digi' : 'reconciled'),
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
  const logbook = ctx.logbook.forCallsign(ctx.operator.callsign);
  if (!await logbook.getLogBookId()) throw new Error(`WW Digi logbook is unavailable for ${ctx.operator.callsign}`);
  const session = sessionRepository(ctx, contestYear).read();
  const projected: ContestQso[] = [];
  const pageSize = 5_000;
  for (let offset = 0; ; offset += pageSize) {
    const records = await logbook.queryQSOs({
      orderDirection: 'asc', limit: pageSize, offset,
      timeRange: { start: period.startTime, end: period.endTime - 1 },
    });
    for (const record of records) {
      const qso = toContestQso(record, contestYear);
      if (!qso || qso.myCallsign !== ctx.operator.callsign.trim().toUpperCase()) continue;
      const override = session.overrides[qso.qsoId];
      const merged = { ...qso, ...override };
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

async function reconcileLedger(
  ctx: WWDigiContext,
  contestYear: number,
): Promise<{ imported: number; total: number }> {
  const records = await readContestRecords(ctx, contestYear);
  const repository = sessionRepository(ctx, contestYear);
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
  return {
    imported: records.filter((record) => record.source !== 'ww-digi').length,
    total: records.length,
  };
}

async function reconcileLedgerWithHealth(
  ctx: WWDigiContext,
  contestYear: number,
): Promise<{ imported: number; total: number }> {
  try {
    return await reconcileLedger(ctx, contestYear);
  } catch (error) {
    await markLedgerDegraded(ctx, contestYear, error);
    throw error;
  }
}

async function renderCabrillo(ctx: WWDigiContext, contestYear: number): Promise<string> {
  const session = sessionRepository(ctx, contestYear).read();
  const health = session.health;
  if (health.state !== 'healthy') {
    throw new Error(`WW Digi ${contestYear} log is not reconciled; reconcile it before download`);
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

function runtimePresentation(ctx: StrategyPluginContext): Pick<
  StrategyRuntimeSnapshot,
  'actions' | 'attentions' | 'messagePresentation' | 'transmitGate'
> {
  const contestYear = configuredContestYear(ctx.config.contestYear);
  const session = runtimeSession(ctx, contestYear);
  const callableMessageMatchers = [
    { firstTokenIn: ['CQ'] },
    { anyTokenIn: ['RR73', 'RRR', '73'] },
  ];
  const messagePresentation: StrategyMessagePresentationProjection = {
    revision: session.operatingIndex.revision,
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
    assignments: Object.entries(session.operatingIndex.workedByBand).flatMap(([band, callsigns]) => (
      callsigns.map((subject) => ({ subject, partition: band, classId: 'contest-worked' }))
    )),
    noveltyRules: [{
      fact: 'grid-field-2',
      knownValuesByPartition: session.operatingIndex.workedFieldsByBand,
      classId: 'contest-new-field',
    }],
  };
  const confirmed = isSessionConfirmed(ctx, contestYear, session);
  const gateReason = !confirmed
    ? 'transmitBlockedSetupUnconfirmed'
    : session.health.state !== 'healthy'
      ? 'transmitBlockedLedgerUnhealthy'
      : undefined;
  if (!gateReason) return { messagePresentation };
  return {
    messagePresentation,
    transmitGate: { allowed: false, reason: gateReason, actionId: 'open-contest-settings' },
    actions: [{
      id: 'open-contest-settings',
      label: 'actionOpenContestSettings',
      icon: 'file-lines',
      tone: 'warning',
      presentation: 'primary',
      navigation: { kind: 'plugin-page', pageId: 'contest-log' },
    }],
    attentions: [{
      id: `contest-session-gate:${contestYear}:${gateReason}`,
      tone: session.health.state === 'degraded' ? 'danger' : 'warning',
      title: !confirmed ? 'attentionContestSetupRequired' : 'attentionContestLedgerUnhealthy',
      description: !confirmed ? 'attentionContestSetupRequiredDesc' : 'attentionContestLedgerUnhealthyDesc',
      actionIds: ['open-contest-settings'],
    }],
  };
}

function hasWorkedInRuntimeSession(ctx: StrategyPluginContext, callsign: string): boolean {
  const contestYear = configuredContestYear(ctx.config.contestYear);
  const session = runtimeSession(ctx, contestYear);
  const band = ctx.radio.band.trim().toUpperCase();
  return (session.operatingIndex.workedByBand[band] ?? []).includes(callsign.trim().toUpperCase());
}

function parallelStreams(value: unknown, fallback = 1): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(3, Math.trunc(numeric))) : fallback;
}

export const wwDigiQuickSettings: PluginQuickSetting[] = [
  { settingKey: 'parallelStreams' },
  { settingKey: 'maxAttempts' },
  { settingKey: 'cqMaxAttempts' },
  { settingKey: 'cqSelectionPolicy' },
  { settingKey: 'authorizedStaleReceiveCycles' },
];

export const wwDigiStrategyPlugin = definePlugin({
  apiVersion: 2,
  name: BUILTIN_WW_DIGI_PLUGIN_NAME,
  version: '1.0.0',
  type: 'strategy',
  description: 'WW Digi FT8/FT4 contest strategy with manually authorized parallel QSOs',
  strategyFeatures: {
    targetQueue: 1,
    parallelTargetQueue: 1,
    queueActivation: 'operator-toggle',
    manualInitiation: 1,
    maxConcurrentStreams: 3,
  },
  simulationScenarios: wwDigiSimulationScenarios,
  permissions: ['logbook:read', 'operator:transmit-control', 'plugin:event-bus'],
  storage: { scopes: ['global', 'operator'] },
  settings: {
    strategyOverview: { type: 'info', default: '', label: 'strategyOverview', description: 'strategyOverviewDesc', scope: 'operator' },
    contestYear: {
      type: 'number', default: DEFAULT_CONTEST_YEAR, label: 'contestYear', description: 'contestYearDesc', scope: 'operator',
      min: WW_DIGI_MIN_CONTEST_YEAR, max: WW_DIGI_MAX_CONTEST_YEAR,
    },
    parallelStreams: { type: 'number', default: 1, label: 'parallelStreams', description: 'parallelStreamsDesc', scope: 'operator', min: 1, max: 3 },
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
    const operator = {
      get config(): WWDigiRuntimeConfig {
        const modeName = ctx.operator.mode.name.toUpperCase() === 'FT4' ? 'FT4' : 'FT8';
        const base = resolveBaseFrequency();
        return {
          myCallsign: ctx.operator.callsign,
          myGrid: ctx.operator.grid.slice(0, 4).toUpperCase(),
          frequency: base,
          modeName,
          slotMs: ctx.operator.mode.slotMs,
          transmitCycles: [...ctx.operator.transmitCycles],
          parallelStreams: parallelStreams(ctx.config.parallelStreams),
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
        return Promise.resolve(hasWorkedInRuntimeSession(ctx, callsign));
      },
    };
    return new WWDigiStrategyRuntime(operator, ctx.log, () => {
      const base = resolveBaseFrequency();
      return [base - 100, base, base + 100];
    }, async (text, mode) => ctx.digitalMessagePreflight.check({ text, mode }), () => runtimePresentation(ctx));
  },
  isTransmitControlEnabled: () => true,
  async onLoad(ctx) {
    const typed = ctx as WWDigiContext;
    const contestYear = configuredContestYear(typed.config.contestYear);
    const repository = sessionRepository(typed, contestYear);
    const legacy = readLedger(typed, contestYear);
    repository.update((session) => {
      if (session.migratedOperators[typed.operator.id]) return session;
      const overrides = { ...session.overrides };
      for (const record of legacy) {
        overrides[record.qsoId] = {
          ...overrides[record.qsoId],
          status: record.status === 'x-qso' ? 'x-qso' : overrides[record.qsoId]?.status,
          operatorId: record.operatorId ?? typed.operator.id,
          transmitterId: record.transmitterId,
          source: record.source ?? 'ww-digi',
        };
      }
      return {
        ...session,
        overrides,
        migratedOperators: { ...session.migratedOperators, [typed.operator.id]: true },
      };
    });
    await repository.flush();
    const notifier = new ContestSessionNotifier<{ callsign: string; contestYear: number }>(typed.eventBus, SESSION_CHANGED_TOPIC);
    notifier.subscribe((event) => {
      if (event.callsign === typed.operator.callsign.trim().toUpperCase() && event.contestYear === contestYear) {
        notifyLocalContestLogChanged(typed);
        typed.ui.refreshOperatorProjection();
      }
    });
    await reconcileLedgerWithHealth(typed, contestYear).catch((error) => {
      typed.log.warn('WW Digi ledger reconciliation failed', { error: error instanceof Error ? error.message : String(error) });
    });
    typed.ui.refreshOperatorProjection();
    typed.ui.registerPageHandler({
      async onMessage(pageId, action, data) {
        if (pageId !== 'contest-log') throw new Error(`Unknown page: ${pageId}`);
        const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const selectedYear = configuredContestYear(typed.config.contestYear);
        if (action === 'getState') {
          const period = resolveWWDigiContestPeriod(selectedYear);
          const session = sessionRepository(typed, selectedYear).read();
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
        if (action === 'reconcile') {
          const result = await reconcileLedgerWithHealth(typed, selectedYear);
          notifyContestLogChanged(typed, selectedYear);
          return result;
        }
        if (action === 'setStatus') {
          const qsoId = typeof payload.qsoId === 'string' ? payload.qsoId : '';
          const status = payload.status === 'x-qso' ? 'x-qso'
            : payload.status === 'review' ? 'review' : 'included';
          const records = await readContestRecords(typed, selectedYear);
          if (!records.some((record) => record.qsoId === qsoId)) throw new Error('Unknown contest QSO');
          const repository = sessionRepository(typed, selectedYear);
          repository.update((session) => ({
            ...session,
            overrides: {
              ...session.overrides,
              [qsoId]: { ...session.overrides[qsoId], status },
            },
          }));
          await repository.flush();
          await reconcileLedgerWithHealth(typed, selectedYear);
          notifyContestLogChanged(typed, selectedYear);
          return { records: await readContestRecords(typed, selectedYear) };
        }
        if (action === 'setTransmitter') {
          const qsoId = typeof payload.qsoId === 'string' ? payload.qsoId : '';
          const transmitterId = payload.transmitterId === 1 ? 1 : payload.transmitterId === 0 ? 0 : undefined;
          if (transmitterId === undefined) throw new Error('Invalid transmitter ID');
          const repository = sessionRepository(typed, selectedYear);
          repository.update((session) => ({
            ...session,
            overrides: {
              ...session.overrides,
              [qsoId]: { ...session.overrides[qsoId], transmitterId, status: 'included' },
            },
          }));
          await repository.flush();
          await reconcileLedgerWithHealth(typed, selectedYear);
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
    });
  },
  hooks: {
    async onQSOComplete(record, ctx) {
      const typed = ctx as WWDigiContext;
      const contestYear = new Date(record.startTime).getUTCFullYear();
      const contestQso = toContestQso(record, contestYear);
      if (!contestQso) return;
      try {
        const transmitterId = Number(typed.config.transmitterId) === 1 ? 1 : 0;
        const repository = sessionRepository(typed, contestYear);
        repository.update((session) => ({
          ...session,
          overrides: {
            ...session.overrides,
            [record.id]: {
              ...session.overrides[record.id],
              status: session.overrides[record.id]?.status ?? 'included',
              operatorId: typed.operator.id,
              transmitterId,
              source: record.contestId?.toUpperCase() === 'WW-DIGI'
                ? 'ww-digi'
                : record.messageHistory.length > 0 ? 'standard' : 'manual',
            },
          },
          operatorTransmitters: { ...session.operatorTransmitters, [typed.operator.id]: transmitterId },
          health: { state: 'healthy', updatedAt: Date.now() },
        }));
        await repository.flush();
        await reconcileLedgerWithHealth(typed, contestYear);
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

export const wwDigiTestables = {
  configuredContestYear,
  ledgerKey,
  healthKey,
  sessionKey,
  resolveContestLocation,
  buildOperatingIndex,
  sessionFingerprint,
  runtimePresentation,
  isSessionConfirmed,
  requiresContestSection,
  validateSessionConfig,
  readLedger,
  readLedgerHealth,
  reconcileLedger,
  reconcileLedgerWithHealth,
  renderCabrillo,
  readContestRecords,
};

export const wwDigiLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};

export const wwDigiDirPath = fileURLToPath(new URL('.', import.meta.url));

export { WWDigiStrategyRuntime } from './WWDigiStrategyRuntime.js';
