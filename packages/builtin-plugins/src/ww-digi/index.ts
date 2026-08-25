import { fileURLToPath } from 'node:url';
import { definePlugin, type PluginContextFor, type QSORecord } from '@tx5dr/plugin-api';
import type { PluginQuickSetting } from '@tx5dr/plugin-api';
import { getCallsignInfo } from '@tx5dr/core';
import { WWDigiStrategyRuntime, type WWDigiRuntimeConfig } from './WWDigiStrategyRuntime.js';
import {
  generateWWDigiCabrillo,
  isWithinWWDigiContestPeriod,
  resolveWWDigiBand,
  resolveWWDigiContestPeriod,
  setContestQsoStatus,
  upsertContestQso,
  WW_DIGI_MAX_CONTEST_YEAR,
  WW_DIGI_MIN_CONTEST_YEAR,
  type ContestConfig,
  type ContestQso,
} from './contest-log.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

export const BUILTIN_WW_DIGI_PLUGIN_NAME = 'ww-digi';
const DEFAULT_CONTEST_YEAR = new Date().getUTCFullYear();
type WWDigiContext = PluginContextFor<readonly ['logbook:read', 'operator:transmit-control']>;

interface ContestLedgerHealth {
  state: 'healthy' | 'degraded' | 'unknown';
  updatedAt?: number;
  error?: string;
}

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

function resolveContestLocation(callsign: string, configured: unknown): string {
  const location = typeof configured === 'string' ? configured.trim().toUpperCase() : '';
  const countryCode = getCallsignInfo(callsign)?.countryCode?.toUpperCase();
  if (countryCode === 'US' || countryCode === 'CA') {
    return location === 'DX' ? '' : location;
  }
  return location || 'DX';
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
  if (record.contestId?.toUpperCase() !== 'WW-DIGI') return null;
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
  };
}

async function persistLedger(
  ctx: WWDigiContext,
  contestYear: number,
  records: ContestQso[],
): Promise<void> {
  ctx.store.operator.set(ledgerKey(contestYear), records);
  await ctx.store.operator.flush();
}

async function markLedgerDegraded(
  ctx: WWDigiContext,
  contestYear: number,
  error: unknown,
): Promise<void> {
  ctx.store.operator.set(healthKey(contestYear), {
    state: 'degraded',
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error),
  } satisfies ContestLedgerHealth);
  await ctx.store.operator.flush().catch((flushError) => {
    ctx.log.error('WW Digi degraded health could not be flushed', flushError);
  });
}

async function reconcileLedger(
  ctx: WWDigiContext,
  contestYear: number,
): Promise<{ imported: number; total: number }> {
  const period = resolveWWDigiContestPeriod(contestYear);
  const logbook = ctx.logbook.forCallsign(ctx.operator.callsign);
  if (!await logbook.getLogBookId()) {
    throw new Error(`WW Digi logbook is unavailable for ${ctx.operator.callsign}`);
  }
  const existing = readLedger(ctx, contestYear);
  let next = [...existing];
  let imported = 0;
  const pageSize = 5_000;
  for (let offset = 0; ; offset += pageSize) {
    const records = await logbook.queryQSOs({
      orderDirection: 'asc',
      limit: pageSize,
      offset,
      timeRange: { start: period.startTime, end: period.endTime - 1 },
    });
    for (const record of records) {
      const prior = next.find((candidate) => candidate.qsoId === record.id);
      const contestQso = toContestQso(record, contestYear, prior);
      if (!contestQso) continue;
      if (!prior) imported += 1;
      next = upsertContestQso(next, contestQso);
    }
    if (records.length < pageSize) break;
  }
  ctx.store.operator.set(ledgerKey(contestYear), next);
  ctx.store.operator.set(healthKey(contestYear), {
    state: 'healthy',
    updatedAt: Date.now(),
  } satisfies ContestLedgerHealth);
  await ctx.store.operator.flush();
  return { imported, total: next.length };
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

function renderCabrillo(ctx: WWDigiContext, contestYear: number): string {
  const health = readLedgerHealth(ctx, contestYear);
  if (health.state !== 'healthy') {
    throw new Error(`WW Digi ${contestYear} log is not reconciled; reconcile it before download`);
  }
  return generateWWDigiCabrillo(contestConfig(ctx), readLedger(ctx, contestYear));
}

function contestConfig(ctx: WWDigiContext): ContestConfig {
  return {
    callsign: ctx.operator.callsign,
    location: resolveContestLocation(ctx.operator.callsign, ctx.config.location),
    categoryBand: typeof ctx.config.categoryBand === 'string'
      ? ctx.config.categoryBand as ContestConfig['categoryBand']
      : 'ALL',
    categoryPower: typeof ctx.config.categoryPower === 'string'
      ? ctx.config.categoryPower as ContestConfig['categoryPower']
      : 'LOW',
    createdBy: 'TX-5DR WW Digi',
  };
}

function parallelStreams(value: unknown, fallback = 3): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(3, Math.trunc(numeric))) : fallback;
}

