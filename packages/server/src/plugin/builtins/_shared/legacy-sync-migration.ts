import { promises as fs } from 'fs';
import path from 'path';
import { ConfigManager, type AppConfig } from '../../../config/config-manager.js';
import { getConfigFilePath } from '../../../utils/app-paths.js';
import { normalizeCallsign } from '../../../utils/callsign.js';
import type { PluginContext } from '@tx5dr/plugin-api';

type LegacyProviderKey = 'lotw' | 'qrz' | 'wavelog';

type LegacyCallsignSyncEntry = {
  callsign?: string;
  lotw?: Record<string, unknown>;
  qrz?: Record<string, unknown>;
  wavelog?: Record<string, unknown>;
};

type LegacySyncCarrier = AppConfig & {
  operators?: Array<{ myCallsign?: string }>;
  callsignSyncConfigs?: Record<string, LegacyCallsignSyncEntry>;
  lotw?: Record<string, unknown>;
  qrz?: Record<string, unknown>;
  wavelog?: Record<string, unknown>;
};

interface LegacyMigrationOptions<TConfig extends Record<string, unknown>> {
  ctx: PluginContext;
  pluginName: string;
  providerKey: LegacyProviderKey;
  mapLegacyConfig: (callsign: string, legacyConfig: Record<string, unknown>) => TConfig | null;
  shouldMigrate?: (legacyConfig: Record<string, unknown>) => boolean;
  afterStoreMigration?: (args: {
    callsign: string;
    legacyConfig: Record<string, unknown>;
    configManager: ConfigManager;
  }) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getLegacyConfigKey(callsign: string): string {
  return `config:${normalizeCallsign(callsign)}`;
}

function cloneConfig(config: LegacySyncCarrier): LegacySyncCarrier {
  return JSON.parse(JSON.stringify(config)) as LegacySyncCarrier;
}

function collectOperatorCallsigns(config: LegacySyncCarrier): string[] {
  const result = new Set<string>();
  for (const operator of config.operators ?? []) {
    const callsign = operator?.myCallsign?.trim();
    if (callsign) {
      result.add(normalizeCallsign(callsign));
    }
  }
  return Array.from(result);
}

function pruneLegacyCallsignConfigs(config: LegacySyncCarrier): void {
  const entries = config.callsignSyncConfigs;
  if (!entries || !isRecord(entries)) {
    delete config.callsignSyncConfigs;
    return;
  }

  for (const [key, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) {
      delete entries[key];
      continue;
    }

    const hasProviderPayload = ['lotw', 'qrz', 'wavelog'].some((providerKey) => {
      const payload = entry[providerKey as LegacyProviderKey];
      return isRecord(payload) && Object.keys(payload).length > 0;
    });

    if (!hasProviderPayload) {
      delete entries[key];
    }
  }

  if (Object.keys(entries).length === 0) {
    delete config.callsignSyncConfigs;
  }
}

async function writeMigrationBackup(
  ctx: PluginContext,
  providerKey: LegacyProviderKey,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.files.write(
    `migration/legacy-${providerKey}-backup.json`,
    Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'),
  );
}

export async function migrateLegacySyncConfig<TConfig extends Record<string, unknown>>(
  options: LegacyMigrationOptions<TConfig>,
): Promise<void> {
  const {
    ctx,
    pluginName,
    providerKey,
    mapLegacyConfig,
    shouldMigrate = (legacyConfig) => Object.keys(legacyConfig).length > 0,
    afterStoreMigration,
  } = options;

  const configManager = ConfigManager.getInstance();
  const currentConfig = configManager.getConfig() as LegacySyncCarrier;
  const callsignEntries = isRecord(currentConfig.callsignSyncConfigs)
    ? currentConfig.callsignSyncConfigs
    : {};
  const normalizedEntryMap = new Map<string, LegacyCallsignSyncEntry>();
  for (const [entryKey, entry] of Object.entries(callsignEntries)) {
    if (!isRecord(entry)) {
      continue;
    }
    normalizedEntryMap.set(normalizeCallsign(entry.callsign || entryKey), entry);
  }
  const topLevelConfig = currentConfig[providerKey];

  const candidateCallsigns = new Set<string>();
  for (const [entryKey, entry] of Object.entries(callsignEntries)) {
    if (!isRecord(entry)) continue;
    const legacyProviderConfig = entry[providerKey];
    if (!isRecord(legacyProviderConfig) || !shouldMigrate(legacyProviderConfig)) {
      continue;
    }
    candidateCallsigns.add(normalizeCallsign(entry.callsign || entryKey));
  }

  if (isRecord(topLevelConfig) && shouldMigrate(topLevelConfig)) {
    for (const callsign of collectOperatorCallsigns(currentConfig)) {
      candidateCallsigns.add(callsign);
    }
  }

  if (candidateCallsigns.size === 0) {
    return;
  }

  const backup: Record<string, unknown> = {
    pluginName,
    providerKey,
    migratedAt: Date.now(),
    topLevelConfig: isRecord(topLevelConfig) ? topLevelConfig : null,
    callsignEntries: Array.from(candidateCallsigns).map((callsign) => ({
      callsign,
      legacyConfig: normalizedEntryMap.get(callsign)?.[providerKey] ?? null,
    })),
  };

  const migratedCallsigns: string[] = [];
  for (const callsign of candidateCallsigns) {
    const legacyConfig = normalizedEntryMap.get(callsign)?.[providerKey];
    const sourceConfig = isRecord(legacyConfig) && shouldMigrate(legacyConfig)
      ? legacyConfig
      : (isRecord(topLevelConfig) && shouldMigrate(topLevelConfig) ? topLevelConfig : null);
    if (!sourceConfig) {
      continue;
    }

    const nextConfig = mapLegacyConfig(callsign, sourceConfig);
    if (!nextConfig) {
      continue;
    }

    const configKey = getLegacyConfigKey(callsign);
    const existing = ctx.store.global.get<TConfig | undefined>(configKey);
    ctx.store.global.set(configKey, existing ? { ...nextConfig, ...existing } : nextConfig);

    if (afterStoreMigration) {
      await afterStoreMigration({ callsign, legacyConfig: sourceConfig, configManager });
    }

    migratedCallsigns.push(callsign);
  }

  if (migratedCallsigns.length === 0) {
    return;
  }

  await writeMigrationBackup(ctx, providerKey, {
    ...backup,
    migratedCallsigns,
  });
  ctx.store.global.set(`migration:${providerKey}:legacy-sync`, {
    migratedAt: Date.now(),
    migratedCallsigns,
  });

  const nextConfig = cloneConfig(currentConfig);
  delete nextConfig[providerKey];

  if (isRecord(nextConfig.callsignSyncConfigs)) {
    for (const entry of Object.values(nextConfig.callsignSyncConfigs)) {
      if (isRecord(entry)) {
        delete entry[providerKey];
      }
    }
  }

  pruneLegacyCallsignConfigs(nextConfig);
  await configManager.replaceConfigForMigration(nextConfig as AppConfig & Record<string, unknown>);

  ctx.log.info('Legacy sync config migrated', {
    providerKey,
    callsigns: migratedCallsigns,
  });
}

export async function migrateLegacyLotwCertificates(ctx: PluginContext): Promise<void> {
  const keepFile = await getConfigFilePath(path.join('lotw', 'certificates', '.keep'));
  const legacyDir = path.dirname(keepFile);

  let entries: string[];
  try {
    entries = await fs.readdir(legacyDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }

  const copiedFiles: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const sourcePath = path.join(legacyDir, entry);
    const targetPath = `certificates/${entry}`;
    const existing = await ctx.files.read(targetPath);
    if (existing) {
      continue;
    }

    const data = await fs.readFile(sourcePath);
    await ctx.files.write(targetPath, data);
    copiedFiles.push(entry);
  }

  if (copiedFiles.length === 0) {
    return;
  }

  await ctx.files.write(
    'migration/legacy-lotw-certificates.json',
    Buffer.from(JSON.stringify({
      migratedAt: Date.now(),
      files: copiedFiles,
      legacyDir,
    }, null, 2), 'utf-8'),
  );

  for (const entry of copiedFiles) {
    await fs.unlink(path.join(legacyDir, entry)).catch(() => {});
  }
  await fs.rm(legacyDir, { recursive: true, force: true }).catch(() => {});

  ctx.log.info('Legacy LoTW certificates migrated', { count: copiedFiles.length });
}
