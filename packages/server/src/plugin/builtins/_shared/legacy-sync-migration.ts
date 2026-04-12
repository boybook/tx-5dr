import { promises as fs } from 'fs';
import path from 'path';
import { ConfigManager, type AppConfig } from '../../../config/config-manager.js';
import { getConfigFilePath } from '../../../utils/app-paths.js';
import { normalizeCallsign } from '../../../utils/callsign.js';
import type { PluginContext } from '@tx5dr/plugin-api';
import type { FlushableKVStore } from '../../types.js';
import { getPluginPageScopePath } from '../../page-scope.js';

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

type MigrationPhase = 'detected' | 'target_written' | 'source_cleaned' | 'completed';

interface LegacySyncMigrationJournal {
  pluginName: string;
  providerKey: LegacyProviderKey;
  phase: MigrationPhase;
  startedAt: number;
  updatedAt: number;
  migratedCallsigns: string[];
}

interface LegacyLotwCertificateJournal {
  phase: MigrationPhase;
  legacyDir: string;
  startedAt: number;
  updatedAt: number;
  migratedFiles: string[];
  orphanFiles: string[];
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

function getMigrationBackupPath(providerKey: LegacyProviderKey): string {
  return `migration/legacy-${providerKey}-backup.json`;
}

function getMigrationJournalPath(providerKey: LegacyProviderKey): string {
  return `migration/legacy-${providerKey}-journal.json`;
}

async function readJSONFile<T>(ctx: PluginContext, filePath: string): Promise<T | null> {
  const data = await ctx.files.read(filePath);
  if (!data) {
    return null;
  }
  return JSON.parse(data.toString('utf-8')) as T;
}

async function writeJSONFile(ctx: PluginContext, filePath: string, payload: unknown): Promise<void> {
  await ctx.files.write(
    filePath,
    Buffer.from(JSON.stringify(payload, null, 2), 'utf-8'),
  );
}

async function writeLegacySyncJournal(
  ctx: PluginContext,
  providerKey: LegacyProviderKey,
  journal: Omit<LegacySyncMigrationJournal, 'updatedAt'>,
): Promise<void> {
  await writeJSONFile(ctx, getMigrationJournalPath(providerKey), {
    ...journal,
    updatedAt: Date.now(),
  });
}

async function writeLegacyLotwJournal(
  ctx: PluginContext,
  journal: Omit<LegacyLotwCertificateJournal, 'updatedAt'>,
): Promise<void> {
  await writeJSONFile(ctx, 'migration/legacy-lotw-certificates-journal.json', {
    ...journal,
    updatedAt: Date.now(),
  });
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

  const existingJournal = await readJSONFile<LegacySyncMigrationJournal>(ctx, getMigrationJournalPath(providerKey));
  if (existingJournal?.phase === 'completed') {
    return;
  }

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

  const startedAt = existingJournal?.startedAt ?? Date.now();
  const backupPath = getMigrationBackupPath(providerKey);
  const backupExists = await ctx.files.read(backupPath);
  if (!backupExists) {
    await writeJSONFile(ctx, backupPath, {
      pluginName,
      providerKey,
      migratedAt: Date.now(),
      topLevelConfig: isRecord(topLevelConfig) ? topLevelConfig : null,
      callsignEntries: Array.from(candidateCallsigns).map((callsign) => ({
        callsign,
        legacyConfig: normalizedEntryMap.get(callsign)?.[providerKey] ?? null,
      })),
    });
  }

  const migratedCallsigns = new Set(existingJournal?.migratedCallsigns ?? []);
  await writeLegacySyncJournal(ctx, providerKey, {
    pluginName,
    providerKey,
    phase: existingJournal?.phase ?? 'detected',
    startedAt,
    migratedCallsigns: Array.from(migratedCallsigns),
  });

  if (!existingJournal || existingJournal.phase === 'detected') {
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

      migratedCallsigns.add(callsign);
    }

    if (migratedCallsigns.size === 0) {
      return;
    }

    await (ctx.store.global as FlushableKVStore).flush();
    await writeLegacySyncJournal(ctx, providerKey, {
      pluginName,
      providerKey,
      phase: 'target_written',
      startedAt,
      migratedCallsigns: Array.from(migratedCallsigns),
    });
  }

  if (!existingJournal || existingJournal.phase === 'detected' || existingJournal.phase === 'target_written') {
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

    await writeLegacySyncJournal(ctx, providerKey, {
      pluginName,
      providerKey,
      phase: 'source_cleaned',
      startedAt,
      migratedCallsigns: Array.from(migratedCallsigns),
    });
  }

