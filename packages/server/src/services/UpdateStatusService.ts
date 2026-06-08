import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SystemUpdateStatus, PluginDistribution } from '@tx5dr/contracts';
import { SystemUpdateStatusSchema } from '@tx5dr/contracts';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';
import { tx5drPaths } from '../utils/app-paths.js';
import { resolveRuntimeDistribution } from '../utils/runtime-distribution.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('UpdateStatusService');
const DEFAULT_OSS_BASE_URL = 'https://tx5dr.oss-cn-hangzhou.aliyuncs.com';
const WEBSITE_URL = 'https://tx5dr.com';

type UpdateChannel = 'release' | 'nightly';
type UpdateTarget = 'linux-server' | 'docker' | 'android-runtime';

interface ReleaseManifest {
  product?: string;
  channel?: string;
  tag?: string;
  version?: string;
  commit?: string;
  commit_title?: string;
  published_at?: string;
  release_notes?: string;
  docker_digest?: string;
}

interface LocalBuildInfo {
  channel: UpdateChannel;
  version: string;
  commit: string | null;
  publishedAt: string | null;
  digest: string | null;
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  if (trimmed.startsWith('//')) return `https:${trimmed}`.replace(/\/+$/, '');
  return `https://${trimmed.replace(/^\/+/, '')}`.replace(/\/+$/, '');
}

function normalizeVersion(value: string | null | undefined): string {
  return (value || '').trim().replace(/^v/i, '');
}

function normalizeCommit(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed || trimmed === 'development') return null;
  return trimmed;
}

function commitsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizeCommit(left)?.toLowerCase();
  const normalizedRight = normalizeCommit(right)?.toLowerCase();
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function normalizeDigest(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  return trimmed || null;
}

function normalizePublishedAt(value: string | null | undefined): string | null {
  const trimmed = (value || '').trim();
  return trimmed && trimmed !== 'development' ? trimmed : null;
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.json() as Promise<T>;
}

function manifestUrl(target: UpdateTarget, channel: UpdateChannel): string {
  const base = normalizeUrl(process.env.TX5DR_DOWNLOAD_BASE_URL || DEFAULT_OSS_BASE_URL);
  if (target === 'docker') {
    return `${base}/tx-5dr/docker/latest.json`;
  }
  if (target === 'android-runtime') {
    return `${base}/tx-5dr/android-runtime/${channel}/latest.json`;
  }
  return `${base}/tx-5dr/server/${channel}/latest.json`;
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

function remoteIdentity(target: UpdateTarget, channel: UpdateChannel, manifest: ReleaseManifest): string | null {
  if (target === 'docker') {
    return normalizeDigest(manifest.docker_digest) || normalizeCommit(manifest.commit) || normalizeVersion(manifest.version) || null;
  }
  if (channel === 'nightly') {
    return normalizeCommit(manifest.commit) || normalizeVersion(manifest.version) || null;
  }
  return normalizeVersion(manifest.version) || null;
}

function localIdentity(target: UpdateTarget, channel: UpdateChannel, local: LocalBuildInfo): string | null {
  if (target === 'docker') {
    return local.digest || local.commit || normalizeVersion(local.version) || null;
  }
  if (channel === 'nightly') {
    return local.commit || normalizeVersion(local.version) || null;
  }
  return normalizeVersion(local.version) || null;
}

function isUpdateAvailable(target: UpdateTarget, channel: UpdateChannel, local: LocalBuildInfo, manifest: ReleaseManifest): boolean {
  if (target === 'docker') {
    const latestDigest = normalizeDigest(manifest.docker_digest);
    if (latestDigest && local.digest) {
      return latestDigest !== local.digest;
    }

    const latestCommit = normalizeCommit(manifest.commit);
    if (latestCommit && local.commit) {
      return !commitsMatch(latestCommit, local.commit);
    }
  }

  if (channel === 'nightly') {
    const latestCommit = normalizeCommit(manifest.commit);
    if (latestCommit && local.commit) {
      return !commitsMatch(latestCommit, local.commit);
    }
  }

  const remote = remoteIdentity(target, channel, manifest);
  const current = localIdentity(target, channel, local);
  if (!remote || !current) return false;
  return remote !== current;
}

export async function getSystemUpdateStatus(): Promise<SystemUpdateStatus> {
  const distribution = await resolveDistribution();
  const target = resolveTarget(distribution);
  const local = await getLocalBuildInfo(distribution);

  try {
    const manifest = await fetchJson<ReleaseManifest>(manifestUrl(target, local.channel));
    const latestVersion = normalizeVersion(manifest.version) || null;
    const latestCommit = normalizeCommit(manifest.commit);
    const latestDigest = normalizeDigest(manifest.docker_digest);
    const identity = remoteIdentity(target, local.channel, manifest);
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
      updateAvailable: isUpdateAvailable(target, local.channel, local, manifest),
      identity,
      websiteUrl: WEBSITE_URL,
      metadataSource: 'oss',
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
      errorMessage: message,
    });
  }
}
