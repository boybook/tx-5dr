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

type ScheduleRow = {
  id?: unknown;
  enabled?: unknown;
  days?: unknown;
  time?: unknown;
};

function getScheduleRows(value: unknown): ScheduleRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ScheduleRow => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
}

function getDueScheduleKey(ctx: PluginContext, now = new Date()): string | null {
  for (const [index, row] of getScheduleRows(ctx.config.scheduledCqTasks).entries()) {
    if (row.enabled === false) continue;
    const time = parseScheduleTime(row.time);
    const days = parseScheduleDays(row.days);
    if (!time || !days) continue;
    if (!isScheduleDayActive(days, now) || !isSameScheduleMinute(now, time)) continue;
    const rowId = typeof row.id === 'string' && row.id ? row.id : `row-${index}`;
    return `${rowId}:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}:${time.hour}:${time.minute}`;
  }
  return null;
}

function getIntervalMinutes(ctx: PluginContext): number {
  const value = typeof ctx.config.scheduledCqIntervalMinutes === 'number'
    ? ctx.config.scheduledCqIntervalMinutes
    : Number(ctx.config.scheduledCqIntervalMinutes);
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(1, Math.floor(value));
}

function getDueIntervalKey(ctx: PluginContext, now = new Date()): string | null {
  if (ctx.config.scheduledCqIntervalEnabled !== true) return null;
  const lastTriggerMs = ctx.store.operator.get<number>(LAST_INTERVAL_TRIGGER_MS_KEY, 0);
  if (!Number.isFinite(lastTriggerMs) || lastTriggerMs <= 0) return null;
  const intervalMs = getIntervalMinutes(ctx) * 60_000;
  if (now.getTime() - lastTriggerMs < intervalMs) return null;
  return `interval:${getIntervalMinutes(ctx)}:${Math.floor(now.getTime() / intervalMs)}`;
}

function markIntervalBaseline(ctx: PluginContext, now = new Date()): void {
  if (ctx.config.scheduledCqIntervalEnabled !== true) return;
  ctx.store.operator.set(LAST_INTERVAL_TRIGGER_MS_KEY, now.getTime());
}

function ensureIntervalBaseline(ctx: PluginContext, now = new Date()): void {
  if (ctx.config.scheduledCqIntervalEnabled !== true) return;
  const lastTriggerMs = ctx.store.operator.get<number>(LAST_INTERVAL_TRIGGER_MS_KEY, 0);
  if (!Number.isFinite(lastTriggerMs) || lastTriggerMs <= 0) {
    markIntervalBaseline(ctx, now);
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

  const dueScheduleKey = getDueScheduleKey(ctx, now);
  const lastTriggerKey = ctx.store.operator.get<string | null>(LAST_TRIGGER_KEY, null);
  if (dueScheduleKey && lastTriggerKey !== dueScheduleKey) {
    ctx.store.operator.set(LAST_TRIGGER_KEY, dueScheduleKey);
    markIntervalBaseline(ctx, now);

    if (!isPureStandby(ctx)) {
      ctx.log.debug('Scheduled CQ skipped because operator is not in pure standby', { dueKey: dueScheduleKey });
      return;
    }

    ctx.log.info('Scheduled CQ starting transmit automation', { dueKey: dueScheduleKey });
    ctx.operator.startTransmitting();
    return;
  }

  const dueIntervalKey = getDueIntervalKey(ctx, now);
  if (!dueIntervalKey) {
    ensureIntervalBaseline(ctx, now);
    return;
  }

  markIntervalBaseline(ctx, now);
  if (!isPureStandby(ctx)) {
    ctx.log.debug('Scheduled CQ skipped because operator is not in pure standby', { dueKey: dueIntervalKey });
    return;
  }

  ctx.log.info('Scheduled CQ starting transmit automation', { dueKey: dueIntervalKey });
  ctx.operator.startTransmitting();
}

export const scheduledCqAutocallPlugin: PluginDefinition = {
  name: 'scheduled-cq-autocall',
  version: '1.0.0',
  type: 'utility',
  description: 'Start CQ automation at scheduled local times or fixed intervals while the operator is idle',

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
    scheduledCqTasks: {
      type: 'object[]',
      default: [],
      label: 'scheduledCqTasks',
      description: 'scheduledCqTasksDesc',
      scope: 'operator',
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
    },
    scheduledCqIntervalMinutes: {
      type: 'number',
      default: DEFAULT_INTERVAL_MINUTES,
      label: 'scheduledCqIntervalMinutes',
      description: 'scheduledCqIntervalMinutesDesc',
      scope: 'operator',
      min: 1,
      max: 1440,
      visibleWhen: { setting: 'scheduledCqIntervalEnabled', equals: true },
    },
  },

  quickSettings: [
    { settingKey: 'scheduledCqEnabled' },
    { settingKey: 'scheduledCqTasks' },
    { settingKey: 'scheduledCqIntervalEnabled' },
    { settingKey: 'scheduledCqIntervalMinutes' },
  ],

  onLoad(ctx) {
    configureTimer(ctx);
  },

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
  runScheduledCqCheck,
};
