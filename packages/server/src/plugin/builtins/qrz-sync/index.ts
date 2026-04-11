import { fileURLToPath } from 'url';
import path from 'path';
import type { PluginDefinition } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import { QRZSyncProvider } from './provider.js';

export const BUILTIN_QRZ_SYNC_PLUGIN_NAME = 'qrz-sync';

/** Plugin directory path (works in both tsx dev and tsc dist). */
export const qrzSyncDirPath = path.dirname(fileURLToPath(import.meta.url));

/**
 * QRZ.com Sync — built-in utility plugin
 *
 * Registers a LogbookSyncProvider for QRZ.com, exposing:
 * - Per-callsign configuration (API key, auto-upload)
 * - QSO upload/download via QRZ.com Logbook API
 * - iframe settings page for configuration
 *
 * Configuration is stored in the plugin's global KVStore keyed by callsign.
 */
export const qrzSyncPlugin: PluginDefinition = {
  name: BUILTIN_QRZ_SYNC_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'Sync QSO records with QRZ.com Logbook',

  permissions: ['network'],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        title: 'QRZ.com Settings',
        entry: 'settings.html',
      },
    ],
  },

  async onLoad(ctx) {
    const provider = new QRZSyncProvider(ctx);
    ctx.logbookSync.register(provider);

    // Register UI page handler for iframe communication
    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown) {
        const d = data as Record<string, unknown>;
        switch (action) {
          case 'getConfig': {
            const cs = d.callsign as string;
            return provider.getConfig(cs);
          }
          case 'saveConfig': {
            const cs = d.callsign as string;
            const config = d.config as {
              apiKey: string;
              autoUploadQSO: boolean;
            };
            provider.setConfig(cs, config);
            return { success: true };
          }
          case 'testConnection': {
            const apiKey = d.apiKey as string;
            try {
              const result = await provider.fetchStatus(apiKey);
              return {
                success: true,
                callsign: result.callsign,
                logbookCount: result.logbookCount,
              };
            } catch (err) {
              return {
                success: false,
                message: err instanceof Error ? err.message : 'Connection failed',
              };
            }
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });

    ctx.log.info('QRZ.com sync provider registered');
  },
};

export const qrzSyncLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
