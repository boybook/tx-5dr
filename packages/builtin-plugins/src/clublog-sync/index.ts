import { fileURLToPath } from 'url';
import path from 'path';
import type { PluginDefinition, PluginUIRequestContext } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };
import { createSyncFailure, normalizeCallsign } from '@tx5dr/plugin-api';
import { ClubLogSyncProvider, type ClubLogPluginConfig } from './provider.js';

export const BUILTIN_CLUBLOG_SYNC_PLUGIN_NAME = 'clublog-sync';

export const clublogSyncDirPath = path.dirname(fileURLToPath(import.meta.url));

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

function mergeDraftConfig(
  base: ClubLogPluginConfig | null,
  draft: unknown,
): ClubLogPluginConfig {
  const fallback: ClubLogPluginConfig = base ?? {
    email: '',
    password: '',
    autoUploadQSO: false,
  };
  const patch = draft && typeof draft === 'object' ? draft as Partial<ClubLogPluginConfig> : {};
  return {
    ...fallback,
    email: typeof patch.email === 'string' ? patch.email : fallback.email,
    password: typeof patch.password === 'string' ? patch.password : fallback.password,
    autoUploadQSO: typeof patch.autoUploadQSO === 'boolean' ? patch.autoUploadQSO : fallback.autoUploadQSO,
  };
}

export const clublogSyncPlugin: PluginDefinition = {
  name: BUILTIN_CLUBLOG_SYNC_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  instanceScope: 'global',
  description: 'Upload QSO records to Club Log',

  permissions: ['network'],

  ui: {
    dir: 'ui',
    pages: [
      {
        id: 'settings',
        title: 'Club Log Settings',
        entry: 'settings.html',
        accessScope: 'operator',
        resourceBinding: 'callsign',
      },
      {
        id: 'upload-wizard',
        title: 'Club Log Upload',
        entry: 'upload-wizard.html',
        accessScope: 'operator',
        resourceBinding: 'callsign',
      },
    ],
  },

  async onLoad(ctx) {
    const provider = new ClubLogSyncProvider(ctx);
    ctx.logbookSync.register(provider);

    ctx.ui.registerPageHandler({
      async onMessage(_pageId: string, action: string, data: unknown, requestContext) {
        const d = data as Record<string, unknown>;
        switch (action) {
          case 'getConfig': {
            const cs = requireBoundCallsign(requestContext, d);
            return {
              config: provider.getConfig(cs),
              apiKeyStatus: provider.getApiKeyStatus(),
            };
          }
          case 'saveConfig': {
            const cs = requireBoundCallsign(requestContext, d);
            const config = d.config as ClubLogPluginConfig;
            provider.setConfig(cs, {
              email: config.email,
              password: config.password,
              autoUploadQSO: !!config.autoUploadQSO,
              lastRealtimeUploadTime: provider.getConfig(cs)?.lastRealtimeUploadTime,
              lastBatchUploadTime: provider.getConfig(cs)?.lastBatchUploadTime,
            });
            return { success: true, apiKeyStatus: provider.getApiKeyStatus() };
          }
          case 'testConnection': {
            const cs = requireBoundCallsign(requestContext, d);
            return provider.testConnection(cs);
          }
          case 'testConnectionDraft': {
            const cs = requireBoundCallsign(requestContext, d);
            const draftConfig = mergeDraftConfig(provider.getConfig(cs), d.config);
            return provider.testConnection(cs, draftConfig);
          }
          case 'getUploadPreflight': {
            const cs = requireBoundCallsign(requestContext, d);
            const since = d.since as number | undefined;
            const until = d.until as number | undefined;
            const includeAlreadyUploaded = d.includeAlreadyUploaded === true;
            return provider.getUploadPreflight(cs, { since, until, includeAlreadyUploaded });
          }
          case 'performUpload': {
            const cs = requireBoundCallsign(requestContext, d);
            const since = d.since as number | undefined;
            const until = d.until as number | undefined;
            const includeAlreadyUploaded = d.includeAlreadyUploaded === true;
            const skipBlockedQsos = d.skipBlockedQsos === true;
            try {
              return await provider.upload(cs, {
                trigger: 'manual',
                since,
                until,
                includeAlreadyUploaded,
                skipBlockedQsos,
                onProgress: (progress) => {
                  requestContext.page.push('uploadProgress', progress);
                },
              });
            } catch (err) {
              return {
                uploaded: 0,
                skipped: 0,
                failed: 0,
                failures: [
                  createSyncFailure({
                    code: 'clublog_upload_failed',
                    message: err instanceof Error ? err.message : 'Upload failed',
                    source: 'provider',
                    operation: 'upload',
                    providerId: 'clublog',
                  }),
                ],
              };
            }
          }
          default:
            throw new Error(`Unknown action: ${action}`);
        }
      },
    });

    ctx.log.info('Club Log sync provider registered');
  },
};

export const clublogSyncLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};
