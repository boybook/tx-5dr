import type { PluginContext, PluginDefinition } from '@tx5dr/plugin-api';
import { isPureStandby } from '../_shared/autocall-utils.js';
import {
  isSameScheduleMinute,
  isScheduleDayActive,
  parseScheduleDays,
  parseScheduleTime,
} from '../_shared/schedule-utils.js';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

const TIMER_ID = 'scheduled-cq-autocall';
const TIMER_INTERVAL_MS = 15_000;
const LAST_TRIGGER_KEY = 'lastScheduledCqTriggerKey';
const LAST_INTERVAL_TRIGGER_MS_KEY = 'lastScheduledCqIntervalTriggerMs';
const DEFAULT_INTERVAL_MINUTES = 30;
const SCHEDULED_CQ_BANDS = [
  '160m',
  '80m',
  '60m',
  '40m',
  '30m',
  '20m',
  '17m',
  '15m',
  '12m',
  '10m',
  '6m',
  '2m',
  '70cm',
] as const;

const scheduledCqBandKeys = SCHEDULED_CQ_BANDS.map((band) => ({
  key: band,
  label: band,
}));

type ScheduleRow = {
  id?: unknown;
  enabled?: unknown;
  days?: unknown;
  time?: unknown;
};

type IntervalSettings = {
  enabled?: unknown;
  intervalMinutes?: unknown;
};

type ResolvedScheduledCqConfig = {
  scheduleRows: ScheduleRow[];
  intervalEnabled: boolean;
  intervalMinutes: number;
  scopeKey: string;
};

function getScheduleRows(value: unknown): ScheduleRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ScheduleRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
}

function normalizeBandKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function getKeyedValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function getScheduleRowsForBand(value: unknown, band: string): ScheduleRow[] {
  return getScheduleRows(getKeyedValue(value, band));
}

function getIntervalSettingsForBand(value: unknown, band: string): IntervalSettings | null {
  const raw = getKeyedValue(value, band);
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as IntervalSettings
    : null;
}

function normalizeIntervalMinutes(value: unknown): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(1, Math.floor(numericValue));
}

function buildScheduleTriggerKey(
  scopeKey: string,
  rowId: string,
  now: Date,
  time: { hour: number; minute: number },
): string {
  const baseKey = `${rowId}:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}:${time.hour}:${time.minute}`;
  return scopeKey === 'common' ? baseKey : `${scopeKey}:${baseKey}`;
}

function getDueScheduleKeyForRows(
  rows: ScheduleRow[],
  scopeKey: string,
  now = new Date(),
): string | null {
  for (const [index, row] of rows.entries()) {
    if (row.enabled === false) continue;
    const time = parseScheduleTime(row.time);
    const days = parseScheduleDays(row.days);
    if (!time || !days) continue;
    if (!isScheduleDayActive(days, now) || !isSameScheduleMinute(now, time)) continue;
    const rowId = typeof row.id === 'string' && row.id ? row.id : `row-${index}`;
    return buildScheduleTriggerKey(scopeKey, rowId, now, time);
  }
  return null;
}

function resolveScheduledCqConfig(ctx: PluginContext): ResolvedScheduledCqConfig {
  if (ctx.config.scheduledCqPerBandEnabled === true) {
    const band = normalizeBandKey(ctx.radio.band);
    if (!band || band === 'unknown') {
      return {
        scheduleRows: [],
        intervalEnabled: false,
        intervalMinutes: DEFAULT_INTERVAL_MINUTES,
        scopeKey: 'band:unknown',
      };
    }

    const intervalSettings = getIntervalSettingsForBand(ctx.config.scheduledCqBandIntervalSettings, band);
    return {
      scheduleRows: getScheduleRowsForBand(ctx.config.scheduledCqBandTasks, band),
      intervalEnabled: intervalSettings?.enabled === true,
      intervalMinutes: normalizeIntervalMinutes(intervalSettings?.intervalMinutes),
      scopeKey: `band:${band}`,
    };
  }

  return {
    scheduleRows: getScheduleRows(ctx.config.scheduledCqTasks),
    intervalEnabled: ctx.config.scheduledCqIntervalEnabled === true,
    intervalMinutes: normalizeIntervalMinutes(ctx.config.scheduledCqIntervalMinutes),
    scopeKey: 'common',
  };
}

function getDueScheduleKey(ctx: PluginContext, now = new Date()): string | null {
  const config = resolveScheduledCqConfig(ctx);
  return getDueScheduleKeyForRows(config.scheduleRows, config.scopeKey, now);
}

