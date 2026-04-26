import { fileURLToPath } from 'url';
import path from 'path';
import type { PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import { LoTWSyncProvider, type LoTWPluginConfig } from './provider.js';
import { normalizeCallsign } from '@tx5dr/plugin-api';

export const BUILTIN_LOTW_SYNC_PLUGIN_NAME = 'lotw-sync';

/** Plugin directory path (works in both tsx dev and tsc dist). */
export const lotwSyncDirPath = path.dirname(fileURLToPath(import.meta.url));

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

function buildDefaultConfig(callsign: string): LoTWPluginConfig {
  return {
    username: '',
    password: '',
    uploadLocation: {
      callsign,
      dxccId: undefined,
      gridSquare: '',
      cqZone: '',
      ituZone: '',
      iota: undefined,
      state: undefined,
      county: undefined,
    },
    autoUploadQSO: false,
  };
}

function mergeDraftConfig(
  callsign: string,
  base: LoTWPluginConfig | null,
  draft: unknown,
): LoTWPluginConfig {
  const fallback = base ?? buildDefaultConfig(callsign);
  const patch = (draft && typeof draft === 'object') ? draft as Partial<LoTWPluginConfig> : {};
  const uploadPatch = (patch.uploadLocation && typeof patch.uploadLocation === 'object')
    ? patch.uploadLocation as Partial<LoTWPluginConfig['uploadLocation']>
    : {};

  return {
    ...fallback,
    username: typeof patch.username === 'string' ? patch.username : fallback.username,
    password: typeof patch.password === 'string' ? patch.password : fallback.password,
    uploadLocation: {
      ...fallback.uploadLocation,
      callsign: typeof uploadPatch.callsign === 'string'
        ? uploadPatch.callsign
        : fallback.uploadLocation.callsign,
      dxccId: typeof uploadPatch.dxccId === 'number'
        ? uploadPatch.dxccId
        : fallback.uploadLocation.dxccId,
      gridSquare: typeof uploadPatch.gridSquare === 'string'
        ? uploadPatch.gridSquare
        : fallback.uploadLocation.gridSquare,
      cqZone: typeof uploadPatch.cqZone === 'string'
        ? uploadPatch.cqZone
        : fallback.uploadLocation.cqZone,
      ituZone: typeof uploadPatch.ituZone === 'string'
        ? uploadPatch.ituZone
        : fallback.uploadLocation.ituZone,
      iota: typeof uploadPatch.iota === 'string' ? uploadPatch.iota : fallback.uploadLocation.iota,
      state: typeof uploadPatch.state === 'string' ? uploadPatch.state : fallback.uploadLocation.state,
      county: typeof uploadPatch.county === 'string' ? uploadPatch.county : fallback.uploadLocation.county,
    },
    autoUploadQSO: typeof patch.autoUploadQSO === 'boolean'
      ? patch.autoUploadQSO
      : fallback.autoUploadQSO,
    lastUploadTime: fallback.lastUploadTime,
    lastDownloadTime: fallback.lastDownloadTime,
  };
}

/**
 * LoTW Sync — built-in utility plugin
 *
 * Registers a LogbookSyncProvider for ARRL Logbook of The World, exposing:
 * - Per-callsign configuration (username, password, upload location, auto-upload)
 * - Certificate management (.p12 import, list, delete)
 * - QSO upload via TQ8 format with RSA-SHA1 signing
 * - QSO confirmation download via ADIF
 * - iframe settings page for configuration
 *
 * Configuration is stored in the plugin's global KVStore keyed by callsign.
 * Certificate files are stored as JSON via ctx.files under certificates/.
 */
export const lotwSyncPlugin: PluginDefinition = {
  name: BUILTIN_LOTW_SYNC_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  instanceScope: 'global',
  description: 'Sync QSO records with ARRL Logbook of The World',

  permissions: ['network'],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        title: 'LoTW Settings',
        entry: 'settings.html',
        accessScope: 'operator',
        resourceBinding: 'callsign',
      },
      {
        id: 'download-wizard',
        title: 'LoTW Download',
        entry: 'download-wizard.html',
        accessScope: 'operator',
        resourceBinding: 'callsign',
      },
    ],
  },

  async onLoad(ctx) {
    const provider = new LoTWSyncProvider(ctx);
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
              username: string;
              password: string;
              uploadLocation: {
                callsign: string;
                dxccId?: number;
                gridSquare: string;
                cqZone: string;
                ituZone: string;
                iota?: string;
                state?: string;
                county?: string;
              };
              autoUploadQSO: boolean;
            };
            provider.setConfig(cs, config);
            return { success: true };
          }
          case 'testConnection': {
            const cs = requireBoundCallsign(requestContext, d);
            return provider.testConnection(cs);
          }
          case 'testConnectionDraft': {
            const cs = requireBoundCallsign(requestContext, d);
            const draftConfig = mergeDraftConfig(cs, provider.getConfig(cs), d.config);
            return provider.testConnection(cs, draftConfig);
          }
          case 'importCertificate': {
            const cs = requireBoundCallsign(requestContext, d);
            const uploadedPath = d.path as string;
            if (!uploadedPath) {
              throw new Error('No certificate path provided');
            }
            const buffer = await requestContext.files.read(uploadedPath);
            if (!buffer) {
              throw new Error('Uploaded certificate file not found');
            }
            const imported = await provider.importCertificate(cs, buffer);
            await requestContext.files.delete(uploadedPath).catch(() => {});
            return {
              success: true,
              certificate: imported.certificate,
              duplicate: imported.duplicate,
              configUpdated: imported.configUpdated,
            };
          }
          case 'deleteCertificate': {
            const cs = requireBoundCallsign(requestContext, d);
            const certId = d.id as string;
            if (!certId) throw new Error('Certificate ID is required');
            const deleted = await provider.deleteCertificate(cs, certId);
            return { success: deleted, deletedId: certId };
          }
          case 'getCertificates': {
            const cs = requireBoundCallsign(requestContext, d);
            const certificates = await provider.getCertificates(cs);
            return { certificates };
          }
          case 'getUploadPreflight': {
            const cs = requireBoundCallsign(requestContext, d);
            return provider.getUploadPreflight(cs);
          }
          case 'getUploadPreflightDraft': {
            const cs = requireBoundCallsign(requestContext, d);
            const draftConfig = mergeDraftConfig(cs, provider.getConfig(cs), d.config);
            return provider.getUploadPreflight(cs, draftConfig);
          }
          case 'getLastDownloadTime': {
            const cs = requireBoundCallsign(requestContext, d);
            const config = provider.getConfig(cs);
            return { lastDownloadTime: config?.lastDownloadTime ?? null };
          }
          case 'performDownload': {
            const cs = requireBoundCallsign(requestContext, d);
            const since = d.since as number | undefined;
            try {
              const result = await provider.download(cs, since ? { since } : undefined);
              return result;
            } catch (err) {
              return {
                downloaded: 0, matched: 0, updated: 0,
                error: err instanceof Error ? err.message : 'Download failed',
              };
            }
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });

    ctx.log.info('LoTW sync provider registered');
  },
};

export const lotwSyncLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
