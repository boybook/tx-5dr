import { fetchChannelManifest, EmptyReleaseChannelError, releaseIdentity, updateOperation } from '@tx5dr/core';
import { getUpdatePreferences } from './UpdatePreferences.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SystemUpdateStatus, PluginDistribution } from '@tx5dr/contracts';
import { UpdatePreferencesSchema, SystemUpdateStatusSchema } from '@tx5dr/contracts';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';
import { tx5drPaths } from '../utils/app-paths.js';
import { resolveRuntimeDistribution } from '../utils/runtime-distribution.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UpdateStatusService');
const WEBSITE_URL = 'https://tx5dr.com';
type UpdateChannel = 'release' | 'nightly';
type UpdateTarget = 'linux-server' | 'docker' | 'android-runtime';

interface LocalBuildInfo {
  channel: UpdateChannel;
  version: string;
  commit: string | null;
  publishedAt: string | null;
  digest: string | null;
}

function normalizeVersion(value: string | null | undefined): string {
  return (value || '').trim().replace(/^v/i, '');
}

function normalizeCommit(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed || trimmed === 'development') return null;
  return trimmed;
}

function normalizeDigest(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  return trimmed || null;
}

function normalizePublishedAt(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  return trimmed && trimmed !== 'development' ? trimmed : null;
}

async function readInstalledVersionFallback(): Promise<string | null> {
  const candidates = [
    '/usr/share/tx5dr/version',
    path.join(process.cwd(), 'version'),
  ];
  for (const file of candidates) {
    try {
      const value = (await readFile(file, 'utf8')).trim();
      if (value) return value;
    } catch {
      // continue
    }
  }
  return null;
}

async function resolveDistribution(): Promise<PluginDistribution> {
  const dataDir = await tx5drPaths.getDataDir();
  return resolveRuntimeDistribution(dataDir, { hasDockerEnvFile: existsSync('/.dockerenv') });
}

async function getLocalBuildInfo(_distribution: PluginDistribution): Promise<LocalBuildInfo> {
  const installedVersion = await readInstalledVersionFallback();
  const channel = SERVER_BUILD_INFO.channel === 'release' ? 'release' : 'nightly';
  return {
    channel,
    version: normalizeVersion(installedVersion || SERVER_BUILD_INFO.version || 'unknown') || 'unknown',
    commit: normalizeCommit(SERVER_BUILD_INFO.commitShort || SERVER_BUILD_INFO.commit),
    publishedAt: normalizePublishedAt(SERVER_BUILD_INFO.buildTimestamp),
    digest: normalizeDigest(SERVER_BUILD_INFO.dockerDigest),
  };
}

function resolveTarget(distribution: PluginDistribution): UpdateTarget {
  if (distribution === 'docker') return 'docker';
  if (distribution === 'android-bridge') return 'android-runtime';
  return 'linux-server';
}

export async function getSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  const distribution = await resolveDistribution();
  const target = resolveTarget(distribution);
  const local = await getLocalBuildInfo(distribution);

  let targetChannel = local.channel;
  try {
    if (distribution === 'android-bridge') {
      // Native shell owns this projection; remote browsers never mutate it.
      try {
        const projection = UpdatePreferencesSchema.parse(JSON.parse(await readFile(path.join(await tx5drPaths.getDataDir(), 'android-update-state.json'), 'utf8')));
        targetChannel = projection.channel;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } else if (distribution !== 'electron') {
      targetChannel = (await getUpdatePreferences()).channel;
    }
    const product = target === 'linux-server' ? 'server' : target;
    const { manifest, source } = await fetchChannelManifest(product, targetChannel, process.env.TX5DR_DOWNLOAD_BASE_URL || 'https://dl.tx5dr.com');
    let stableAvailable = false;
    if (local.channel === 'nightly' && targetChannel === 'nightly') {
      try { await fetchChannelManifest(product, 'release', process.env.TX5DR_DOWNLOAD_BASE_URL || 'https://dl.tx5dr.com'); stableAvailable = true; } catch { /* Optional migration discovery. */ }
    }
    const latestVersion = normalizeVersion(manifest.version) || null;
    const latestCommit = normalizeCommit(manifest.commit);
    const latestDigest = normalizeDigest(manifest.docker_digest);
    const identity = releaseIdentity(manifest);
    const operation = updateOperation({ channel: local.channel, version: local.version, commit: local.commit }, manifest);
    const installCommand = distribution === 'linux-service'
      ? `sudo tx5dr update --channel ${targetChannel} --version ${manifest.version}${operation === 'downgrade' ? ' --allow-downgrade' : ''}`
      : target === 'docker' && manifest.docker_image && manifest.docker_digest
        ? `${manifest.docker_image}@${manifest.docker_digest}` : null;
    const status: SystemUpdateStatus = {
      target,
      distribution,
      channel: local.channel,
      currentVersion: local.version,
      currentCommit: local.commit,
      currentPublishedAt: local.publishedAt,
      currentDigest: local.digest,
      latestVersion,
      latestCommit,
      latestDigest,
      latestCommitTitle: manifest.commit_title?.trim() || null,
      publishedAt: manifest.published_at?.trim() || null,
      releaseNotes: manifest.release_notes?.trim() || null,
      updateAvailable: operation !== 'none',
      stableAvailable,
      currentChannel: local.channel, targetChannel, operation,
      availability: operation === 'none' ? 'up-to-date' : 'available',
      channelEditable: distribution !== 'android-bridge' && distribution !== 'electron',
      installCommand,
      compatibilityWarnings: operation === 'downgrade' ? ['downgrade_data_compatibility'] : [],
      identity,
      websiteUrl: WEBSITE_URL,
      metadataSource: source,
      errorMessage: null,
    };
    return SystemUpdateStatusSchema.parse(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('system update status check failed', { target, message });
    return SystemUpdateStatusSchema.parse({
      target,
      distribution,
      channel: local.channel,
      currentVersion: local.version,
      currentCommit: local.commit,
      currentPublishedAt: local.publishedAt,
      currentDigest: local.digest,
      currentChannel: local.channel, targetChannel,
      channelEditable: distribution !== 'android-bridge' && distribution !== 'electron',
      availability: error instanceof EmptyReleaseChannelError ? 'empty' : 'error',
      operation: 'none',
      latestVersion: null,
      latestCommit: null,
      latestDigest: null,
      latestCommitTitle: null,
      publishedAt: null,
      releaseNotes: null,
      updateAvailable: false,
      identity: null,
      websiteUrl: WEBSITE_URL,
      metadataSource: null,
      errorMessage: error instanceof EmptyReleaseChannelError ? null : message,
    });
  }
}
