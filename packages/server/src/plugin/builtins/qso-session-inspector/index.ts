import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

const STATS_KEY = 'sessionStats';
const EVENTS_KEY = 'sessionEvents';
const STATS_PANEL_ID = 'session-stats';
const EVENTS_PANEL_ID = 'session-events';

interface SessionStats {
  slotCount: number;
  decodeCount: number;
  decodedMessageCount: number;
  startedQSOCount: number;
  completedQSOCount: number;
  failedQSOCount: number;
  lastTarget?: string;
  lastEvent?: string;
}

function getDefaultStats(): SessionStats {
  return {
    slotCount: 0,
    decodeCount: 0,
    decodedMessageCount: 0,
    startedQSOCount: 0,
    completedQSOCount: 0,
    failedQSOCount: 0,
  };
}

function getRecentLimit(ctx: PluginContext): number {
  const value = ctx.config.recentEventLimit;
  return typeof value === 'number' && value > 0 ? value : 12;
}

function readStats(ctx: PluginContext): SessionStats {
  return ctx.store.operator.get<SessionStats>(STATS_KEY, getDefaultStats());
}

function readEvents(ctx: PluginContext): string[] {
  return ctx.store.operator.get<string[]>(EVENTS_KEY, []);
}

function formatEvent(label: string, detail?: string): string {
  return detail ? `${new Date().toISOString()} ${label}: ${detail}` : `${new Date().toISOString()} ${label}`;
}

function publish(ctx: PluginContext): void {
  const stats = readStats(ctx);
  const events = readEvents(ctx);
  ctx.ui.send(STATS_PANEL_ID, {
    slots: stats.slotCount,
    decodes: stats.decodeCount,
    messages: stats.decodedMessageCount,
    qsoStarted: stats.startedQSOCount,
    qsoCompleted: stats.completedQSOCount,
    qsoFailed: stats.failedQSOCount,
    lastTarget: stats.lastTarget ?? '-',
    lastEvent: stats.lastEvent ?? '-',
  });
  ctx.ui.send(EVENTS_PANEL_ID, events);
}

function mutateStats(ctx: PluginContext, mutate: (stats: SessionStats) => SessionStats): void {
  const nextStats = mutate(readStats(ctx));
  ctx.store.operator.set(STATS_KEY, nextStats);
  publish(ctx);
}

function pushEvent(ctx: PluginContext, entry: string): void {
  const limit = getRecentLimit(ctx);
  const nextEvents = [entry, ...readEvents(ctx)].slice(0, limit);
  ctx.store.operator.set(EVENTS_KEY, nextEvents);
  publish(ctx);
}

export const qsoSessionInspectorPlugin: PluginDefinition = {
  name: 'qso-session-inspector',
  version: '1.0.0',
  type: 'utility',
  description: 'Inspect slot-level session activity and QSO lifecycle events',

  settings: {
    sessionOverview: {
      type: 'info',
      default: '',
      label: 'sessionOverview',
      description: 'sessionOverviewDesc',
      scope: 'operator',
    },
    recentEventLimit: {
      type: 'number',
      default: 12,
      label: 'recentEventLimit',
      description: 'recentEventLimitDesc',
      scope: 'operator',
      min: 3,
      max: 50,
    },
  },

  panels: [
    { id: STATS_PANEL_ID, title: 'sessionStatsPanel', component: 'key-value' },
    { id: EVENTS_PANEL_ID, title: 'sessionEventsPanel', component: 'log' },
  ],

  onLoad(ctx) {
    publish(ctx);
  },

  hooks: {
    onSlotStart(_slotInfo, _messages, ctx) {
      mutateStats(ctx, (stats) => ({
        ...stats,
        slotCount: stats.slotCount + 1,
        lastEvent: 'slotStart',
      }));
    },

    onDecode(messages, ctx) {
      mutateStats(ctx, (stats) => ({
        ...stats,
        decodeCount: stats.decodeCount + 1,
        decodedMessageCount: stats.decodedMessageCount + messages.length,
        lastEvent: `decode:${messages.length}`,
      }));
      if (messages.length > 0) {
        pushEvent(ctx, formatEvent('decode', `${messages.length} messages`));
      }
    },

    onQSOStart(info, ctx) {
      mutateStats(ctx, (stats) => ({
        ...stats,
        startedQSOCount: stats.startedQSOCount + 1,
        lastTarget: info.targetCallsign,
        lastEvent: `qsoStart:${info.targetCallsign}`,
      }));
      pushEvent(ctx, formatEvent('qso-start', info.targetCallsign));
    },

    onQSOComplete(record, ctx) {
      mutateStats(ctx, (stats) => ({
        ...stats,
        completedQSOCount: stats.completedQSOCount + 1,
        lastTarget: record.callsign,
        lastEvent: `qsoComplete:${record.callsign}`,
      }));
      pushEvent(ctx, formatEvent('qso-complete', record.callsign));
    },

    onQSOFail(info, ctx) {
      mutateStats(ctx, (stats) => ({
        ...stats,
        failedQSOCount: stats.failedQSOCount + 1,
        lastTarget: info.targetCallsign,
        lastEvent: `qsoFail:${info.reason}`,
      }));
      pushEvent(ctx, formatEvent('qso-fail', `${info.targetCallsign} (${info.reason})`));
    },

    onConfigChange(_changes, ctx) {
      const events = readEvents(ctx).slice(0, getRecentLimit(ctx));
      ctx.store.operator.set(EVENTS_KEY, events);
      publish(ctx);
    },
  },
};

export const qsoSessionInspectorLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