function getIntervalStoreKey(config: ResolvedScheduledCqConfig): string {
  return config.scopeKey === 'common'
    ? LAST_INTERVAL_TRIGGER_MS_KEY
    : `${LAST_INTERVAL_TRIGGER_MS_KEY}:${config.scopeKey}`;
}

function getDueIntervalKeyForConfig(
  ctx: PluginContext,
  config: ResolvedScheduledCqConfig,
  now = new Date(),
): string | null {
  if (!config.intervalEnabled) return null;
  const lastTriggerMs = ctx.store.operator.get<number>(getIntervalStoreKey(config), 0);
  if (!Number.isFinite(lastTriggerMs) || lastTriggerMs <= 0) return null;
  const intervalMs = config.intervalMinutes * 60_000;
  if (now.getTime() - lastTriggerMs < intervalMs) return null;
  return `${config.scopeKey}:interval:${config.intervalMinutes}:${Math.floor(now.getTime() / intervalMs)}`;
}

function getDueIntervalKey(ctx: PluginContext, now = new Date()): string | null {
  return getDueIntervalKeyForConfig(ctx, resolveScheduledCqConfig(ctx), now);
}

function markIntervalBaseline(ctx: PluginContext, config: ResolvedScheduledCqConfig, now = new Date()): void {
  if (!config.intervalEnabled) return;
  ctx.store.operator.set(getIntervalStoreKey(config), now.getTime());
}

function ensureIntervalBaseline(ctx: PluginContext, config: ResolvedScheduledCqConfig, now = new Date()): void {
  if (!config.intervalEnabled) return;
  const lastTriggerMs = ctx.store.operator.get<number>(getIntervalStoreKey(config), 0);
  if (!Number.isFinite(lastTriggerMs) || lastTriggerMs <= 0) {
    markIntervalBaseline(ctx, config, now);
  }
}

function configureTimer(ctx: PluginContext): void {
  if (ctx.config.scheduledCqEnabled === true) {
    ctx.timers.set(TIMER_ID, TIMER_INTERVAL_MS);
    return;
  }
  ctx.timers.clear(TIMER_ID);
}

function runScheduledCqCheck(ctx: PluginContext, now = new Date()): void {
  if (ctx.config.scheduledCqEnabled !== true) return;

  const resolvedConfig = resolveScheduledCqConfig(ctx);
  const dueScheduleKey = getDueScheduleKeyForRows(resolvedConfig.scheduleRows, resolvedConfig.scopeKey, now);
  const lastTriggerKey = ctx.store.operator.get<string | null>(LAST_TRIGGER_KEY, null);
  if (dueScheduleKey && lastTriggerKey !== dueScheduleKey) {
    ctx.store.operator.set(LAST_TRIGGER_KEY, dueScheduleKey);
    markIntervalBaseline(ctx, resolvedConfig, now);

    if (!isPureStandby(ctx)) {
      ctx.log.debug('Scheduled CQ skipped because operator is not in pure standby', { dueKey: dueScheduleKey });
      return;
    }

    ctx.log.info('Scheduled CQ starting transmit automation', { dueKey: dueScheduleKey });
    ctx.operator.startTransmitting();
    return;
  }

  const dueIntervalKey = getDueIntervalKeyForConfig(ctx, resolvedConfig, now);
  if (!dueIntervalKey) {
    ensureIntervalBaseline(ctx, resolvedConfig, now);
    return;
  }

  markIntervalBaseline(ctx, resolvedConfig, now);
  if (!isPureStandby(ctx)) {
    ctx.log.debug('Scheduled CQ skipped because operator is not in pure standby', { dueKey: dueIntervalKey });
    return;
  }

  ctx.log.info('Scheduled CQ starting transmit automation', { dueKey: dueIntervalKey });
  ctx.operator.startTransmitting();
}

function isScheduledCqAutoCallEnabled(ctx: PluginContext): boolean {
  return ctx.config.scheduledCqEnabled === true;
}

