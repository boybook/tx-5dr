import { shell } from 'electron';
import fs from 'node:fs';
import { BUILD_INFO } from './generated/buildInfo.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('DesktopUpdate');

const DEFAULT_OSS_BASE_URL = 'https://tx5dr.oss-cn-hangzhou.aliyuncs.com';
const GITHUB_REPO = 'boybook/tx-5dr';
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;
const COUNTRY_LOOKUP_URLS = [
  'https://ipinfo.io/country',
  'https://ifconfig.co/country-iso',
  'https://ipapi.co/country/',
  'https://api.country.is/',
] as const;

type UpdateChannel = 'release' | 'nightly';
type UpdateSource = 'oss' | 'github';
type UpdateSourcePolicy = 'auto' | 'oss' | 'github';

export interface DesktopUpdateAsset {
  name: string;
  url: string;
  sha256?: string;
  size?: number;
  platform?: string;
  arch?: string;
  package_type?: string;
}

export interface DesktopDownloadOption {
  name: string;
  url: string;
  packageType: string;
  platform: string;
  arch: string;
  recommended: boolean;
  source: UpdateSource;
}

interface DesktopUpdateManifest {
  product?: string;
  channel?: UpdateChannel | string;
  tag?: string;
  version?: string;
  commit?: string;
  published_at?: string;
  release_notes?: string;
  assets?: DesktopUpdateAsset[];
}

export interface DesktopUpdateStatus {
  channel: UpdateChannel;
  currentVersion: string;
  currentCommit: string | null;
  checking: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  latestCommit: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  downloadUrl: string | null;
  downloadOptions: DesktopDownloadOption[];
  metadataSource: UpdateSource | null;
  downloadSource: UpdateSource | null;
  errorMessage: string | null;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function joinUrl(base: string, suffix: string): string {
  return `${trimSlash(base)}/${suffix.replace(/^\/+/, '')}`;
}

function normalizeVersion(value: string | null | undefined): string {
  return (value || '').trim().replace(/^v/i, '');
}

function normalizeCountryCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(trimmed)) {
    return trimmed;
  }
  const apiCountryMatch = trimmed.match(/"country"\s*:\s*"([A-Z]{2})"/);
  return apiCountryMatch?.[1] || null;
}

function parseVersionSegments(version: string): number[] {
  return normalizeVersion(version)
    .split('-')[0]
    .split('+')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
}

