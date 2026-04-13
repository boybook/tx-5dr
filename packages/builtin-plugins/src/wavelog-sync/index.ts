import { fileURLToPath } from 'url';
import path from 'path';
import type { PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import { WaveLogSyncProvider } from './provider.js';
import { normalizeCallsign } from '@tx5dr/plugin-api';

export const BUILTIN_WAVELOG_SYNC_PLUGIN_NAME = 'wavelog-sync';

/** Plugin directory path (works in both tsx dev and tsc dist). */
export const wavelogSyncDirPath = path.dirname(fileURLToPath(import.meta.url));

function requireBoundCallsign(
  requestContext: PluginUIRequestContext,
  data: Record<string, unknown>,
): string {
  if (requestContext.resource?.kind === 'callsign' && requestContext.resource.value.trim()) {
    return normalizeCallsign(requestContext.resource.value);
  }
  if (typeof data.callsign === 'string' && data.callsign.trim()) {
    return normalizeCallsign(data.callsign);
  }
  throw new Error('Callsign binding is required');
}

/**
 * WaveLog Sync — built-in utility plugin
 *
 * Registers a LogbookSyncProvider for WaveLog, exposing:
 * - Per-callsign configuration (URL, API key, station, auto-upload)
 * - QSO upload/download via WaveLog HTTP API
 * - iframe settings page for configuration
 *
 * Configuration is stored in the plugin's global KVStore keyed by callsign.
 */
export const wavelogSyncPlugin: PluginDefinition = {
  name: BUILTIN_WAVELOG_SYNC_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  instanceScope: 'global',
  description: 'Sync QSO records with a WaveLog server',

  permissions: ['network'],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        title: 'WaveLog Settings',
        entry: 'settings.html',
        accessScope: 'operator',
        resourceBinding: 'callsign',
      },
    ],
  },

  async onLoad(ctx) {
    const provider = new WaveLogSyncProvider(ctx);
    ctx.logbookSync.register(provider);

    // Register UI page handler for iframe communication
    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown, requestContext) {
        const d = data as Record<string, unknown>;
        switch (action) {
          case 'getConfig': {
            const cs = requireBoundCallsign(requestContext, d);
            return provider.getConfig(cs);
          }
          case 'saveConfig': {
            const cs = requireBoundCallsign(requestContext, d);
            const config = d.config as {
              url: string;
              apiKey: string;
              stationId: string;
              radioName: string;
              autoUploadQSO: boolean;
            };
            provider.setConfig(cs, config);
            return { success: true };
          }
          case 'testConnection': {
            const url = d.url as string;
            const apiKey = d.apiKey as string;
            try {
              const stations = await provider.fetchStationList(url, apiKey);
              return { success: true, stations };
            } catch (err) {
              return {
                success: false,
                message: err instanceof Error ? err.message : 'Connection failed',
              };
            }
          }
          case 'getStations': {
            const url = d.url as string;
            const apiKey = d.apiKey as string;
            try {
              const stations = await provider.fetchStationList(url, apiKey);
              return { stations };
            } catch (err) {
              return {
                stations: [],
                error: err instanceof Error ? err.message : 'Failed to fetch stations',
              };
            }
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });

    ctx.log.info('WaveLog sync provider registered');
  },
};

export const wavelogSyncLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