  ctx.store.global.set(`migration:${providerKey}:legacy-sync`, {
    migratedAt: Date.now(),
    migratedCallsigns: Array.from(migratedCallsigns),
  });
  await (ctx.store.global as FlushableKVStore).flush();

  await writeLegacySyncJournal(ctx, providerKey, {
    pluginName,
    providerKey,
    phase: 'completed',
    startedAt,
    migratedCallsigns: Array.from(migratedCallsigns),
  });

  ctx.log.info('Legacy sync config migrated', {
    providerKey,
    callsigns: Array.from(migratedCallsigns),
  });
}

export async function migrateLegacyLotwCertificates(ctx: PluginContext): Promise<void> {
  const keepFile = await getConfigFilePath(path.join('lotw', 'certificates', '.keep'));
  const legacyDir = path.dirname(keepFile);
  const existingJournal = await readJSONFile<LegacyLotwCertificateJournal>(
    ctx,
    'migration/legacy-lotw-certificates-journal.json',
  );
  if (existingJournal?.phase === 'completed') {
    return;
  }

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

  const startedAt = existingJournal?.startedAt ?? Date.now();
  const migratedFiles = new Set(existingJournal?.migratedFiles ?? []);
  const orphanFiles = new Set(existingJournal?.orphanFiles ?? []);
  const jsonEntries = entries.filter((entry) => entry.endsWith('.json'));
  if (jsonEntries.length === 0) {
    return;
  }

  const backupPath = 'migration/legacy-lotw-certificates-backup.json';
  const backupExists = await ctx.files.read(backupPath);
  if (!backupExists) {
    await writeJSONFile(ctx, backupPath, {
      legacyDir,
      files: jsonEntries,
      detectedAt: Date.now(),
    });
  }

  await writeLegacyLotwJournal(ctx, {
    phase: existingJournal?.phase ?? 'detected',
    legacyDir,
    startedAt,
    migratedFiles: Array.from(migratedFiles),
    orphanFiles: Array.from(orphanFiles),
  });

  if (!existingJournal || existingJournal.phase === 'detected') {
    for (const entry of jsonEntries) {
      const sourcePath = path.join(legacyDir, entry);
      const data = await fs.readFile(sourcePath);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
      } catch {
        parsed = null;
      }

      const certCallsign = typeof parsed?.callsign === 'string' && parsed.callsign.trim()
        ? normalizeCallsign(parsed.callsign)
        : null;
      if (!certCallsign) {
        await ctx.files.write(`migration/orphan-certificates/${entry}`, data);
        orphanFiles.add(entry);
        continue;
      }

      const certId = typeof parsed?.id === 'string' && parsed.id.trim()
        ? parsed.id
        : entry.replace(/\.json$/i, '');
      const targetPath = path.posix.join(
        getPluginPageScopePath({ kind: 'callsign', value: certCallsign }),
        'certificates',
        `${certId}.json`,
      );
      const existing = await ctx.files.read(targetPath);
      if (!existing) {
        await ctx.files.write(targetPath, data);
      }
      migratedFiles.add(entry);
    }

    await writeLegacyLotwJournal(ctx, {
      phase: 'target_written',
      legacyDir,
      startedAt,
      migratedFiles: Array.from(migratedFiles),
      orphanFiles: Array.from(orphanFiles),
    });
  }

  if (!existingJournal || existingJournal.phase === 'detected' || existingJournal.phase === 'target_written') {
    for (const entry of jsonEntries) {
      await fs.unlink(path.join(legacyDir, entry)).catch(() => {});
    }
    await fs.rm(legacyDir, { recursive: true, force: true }).catch(() => {});

    await writeLegacyLotwJournal(ctx, {
      phase: 'source_cleaned',
      legacyDir,
      startedAt,
      migratedFiles: Array.from(migratedFiles),
      orphanFiles: Array.from(orphanFiles),
    });
  }

  await writeLegacyLotwJournal(ctx, {
    phase: 'completed',
    legacyDir,
    startedAt,
    migratedFiles: Array.from(migratedFiles),
    orphanFiles: Array.from(orphanFiles),
  });

  ctx.log.info('Legacy LoTW certificates migrated', {
    count: migratedFiles.size,
    orphanCount: orphanFiles.size,
  });
}