export const wwDigiQuickSettings: PluginQuickSetting[] = [
  { settingKey: 'parallelStreams' },
  { settingKey: 'maxAttempts' },
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
  permissions: ['logbook:read', 'operator:transmit-control'],
  storage: { scopes: ['operator'] },
  settings: {
    strategyOverview: { type: 'info', default: '', label: 'strategyOverview', description: 'strategyOverviewDesc', scope: 'operator' },
    contestYear: {
      type: 'number', default: DEFAULT_CONTEST_YEAR, label: 'contestYear', description: 'contestYearDesc', scope: 'operator',
      min: WW_DIGI_MIN_CONTEST_YEAR, max: WW_DIGI_MAX_CONTEST_YEAR,
    },
    parallelStreams: { type: 'number', default: 3, label: 'parallelStreams', description: 'parallelStreamsDesc', scope: 'operator', min: 1, max: 3 },
    maxAttempts: { type: 'number', default: 5, label: 'maxAttempts', description: 'maxAttemptsDesc', scope: 'operator', min: 1, max: 20 },
    location: { type: 'string', default: '', label: 'location', description: 'locationDesc', scope: 'operator' },
    categoryBand: {
      type: 'string', default: 'ALL', label: 'categoryBand', description: 'categoryBandDesc', scope: 'operator',
      options: ['ALL', '160M', '80M', '40M', '20M', '15M', '10M'].map((value) => ({ label: value, value })),
    },
    categoryPower: {
      type: 'string', default: 'LOW', label: 'categoryPower', description: 'categoryPowerDesc', scope: 'operator',
      options: ['HIGH', 'LOW', 'QRP'].map((value) => ({ label: value, value })),
    },
  },
  quickSettings: wwDigiQuickSettings,
  panels: [{
    id: 'contest-log', title: 'contestLogTitle', component: 'iframe', pageId: 'contest-log', slot: 'main-right', width: 'full',
  }],
  ui: {
    dir: 'ui',
    pages: [{
      id: 'contest-log', title: 'contestLogTitle', entry: 'contest-log.html', accessScope: 'operator', resourceBinding: 'none',
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
          maxAttempts: Math.max(1, Math.min(20, Math.trunc(Number(ctx.config.maxAttempts) || 5))),
        };
      },
      get isTransmitting() { return ctx.operator.isTransmitting; },
      isTargetBeingWorkedByOthers(callsign: string) {
        return ctx.operator.isTargetBeingWorkedByOthers(callsign);
      },
    };
    return new WWDigiStrategyRuntime(operator, ctx.log, () => {
      const base = resolveBaseFrequency();
      return [base - 100, base, base + 100];
    });
  },
  isTransmitControlEnabled: () => true,
  async onLoad(ctx) {
    const typed = ctx as WWDigiContext;
    const contestYear = configuredContestYear(typed.config.contestYear);
    await reconcileLedgerWithHealth(typed, contestYear).catch((error) => {
      typed.log.warn('WW Digi ledger reconciliation failed', { error: error instanceof Error ? error.message : String(error) });
    });
    typed.ui.registerPageHandler({
      async onMessage(pageId, action, data) {
        if (pageId !== 'contest-log') throw new Error(`Unknown page: ${pageId}`);
        const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
        const selectedYear = configuredContestYear(typed.config.contestYear);
        if (action === 'getState') {
          const period = resolveWWDigiContestPeriod(selectedYear);
          return {
            config: contestConfig(typed),
            contestYear: selectedYear,
            period,
            records: readLedger(typed, selectedYear),
            health: readLedgerHealth(typed, selectedYear),
          };
        }
        if (action === 'renderCabrillo') {
          return { text: renderCabrillo(typed, selectedYear) };
        }
        if (action === 'reconcile') return reconcileLedgerWithHealth(typed, selectedYear);
        if (action === 'setStatus') {
          const qsoId = typeof payload.qsoId === 'string' ? payload.qsoId : '';
          const status = payload.status === 'x-qso' ? 'x-qso' : 'included';
          const next = setContestQsoStatus(readLedger(typed, selectedYear), qsoId, status);
          await persistLedger(typed, selectedYear, next);
          return { records: next };
        }
        throw new Error(`Unknown action: ${action}`);
      },
    });
  },
  hooks: {
    async onQSOComplete(record, ctx) {
      if (record.contestId?.toUpperCase() !== 'WW-DIGI') return;
      const typed = ctx as WWDigiContext;
      const contestYear = configuredContestYear(typed.config.contestYear);
      const existing = readLedger(typed, contestYear);
      const contestQso = toContestQso(
        record,
        contestYear,
        existing.find((candidate) => candidate.qsoId === record.id),
      );
      if (!contestQso) return;
      try {
        await persistLedger(typed, contestYear, upsertContestQso(existing, contestQso));
      } catch (error) {
        await markLedgerDegraded(typed, contestYear, error);
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
  resolveContestLocation,
  readLedger,
  readLedgerHealth,
  reconcileLedger,
  reconcileLedgerWithHealth,
  renderCabrillo,
};

export const wwDigiLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};

export const wwDigiDirPath = fileURLToPath(new URL('.', import.meta.url));

export { WWDigiStrategyRuntime } from './WWDigiStrategyRuntime.js';
