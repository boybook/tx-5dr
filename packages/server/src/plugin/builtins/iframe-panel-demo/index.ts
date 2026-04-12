import { fileURLToPath } from 'url';
import path from 'path';
import type { PluginDefinition, PluginContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const BUILTIN_IFRAME_PANEL_DEMO_PLUGIN_NAME = 'iframe-panel-demo';

export const iframePanelDemoDirPath = path.dirname(fileURLToPath(import.meta.url));

const TIMER_ID = 'push-tick';
const STATS_PANEL_ID = 'stats-kv';

function publishStats(ctx: PluginContext): void {
  ctx.ui.send(STATS_PANEL_ID, {
    Counter: ctx.store.operator.get<number>('counter', 0),
    Label: ctx.store.operator.get<string>('label', 'Demo'),
  });
}

export const iframePanelDemoPlugin: PluginDefinition = {
  name: BUILTIN_IFRAME_PANEL_DEMO_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'Demonstrates iframe custom UI panels in operator card and automation popover',

  panels: [
    // Operator card: live data push iframe panel
    {
      id: 'live-monitor',
      title: 'liveMonitorPanel',
      component: 'iframe',
      pageId: 'live-monitor',
    },
    // Automation popover: interactive iframe panel
    {
      id: 'quick-controls',
      title: 'quickControlsPanel',
      component: 'iframe',
      pageId: 'quick-controls',
      slot: 'automation',
    },
    // Automation popover: structured key-value panel for comparison
    {
      id: STATS_PANEL_ID,
      title: 'statsPanel',
      component: 'key-value',
      slot: 'automation',
    },
  ],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'live-monitor',
        title: 'Live Monitor',
        entry: 'live-monitor.html',
        accessScope: 'admin',
        resourceBinding: 'none',
      },
      {
        id: 'quick-controls',
        title: 'Quick Controls',
        entry: 'quick-controls.html',
        accessScope: 'admin',
        resourceBinding: 'none',
      },
    ],
  },

  storage: { scopes: ['operator'] },

  onLoad(ctx) {
    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown) {
        const d = data as Record<string, unknown>;
        switch (action) {
          case 'getState':
            return {
              counter: ctx.store.operator.get<number>('counter', 0),
              label: ctx.store.operator.get<string>('label', 'Demo'),
            };
          case 'increment': {
            const next = ctx.store.operator.get<number>('counter', 0) + 1;
            ctx.store.operator.set('counter', next);
            ctx.ui.pushToPage('live-monitor', 'counterUpdated', { counter: next });
            publishStats(ctx);
            return { counter: next };
          }
          case 'setLabel': {
            const label = d.label as string;
            ctx.store.operator.set('label', label);
            ctx.ui.pushToPage('live-monitor', 'labelUpdated', { label });
            publishStats(ctx);
            return { success: true };
          }
          case 'reset': {
            ctx.store.operator.set('counter', 0);
            ctx.store.operator.set('label', 'Demo');
            ctx.ui.pushToPage('live-monitor', 'stateReset', { counter: 0, label: 'Demo' });
            publishStats(ctx);
            return { counter: 0, label: 'Demo' };
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });

    ctx.timers.set(TIMER_ID, 2000);
    publishStats(ctx);
  },

  onUnload(ctx) {
    ctx.timers.clear(TIMER_ID);
  },

  hooks: {
    onTimer(timerId, ctx) {
      if (timerId !== TIMER_ID) return;
      ctx.ui.pushToPage('live-monitor', 'tick', {
        timestamp: Date.now(),
        signalStrength: -50 + Math.random() * 40,
        counter: ctx.store.operator.get<number>('counter', 0),
      });
    },
  },
};

export const iframePanelDemoLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
