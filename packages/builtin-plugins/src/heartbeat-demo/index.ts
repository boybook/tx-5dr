import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

const TIMER_ID = 'heartbeat';
const PANEL_ID = 'heartbeat-status';
const GLOBAL_COUNT_KEY = 'totalHeartbeatCount';
const GLOBAL_LAST_KEY = 'globalLastHeartbeatAt';
const OPERATOR_COUNT_KEY = 'operatorHeartbeatCount';
const OPERATOR_LAST_KEY = 'operatorLastHeartbeatAt';

function getInterval(ctx: PluginContext): number {
  const value = ctx.config.intervalMs;
  return typeof value === 'number' && value >= 1000 ? value : 5000;
}

function publish(ctx: PluginContext): void {
  ctx.ui.send(PANEL_ID, {
    globalCount: ctx.store.global.get<number>(GLOBAL_COUNT_KEY, 0),
    globalLastTick: ctx.store.global.get<string>(GLOBAL_LAST_KEY, '-'),
    operatorCount: ctx.store.operator.get<number>(OPERATOR_COUNT_KEY, 0),
    operatorLastTick: ctx.store.operator.get<string>(OPERATOR_LAST_KEY, '-'),
    intervalMs: getInterval(ctx),
    radioConnected: ctx.radio.isConnected ? 'yes' : 'no',
  });
}

function tick(ctx: PluginContext): void {
  const now = new Date().toISOString();
  ctx.store.global.set(GLOBAL_COUNT_KEY, ctx.store.global.get<number>(GLOBAL_COUNT_KEY, 0) + 1);
  ctx.store.global.set(GLOBAL_LAST_KEY, now);
  ctx.store.operator.set(OPERATOR_COUNT_KEY, ctx.store.operator.get<number>(OPERATOR_COUNT_KEY, 0) + 1);
  ctx.store.operator.set(OPERATOR_LAST_KEY, now);
  publish(ctx);
}

function reset(ctx: PluginContext): void {
  ctx.store.global.set(GLOBAL_COUNT_KEY, 0);
  ctx.store.global.set(GLOBAL_LAST_KEY, '-');
  ctx.store.operator.set(OPERATOR_COUNT_KEY, 0);
  ctx.store.operator.set(OPERATOR_LAST_KEY, '-');
  publish(ctx);
}

export const heartbeatDemoPlugin: PluginDefinition = {
  name: 'heartbeat-demo',
  version: '1.0.0',
  type: 'utility',
  description: 'Demonstrate plugin timers, global storage, panels, and button quick actions',

  settings: {
    heartbeatOverview: {
      type: 'info',
      default: '',
      label: 'heartbeatOverview',
      description: 'heartbeatOverviewDesc',
      scope: 'global',
    },
    intervalMs: {
      type: 'number',
      default: 5000,
      label: 'intervalMs',
      description: 'intervalMsDesc',
      scope: 'global',
      min: 1000,
      max: 60000,
    },
  },

  quickActions: [
    {
      id: 'resetHeartbeat',
      label: 'resetHeartbeat',
    },
  ],

  panels: [
    { id: PANEL_ID, title: 'heartbeatStatusPanel', component: 'key-value' },
  ],

  onLoad(ctx) {
    ctx.timers.set(TIMER_ID, getInterval(ctx));
    publish(ctx);
  },

  onUnload(ctx) {
    ctx.timers.clear(TIMER_ID);
  },

  hooks: {
    onTimer(timerId, ctx) {
      if (timerId !== TIMER_ID) {
        return;
      }
      tick(ctx);
    },

    onUserAction(actionId, _payload, ctx) {
      if (actionId === 'resetHeartbeat') {
        reset(ctx);
      }
    },

    onConfigChange(_changes, ctx) {
      ctx.timers.set(TIMER_ID, getInterval(ctx));
      publish(ctx);
    },
  },
};

export const heartbeatDemoLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
