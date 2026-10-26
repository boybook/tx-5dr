import { fileURLToPath } from 'url';
import path from 'path';
import { definePlugin, type PluginUIRequestContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };
import { WaveLogSyncProvider } from './provider.js';
import { normalizeCallsign } from '@tx5dr/plugin-api';

export const BUILTIN_WAVELOG_SYNC_PLUGIN_NAME = 'wavelog-sync';

/** Plugin directory path (works in both tsx dev and tsc dist). */
export const wavelogSyncDirPath = path.dirname(fileURLToPath(import.meta.url));

function requireBoundCallsign(
  requestContext: PluginUIRequestContext,
): string {
  if (requestContext.resource?.kind === 'callsign' && requestContext.resource.value.trim()) {
    return normalizeCallsign(requestContext.resource.value);
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
export const wavelogSyncPlugin = definePlugin({
  apiVersion: 2,
  name: BUILTIN_WAVELOG_SYNC_PLUGIN_NAME,
  version: '1.1.0',
  type: 'utility',
  instanceScope: 'global',
  description: 'Sync QSO records with a WaveLog server',

  permissions: ['network', 'logbook:read', 'logbook:write', 'logbook:sync'],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        styles: 'standard',
        title: 'WaveLog Settings',
        entry: 'settings.html',
        accessScope: 'operator',
        resourceBinding: 'callsign',
      },
      { id: 'sync', title: 'WaveLog Sync', entry: 'sync.html', styles: 'standard', dialogSize: 'lg', accessScope: 'operator', resourceBinding: 'callsign' },
    ],
  },

  async onLoad(ctx) {
    const provider = new WaveLogSyncProvider(ctx);
    ctx.logbookSync.register(provider);

    // Register UI page handler for iframe communication
    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown, requestContext) {
        if (data !== undefined && (!data || typeof data !== 'object' || Array.isArray(data))) throw new Error('Invalid page request');
        const d = (data ?? {}) as Record<string, unknown>;
        const callsign = requireBoundCallsign(requestContext);
        const owner = requestContext.pageSessionId;
        switch (action) {
          case 'beginSync': {
            if (!['upload', 'download', 'full_sync', 'reconcile'].includes(String(d.operation))) throw new Error('Invalid sync operation');
            return provider.sync.begin(callsign, d.operation as 'upload' | 'download' | 'full_sync' | 'reconcile', owner, typeof d.launchId === 'string' ? d.launchId : undefined);
          }
          case 'advanceSync':
            if (typeof d.operationId !== 'string' || !Number.isSafeInteger(d.step) || (d.step as number) < 0) throw new Error('Invalid sync step');
            return provider.sync.advance(callsign, d.operationId, d.step as number, owner);
          case 'getSyncStatus': return provider.getStatus(callsign);
          case 'getAutomaticUploadStatus': return provider.sync.getAutomaticStatus(callsign);
          case 'getSyncDetails':
            if (typeof d.operationId !== 'string' || d.offset !== undefined && (!Number.isSafeInteger(d.offset) || (d.offset as number) < 0)) throw new Error('Invalid details request');
            return provider.sync.getDetails(callsign, (d.offset as number | undefined) ?? 0, d.operationId);
          case 'renewSyncLease':
          case 'pauseSync':
            if (typeof d.operationId !== 'string') throw new Error('Invalid operation ID');
            if (action === 'renewSyncLease') await provider.sync.renew(callsign, d.operationId, owner);
            else await provider.sync.pause(callsign, d.operationId, owner);
            return { success: true };
        }
        switch (action) {
          case 'getConfig': {
            const cs = callsign;
            return provider.getPublicConfig(cs);
          }
          case 'saveConfig': {
            const cs = callsign;
            if (!d.config || typeof d.config !== 'object') throw new Error('Invalid configuration fields');
            const draft = d.config as Record<string, unknown>;
            if (typeof draft.url !== 'string' || typeof draft.apiKey !== 'string' || typeof draft.stationId !== 'string') throw new Error('Invalid configuration fields');
            // A paused or interrupted session still owns pending receipts; changing the
            // target would orphan them, so the operator must finish it first.
            if ((await provider.getStatus(cs).catch(() => null))?.resumable) {
              throw new Error('Finish the current sync before changing its configuration');
            }
            const key = draft.apiKey || provider.getConfig(cs)?.apiKey || '';
            const stations = await provider.fetchStationList(draft.url, key, draft.apiVersion === 'v2' ? 'v2' : draft.apiVersion === 'v1' ? 'v1' : undefined);
            const station = stations.find(item => item.station_id === draft.stationId);
            if (!station || normalizeCallsign(station.station_callsign) !== cs) throw new Error('Station profile callsign must match the bound callsign');
            provider.saveDraft(cs, d.config);
            await ctx.store.global.flush();
            return { success: true };
          }
          case 'testConnection': {
            if (typeof d.url !== 'string' || d.apiKey !== undefined && typeof d.apiKey !== 'string') throw new Error('Invalid connection fields');
            const url = d.url as string;
            const apiKey = typeof d.apiKey === 'string' && d.apiKey ? d.apiKey : provider.getConfig(callsign)?.apiKey ?? '';
            try {
              const stations = await provider.fetchStationList(url, apiKey, d.apiVersion === 'v2' ? 'v2' : d.apiVersion === 'v1' ? 'v1' : undefined);
              return { success: true, stations };
            } catch (err) {
              return {
                success: false,
                message: err instanceof Error ? err.message : 'Connection failed',
              };
            }
          }
          case 'getStations': {
            if (typeof d.url !== 'string' || d.apiKey !== undefined && typeof d.apiKey !== 'string') throw new Error('Invalid connection fields');
            const url = d.url as string;
            const apiKey = typeof d.apiKey === 'string' && d.apiKey ? d.apiKey : provider.getConfig(callsign)?.apiKey ?? '';
            try {
              const stations = await provider.fetchStationList(url, apiKey, d.apiVersion === 'v2' ? 'v2' : d.apiVersion === 'v1' ? 'v1' : undefined);
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
});

export const wavelogSyncLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};