function compareReleaseVersions(left: string, right: string): number {
  const leftParts = parseVersionSegments(left);
  const rightParts = parseVersionSegments(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function createInitialStatus(): DesktopUpdateStatus {
  return {
    channel: BUILD_INFO.channel,
    currentVersion: BUILD_INFO.version,
    currentCommit: BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort,
    checking: false,
    updateAvailable: false,
    latestVersion: null,
    latestCommit: null,
    publishedAt: null,
    releaseNotes: null,
    downloadUrl: null,
    downloadOptions: [],
    metadataSource: null,
    downloadSource: null,
    errorMessage: null,
  };
}

type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

function createRequestInit(timeoutMs = 5000, headers?: Record<string, string>): FetchRequestInit {
  return {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

async function fetchText(url: string, timeoutMs = 5000, headers?: Record<string, string>): Promise<string> {
  const response = await fetch(url, createRequestInit(timeoutMs, headers));
  if (!response.ok) {
    throw new Error(`request_failed:${response.status}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string, timeoutMs = 5000, headers?: Record<string, string>): Promise<T> {
  const text = await fetchText(url, timeoutMs, headers);
  return JSON.parse(text) as T;
}

async function fetchCountryCode(): Promise<string | null> {
  for (const url of COUNTRY_LOOKUP_URLS) {
    try {
      const text = await fetchText(url, 4000);
      const country = normalizeCountryCode(text);
      if (country) {
        return country;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function resolvePreferredSource(policy: UpdateSourcePolicy): Promise<UpdateSource> {
  if (policy === 'oss' || policy === 'github') {
    return policy;
  }
  const country = await fetchCountryCode();
  return country === 'CN' ? 'oss' : 'github';
}

function getSourceOrder(preferred: UpdateSource): UpdateSource[] {
  return preferred === 'oss' ? ['oss', 'github'] : ['github', 'oss'];
}

function getOssManifestUrl(channel: UpdateChannel): string {
  const baseUrl = normalizeUrl(process.env.TX5DR_DOWNLOAD_BASE_URL || DEFAULT_OSS_BASE_URL);
  return joinUrl(baseUrl, `tx-5dr/app/${channel}/latest.json`);
}

function getGithubNightlyManifestUrl(): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/nightly-app/latest.json`;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GitHubReleaseResponse {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at?: string;
  body?: string;
  assets?: GitHubReleaseAsset[];
}

function isStableDesktopRelease(release: GitHubReleaseResponse): boolean {
  if (release.draft || release.prerelease) return false;
  if (!release.tag_name || release.tag_name.endsWith('-server') || release.tag_name.startsWith('nightly-')) return false;
  return Array.isArray(release.assets) && release.assets.some((asset) => asset.name === 'latest.json');
}

async function fetchGithubReleaseManifest(channel: UpdateChannel): Promise<DesktopUpdateManifest> {
  if (channel === 'nightly') {
    return fetchJson<DesktopUpdateManifest>(getGithubNightlyManifestUrl(), 8000, {
      Accept: 'application/octet-stream',
    });
  }

  const releases = await fetchJson<GitHubReleaseResponse[]>(`${GITHUB_API_BASE}/releases?per_page=20`, 8000, {
    Accept: 'application/vnd.github+json',
  });
  const release = releases.find(isStableDesktopRelease);
  if (!release) {
    throw new Error('github_release_manifest_not_found');
  }
  const manifestAsset = release.assets?.find((asset) => asset.name === 'latest.json');
  if (!manifestAsset) {
    throw new Error('github_release_manifest_asset_not_found');
  }
  return fetchJson<DesktopUpdateManifest>(manifestAsset.browser_download_url, 8000, {
    Accept: 'application/octet-stream',
  });
}

async function fetchManifestFromSource(channel: UpdateChannel, source: UpdateSource): Promise<DesktopUpdateManifest> {
  if (source === 'oss') {
    return fetchJson<DesktopUpdateManifest>(getOssManifestUrl(channel), 8000);
  }
  return fetchGithubReleaseManifest(channel);
}

function currentArch(): string {
  return process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
}

function currentPlatform(): string {
  return process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'macos'
      : process.platform === 'linux'
        ? 'linux'
        : process.platform;
}

function readLinuxOsRelease(): string {
  if (process.platform !== 'linux') {
    return '';
  }

  try {
    return fs.readFileSync('/etc/os-release', 'utf8').toLowerCase();
  } catch {
    return '';
  }
}

function preferredPackageTypes(platform: string): string[] {
  if (platform === 'windows') {
    return ['msi', '7z', 'zip'];
  }
  if (platform === 'macos') {
    return ['dmg', 'zip'];
  }
  if (platform === 'linux') {
    if (process.env.APPIMAGE) {
      return ['AppImage', 'deb', 'rpm', 'zip'];
    }
    if (process.env.SNAP) {
      return ['deb', 'rpm', 'zip'];
    }
    const osRelease = readLinuxOsRelease();
    if (/(^|\n)id(_like)?=.*(rhel|fedora|centos|rocky|alma|suse)/.test(osRelease)) {
      return ['rpm', 'deb', 'zip'];
    }
    return ['deb', 'rpm', 'zip'];
  }
  return ['zip'];
}

function listDownloadOptions(manifest: DesktopUpdateManifest, source: UpdateSource): DesktopDownloadOption[] {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const platform = currentPlatform();
  const arch = currentArch();
  const candidates = assets.filter((asset) => asset.platform === platform && asset.arch === arch);
  if (candidates.length === 0) {
    return [];
  }

  const packagePreference = preferredPackageTypes(platform);
  const ordered = [...candidates].sort((left, right) => {
    const leftPriority = packagePreference.indexOf(left.package_type || '');
    const rightPriority = packagePreference.indexOf(right.package_type || '');
    const normalizedLeft = leftPriority === -1 ? Number.MAX_SAFE_INTEGER : leftPriority;
    const normalizedRight = rightPriority === -1 ? Number.MAX_SAFE_INTEGER : rightPriority;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }
    return left.name.localeCompare(right.name);
  });

  return ordered.map((asset, index) => ({
    name: asset.name,
    url: asset.url,
    packageType: asset.package_type || 'unknown',
    platform: asset.platform || platform,
    arch: asset.arch || arch,
    recommended: index === 0,
    source,
  }));
}

function shouldUpdateFromManifest(manifest: DesktopUpdateManifest): boolean {
  const latestVersion = normalizeVersion(manifest.version);
  const currentVersion = normalizeVersion(BUILD_INFO.version);
  const latestCommit = manifest.commit?.trim() || null;
  const currentCommit = BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort;

  if (BUILD_INFO.channel === 'nightly') {
    if (latestCommit && currentCommit) {
      return latestCommit !== currentCommit;
    }
    if (!latestVersion) {
      return false;
    }
    return latestVersion !== currentVersion;
  }

  if (!latestVersion) {
    return false;
  }
  return compareReleaseVersions(latestVersion, currentVersion) > 0;
}

export class DesktopUpdateService {
  private status: DesktopUpdateStatus = createInitialStatus();

  getStatus(): DesktopUpdateStatus {
    return { ...this.status };
  }

  async checkForUpdates(policy: UpdateSourcePolicy = 'auto'): Promise<DesktopUpdateStatus> {
    this.status = {
      ...this.status,
      checking: true,
      errorMessage: null,
    };

    try {
      const preferredSource = await resolvePreferredSource(policy);
      const sources = getSourceOrder(preferredSource);
      let lastError: Error | null = null;

      for (const source of sources) {
        try {
          const manifest = await fetchManifestFromSource(BUILD_INFO.channel, source);
          const downloadOptions = listDownloadOptions(manifest, source);
          const downloadAsset = downloadOptions[0] || null;
          const updateAvailable = shouldUpdateFromManifest(manifest);

          this.status = {
            channel: BUILD_INFO.channel,
            currentVersion: BUILD_INFO.version,
            currentCommit: BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort,
            checking: false,
            updateAvailable,
            latestVersion: normalizeVersion(manifest.version) || null,
            latestCommit: manifest.commit?.trim() || null,
            publishedAt: manifest.published_at || null,
            releaseNotes: manifest.release_notes || null,
            downloadUrl: downloadAsset?.url || null,
            downloadOptions,
            metadataSource: source,
            downloadSource: downloadAsset ? source : null,
            errorMessage: null,
          };

          logger.info('desktop update status refreshed', {
            source,
            updateAvailable,
            latestVersion: this.status.latestVersion,
            latestCommit: this.status.latestCommit,
          });
          return this.getStatus();
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn('failed to load update manifest from source', { source, error: lastError.message });
        }
      }

      this.status = {
        ...this.status,
        checking: false,
        errorMessage: lastError?.message || 'update_manifest_unavailable',
      };
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status = {
        ...this.status,
        checking: false,
        errorMessage: message,
      };
      logger.error('desktop update check failed', error);
      return this.getStatus();
    }
  }

  async openDownload(url?: string): Promise<void> {
    const downloadUrl = url || this.status.downloadUrl;
    if (!downloadUrl) {
      throw new Error('update_download_url_unavailable');
    }
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`update_download_url_invalid_protocol:${parsed.protocol}`);
    }
    await shell.openExternal(downloadUrl);
  }
}