export const scheduledCqAutocallPlugin: PluginDefinition = {
  name: 'scheduled-cq-autocall',
  version: '1.0.0',
  type: 'utility',
  description: 'Start CQ automation at scheduled local times or fixed intervals while the operator is idle',
  permissions: ['operator:transmit-control'],

  settings: {
    scheduledCqOverview: {
      type: 'info',
      default: '',
      label: 'scheduledCqOverview',
      description: 'scheduledCqOverviewDesc',
      scope: 'operator',
    },
    scheduledCqEnabled: {
      type: 'boolean',
      default: false,
      label: 'scheduledCqEnabled',
      description: 'scheduledCqEnabledDesc',
      scope: 'operator',
    },
    scheduledCqPerBandEnabled: {
      type: 'boolean',
      default: false,
      label: 'scheduledCqPerBandEnabled',
      description: 'scheduledCqPerBandEnabledDesc',
      scope: 'operator',
    },
    scheduledCqTasks: {
      type: 'object[]',
      default: [],
      label: 'scheduledCqTasks',
      description: 'scheduledCqTasksDesc',
      scope: 'operator',
      visibleWhen: { setting: 'scheduledCqPerBandEnabled', notEquals: true },
      itemFields: [
        { key: 'enabled', type: 'boolean', label: 'taskEnabled' },
        { key: 'days', type: 'string', label: 'taskDays', description: 'taskDaysDesc', placeholder: 'daily or mon-fri' },
        { key: 'time', type: 'string', label: 'taskTime', description: 'taskTimeDesc', placeholder: '08:30' },
      ],
    },
    scheduledCqIntervalEnabled: {
      type: 'boolean',
      default: false,
      label: 'scheduledCqIntervalEnabled',
      description: 'scheduledCqIntervalEnabledDesc',
      scope: 'operator',
      visibleWhen: { setting: 'scheduledCqPerBandEnabled', notEquals: true },
    },
    scheduledCqIntervalMinutes: {
      type: 'number',
      default: DEFAULT_INTERVAL_MINUTES,
      label: 'scheduledCqIntervalMinutes',
      description: 'scheduledCqIntervalMinutesDesc',
      scope: 'operator',
      min: 1,
      max: 1440,
      visibleWhen: {
        allOf: [
          { setting: 'scheduledCqPerBandEnabled', notEquals: true },
          { setting: 'scheduledCqIntervalEnabled', equals: true },
        ],
      },
    },
    scheduledCqBandTasks: {
      type: 'keyedObjectArrays',
      default: {},
      label: 'scheduledCqBandTasks',
      description: 'scheduledCqBandTasksDesc',
      scope: 'operator',
      keys: scheduledCqBandKeys,
      visibleWhen: { setting: 'scheduledCqPerBandEnabled', equals: true },
      itemFields: [
        { key: 'enabled', type: 'boolean', label: 'taskEnabled' },
        { key: 'days', type: 'string', label: 'taskDays', description: 'taskDaysDesc', placeholder: 'daily or mon-fri' },
        { key: 'time', type: 'string', label: 'taskTime', description: 'taskTimeDesc', placeholder: '08:30' },
      ],
    },
    scheduledCqBandIntervalSettings: {
      type: 'keyedObjects',
      default: {},
      label: 'scheduledCqBandIntervalSettings',
      description: 'scheduledCqBandIntervalSettingsDesc',
      scope: 'operator',
      keys: scheduledCqBandKeys,
      visibleWhen: { setting: 'scheduledCqPerBandEnabled', equals: true },
      itemFields: [
        { key: 'enabled', type: 'boolean', label: 'scheduledCqBandIntervalEnabled', default: false },
        {
          key: 'intervalMinutes',
          type: 'number',
          label: 'scheduledCqIntervalMinutes',
          description: 'scheduledCqIntervalMinutesDesc',
          placeholder: String(DEFAULT_INTERVAL_MINUTES),
          default: DEFAULT_INTERVAL_MINUTES,
        },
      ],
    },
  },

  quickSettings: [
    { settingKey: 'scheduledCqEnabled' },
    { settingKey: 'scheduledCqPerBandEnabled' },
    { settingKey: 'scheduledCqTasks' },
    { settingKey: 'scheduledCqIntervalEnabled' },
    { settingKey: 'scheduledCqIntervalMinutes' },
    { settingKey: 'scheduledCqBandTasks' },
    { settingKey: 'scheduledCqBandIntervalSettings' },
  ],

  onLoad(ctx) {
    configureTimer(ctx);
  },

  isAutoCallEnabled: isScheduledCqAutoCallEnabled,

  hooks: {
    onConfigChange(_changes, ctx) {
      configureTimer(ctx);
    },
    onTimer(timerId, ctx) {
      if (timerId !== TIMER_ID) return;
      runScheduledCqCheck(ctx);
    },
  },
};

export const scheduledCqAutocallLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};

export const scheduledCqAutocallTestables = {
  getDueScheduleKey,
  getDueIntervalKey,
  resolveScheduledCqConfig,
  runScheduledCqCheck,
  isScheduledCqAutoCallEnabled,
};
