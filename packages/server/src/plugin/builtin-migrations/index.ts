/**
 * Built-in plugin migration shims.
 *
 * These functions migrate legacy app config data into the new per-plugin
 * KVStore format. They are called by the PluginManager BEFORE invoking
 * each built-in plugin's onLoad hook.
 *
 * Migration code depends on server internals (ConfigManager, app-paths)
 * and therefore stays in the server package. The extracted
 * @tx5dr/builtin-plugins package does not contain any migration logic.
 */

import type { PluginContext } from '@tx5dr/plugin-api';
import {
  migrateLegacySyncConfig,
  migrateLegacyLotwCertificates,
} from './legacy-sync-migration.js';

/**
 * Map of built-in plugin names to their pre-onLoad migration functions.
 * Only plugins that need legacy config migration are listed here.
 */
export const BUILTIN_MIGRATIONS: Record<string, (ctx: PluginContext) => Promise<void>> = {
  'lotw-sync': async (ctx) => {
    await migrateLegacyLotwCertificates(ctx);
    await migrateLegacySyncConfig({
      ctx,
      pluginName: 'lotw-sync',
      providerKey: 'lotw',
      shouldMigrate: (legacyConfig) =>
        !!legacyConfig.username
        || !!legacyConfig.password
        || !!legacyConfig.uploadLocation
        || Boolean(Array.isArray(legacyConfig.certificates) && legacyConfig.certificates.length > 0),
      mapLegacyConfig: (callsign, legacyConfig) => {
        const uploadLocation = typeof legacyConfig.uploadLocation === 'object' && legacyConfig.uploadLocation
          ? legacyConfig.uploadLocation as Record<string, unknown>
          : {};
        return {
          username: typeof legacyConfig.username === 'string' ? legacyConfig.username : '',
          password: typeof legacyConfig.password === 'string' ? legacyConfig.password : '',
          uploadLocation: {
            callsign: typeof uploadLocation.callsign === 'string' && uploadLocation.callsign
              ? uploadLocation.callsign
              : callsign,
            dxccId: typeof uploadLocation.dxccId === 'number' ? uploadLocation.dxccId : undefined,
            gridSquare: typeof uploadLocation.gridSquare === 'string' ? uploadLocation.gridSquare : '',
            cqZone: typeof uploadLocation.cqZone === 'string' ? uploadLocation.cqZone : '',
            ituZone: typeof uploadLocation.ituZone === 'string' ? uploadLocation.ituZone : '',
            iota: typeof uploadLocation.iota === 'string' ? uploadLocation.iota : undefined,
            state: typeof uploadLocation.state === 'string' ? uploadLocation.state : undefined,
            county: typeof uploadLocation.county === 'string' ? uploadLocation.county : undefined,
          },
          autoUploadQSO: Boolean(legacyConfig.autoUploadQSO),
          lastUploadTime: typeof legacyConfig.lastUploadTime === 'number' ? legacyConfig.lastUploadTime : undefined,
          lastDownloadTime: typeof legacyConfig.lastDownloadTime === 'number' ? legacyConfig.lastDownloadTime : undefined,
        };
      },
    });
  },

  'qrz-sync': async (ctx) => {
    await migrateLegacySyncConfig({
      ctx,
      pluginName: 'qrz-sync',
      providerKey: 'qrz',
      shouldMigrate: (legacyConfig) => !!legacyConfig.apiKey,
      mapLegacyConfig: (_callsign, legacyConfig) => ({
        apiKey: typeof legacyConfig.apiKey === 'string' ? legacyConfig.apiKey : '',
        autoUploadQSO: Boolean(legacyConfig.autoUploadQSO),
        lastSyncTime: typeof legacyConfig.lastSyncTime === 'number' ? legacyConfig.lastSyncTime : undefined,
      }),
    });
  },

  'wavelog-sync': async (ctx) => {
    await migrateLegacySyncConfig({
      ctx,
      pluginName: 'wavelog-sync',
      providerKey: 'wavelog',
      shouldMigrate: (legacyConfig) => !!legacyConfig.url || !!legacyConfig.apiKey || !!legacyConfig.stationId,
      mapLegacyConfig: (_callsign, legacyConfig) => ({
        url: typeof legacyConfig.url === 'string' ? legacyConfig.url : '',
        apiKey: typeof legacyConfig.apiKey === 'string' ? legacyConfig.apiKey : '',
        stationId: typeof legacyConfig.stationId === 'string' ? legacyConfig.stationId : '',
        radioName: typeof legacyConfig.radioName === 'string' ? legacyConfig.radioName : 'TX5DR',
        autoUploadQSO: Boolean(legacyConfig.autoUploadQSO),
        lastSyncTime: typeof legacyConfig.lastSyncTime === 'number' ? legacyConfig.lastSyncTime : undefined,
      }),
    });
  },
};
