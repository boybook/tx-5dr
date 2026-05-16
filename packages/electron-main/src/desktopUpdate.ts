import { app, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import type { OutgoingHttpHeaders } from 'node:http';
import { autoUpdater, Provider } from 'electron-updater';
import type { AppUpdater, UpdateCheckResult } from 'electron-updater';
import type { ResolvedUpdateFileInfo } from 'electron-updater/out/types';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import type { CustomPublishOptions, UpdateFileInfo, UpdateInfo } from 'builder-util-runtime';
import { BUILD_INFO } from './generated/buildInfo.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('DesktopUpdate');

const DEFAULT_OSS_BASE_URL = 'https://tx5dr.oss-cn-hangzhou.aliyuncs.com';
const WEBSITE_URL = 'https://tx5dr.com';
const RECENT_COMMITS_LIMIT = 10;
const PENDING_UPDATE_FILE = 'pending-update-install.json';
const COUNTRY_LOOKUP_URLS = [
  'https://ipinfo.io/country',
  'https://ifconfig.co/country-iso',
  'https://ipapi.co/country/',
  'https://api.country.is/',
] as const;

type UpdateChannel = 'release' | 'nightly';
type UpdateSource = 'oss' | 'github';
type UpdateSourcePolicy = 'auto' | 'oss' | 'github';
export type DesktopUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'unsupported' | 'error';

type AutoUpdateTarget = 'nsis' | 'mac-zip' | 'appimage';
type InstallerFamily = 'nsis' | 'appimage' | 'mac-zip' | 'manual' | 'unknown';

export interface DesktopUpdateAutoMetadata {
  supported?: boolean;
  target?: AutoUpdateTarget | string;
  sha512?: string;
  files?: Array<Partial<UpdateFileInfo> & { url?: string; path?: string }>;
  blockMapSize?: number;
  minimumSystemVersion?: string;
  installerFamily?: InstallerFamily | string;
}

export interface DesktopUpdateAsset {
  name: string;
  url: string;
  url_cn?: string;
  url_global?: string;
  url_oss?: string;
  url_github?: string;
  sha256?: string;
  sha512?: string;
  size?: number;
  platform?: string;
  arch?: string;
  package_type?: string;
  auto_update?: DesktopUpdateAutoMetadata;
}

export interface DesktopDownloadOption {
  name: string;
  url: string;
  packageType: string;
  platform: string;
  arch: string;
  recommended: boolean;
  source: UpdateSource;
  autoUpdateSupported: boolean;
  autoUpdateTarget: AutoUpdateTarget | string | null;
  installerFamily: string | null;
}

export interface DesktopUpdateRecentCommit {
  id: string;
  shortId: string;
  title: string;
  publishedAt: string | null;
}

interface DesktopUpdateManifestRecentCommit {
  id?: string;
  short_id?: string;
  title?: string;
  published_at?: string;
}

interface DesktopUpdateManifest {
  product?: string;
  channel?: UpdateChannel | string;
  tag?: string;
  version?: string;
  commit?: string;
  commit_title?: string;
  published_at?: string;
  release_notes?: string;
  recent_commits?: DesktopUpdateManifestRecentCommit[];
  assets?: DesktopUpdateAsset[];
}

export interface DesktopDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface DesktopUpdateStatus {
  channel: UpdateChannel;
  currentVersion: string;
  currentCommit: string | null;
  checking: boolean;
  updateAvailable: boolean;
  latestVersion: string | null;
  latestCommit: string | null;
  latestCommitTitle: string | null;
  recentCommits: DesktopUpdateRecentCommit[];
  publishedAt: string | null;
  releaseNotes: string | null;
  downloadUrl: string | null;
  downloadOptions: DesktopDownloadOption[];
  metadataSource: UpdateSource | null;
  downloadSource: UpdateSource | null;
  errorMessage: string | null;
  target: 'electron-app';
  distribution: 'electron';
  identity: string | null;
  websiteUrl: string;
  phase: DesktopUpdatePhase;
  autoUpdateSupported: boolean;
  autoUpdateTarget: AutoUpdateTarget | string | null;
  autoUpdateInstallerFamily: string | null;
  autoUpdateReason: string | null;
  downloadProgress: DesktopDownloadProgress | null;
  downloaded: boolean;
  pendingInstallIdentity: string | null;
  lastInstallFailed: boolean;
}

interface PendingUpdateInstall {
  identity: string;
  version: string | null;
  commit: string | null;
  writtenAt: string;
}

interface PreparedAutoUpdate {
  asset: DesktopUpdateAsset;
  downloadUrl: string;
  source: UpdateSource;
  updateInfo: UpdateInfo;
  target: AutoUpdateTarget | string;
  installerFamily: string;
}

interface DesktopUpdateServiceOptions {
  prepareInstall?: () => Promise<void>;
  beforeQuitAndInstall?: () => void;
  onQuitAndInstallError?: () => void;
  onStatus?: (status: DesktopUpdateStatus) => void;
}

interface Tx5drCustomPublishOptions extends CustomPublishOptions {
  updateInfo: UpdateInfo;
}

class LatestJsonUpdateProvider extends Provider<UpdateInfo> {
  private readonly updateInfo: UpdateInfo;

  constructor(options: Tx5drCustomPublishOptions, _updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super(runtimeOptions);
    this.updateInfo = options.updateInfo;
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    return this.updateInfo;
  }

  resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    return updateInfo.files.map((fileInfo) => ({
      url: new URL(fileInfo.url),
      info: fileInfo,
    }));
  }

  get fileExtraDownloadHeaders(): OutgoingHttpHeaders | null {
    return null;
  }
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

function currentIdentity(): string | null {
  if (BUILD_INFO.channel === 'nightly') {
    return BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort;
  }
  return normalizeVersion(BUILD_INFO.version) || null;
}

function getPendingUpdatePath(): string | null {
  if (!app.isReady()) {
    return null;
  }
  return path.join(app.getPath('userData'), PENDING_UPDATE_FILE);
}

function readPendingUpdateInstall(): PendingUpdateInstall | null {
  try {
    const pendingPath = getPendingUpdatePath();
    if (!pendingPath) return null;
    const parsed = JSON.parse(fs.readFileSync(pendingPath, 'utf8')) as PendingUpdateInstall;
    if (typeof parsed.identity === 'string' && parsed.identity.trim()) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function clearPendingUpdateInstall(): void {
  try {
    const pendingPath = getPendingUpdatePath();
    if (pendingPath) {
      fs.rmSync(pendingPath, { force: true });
    }
  } catch {
    // ignore
  }
}

function writePendingUpdateInstall(status: DesktopUpdateStatus): void {
  if (!status.identity) return;
  const payload: PendingUpdateInstall = {
    identity: status.identity,
    version: status.latestVersion,
    commit: status.latestCommit,
    writtenAt: new Date().toISOString(),
  };
  const pendingPath = getPendingUpdatePath();
  if (!pendingPath) return;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(pendingPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function getInitialPendingState(): Pick<DesktopUpdateStatus, 'pendingInstallIdentity' | 'lastInstallFailed' | 'phase' | 'errorMessage'> {
  const pending = readPendingUpdateInstall();
  if (!pending) {
    return { pendingInstallIdentity: null, lastInstallFailed: false, phase: 'idle', errorMessage: null };
  }
  if (pending.identity === currentIdentity()) {
    clearPendingUpdateInstall();
    return { pendingInstallIdentity: null, lastInstallFailed: false, phase: 'idle', errorMessage: null };
  }
  return {
    pendingInstallIdentity: pending.identity,
    lastInstallFailed: true,
    phase: 'error',
    errorMessage: 'update_install_not_completed',
  };
}

function createInitialStatus(): DesktopUpdateStatus {
  const pending = getInitialPendingState();
  return {
    channel: BUILD_INFO.channel,
    currentVersion: BUILD_INFO.version,
    currentCommit: BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort,
    checking: false,
    updateAvailable: false,
    latestVersion: null,
    latestCommit: null,
    latestCommitTitle: null,
    recentCommits: [],
    publishedAt: null,
    releaseNotes: null,
    downloadUrl: null,
    downloadOptions: [],
    metadataSource: null,
    downloadSource: null,
    errorMessage: pending.errorMessage,
    target: 'electron-app',
    distribution: 'electron',
    identity: null,
    websiteUrl: WEBSITE_URL,
    phase: pending.phase,
    autoUpdateSupported: false,
    autoUpdateTarget: null,
    autoUpdateInstallerFamily: currentInstallerFamily(),
    autoUpdateReason: pending.errorMessage,
    downloadProgress: null,
    downloaded: false,
    pendingInstallIdentity: pending.pendingInstallIdentity,
    lastInstallFailed: pending.lastInstallFailed,
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

function getOssManifestUrl(channel: UpdateChannel): string {
  const baseUrl = normalizeUrl(process.env.TX5DR_DOWNLOAD_BASE_URL || DEFAULT_OSS_BASE_URL);
  return joinUrl(baseUrl, `tx-5dr/app/${channel}/latest.json`);
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
    return ['exe', '7z', 'zip'];
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
      return ['rpm', 'deb', 'zip', 'AppImage'];
    }
    return ['deb', 'rpm', 'zip', 'AppImage'];
  }
  return ['zip'];
}

function resolveAssetDownload(
  asset: DesktopUpdateAsset,
  preferredSource: UpdateSource,
): { source: UpdateSource; url: string | null } {
  const candidates: Array<{ source: UpdateSource; url: string | null }> = preferredSource === 'oss'
    ? [
      { source: 'oss', url: asset.url_cn || asset.url_oss || asset.url || null },
      { source: 'github', url: asset.url_global || asset.url_github || null },
      { source: 'oss', url: asset.url || null },
    ]
    : [
      { source: 'github', url: asset.url_global || asset.url_github || null },
      { source: 'oss', url: asset.url_cn || asset.url_oss || asset.url || null },
      { source: 'oss', url: asset.url || null },
    ];

  for (const candidate of candidates) {
    if (candidate.url) {
      return candidate;
    }
  }

  return { source: preferredSource, url: null };
}

function listDownloadOptions(manifest: DesktopUpdateManifest, preferredSource: UpdateSource): DesktopDownloadOption[] {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const platform = currentPlatform();
  const arch = currentArch();
  const candidates = assets.filter((asset) => asset.platform === platform && asset.arch === arch);
  if (candidates.length === 0) {
    return [];
  }

  const packagePreference = preferredPackageTypes(platform);
  const ordered = [...candidates].sort((left, right) => {
    const leftAuto = left.auto_update?.supported ? 0 : 1;
    const rightAuto = right.auto_update?.supported ? 0 : 1;
    if (leftAuto !== rightAuto) return leftAuto - rightAuto;
    const leftPriority = packagePreference.indexOf(left.package_type || '');
    const rightPriority = packagePreference.indexOf(right.package_type || '');
    const normalizedLeft = leftPriority === -1 ? Number.MAX_SAFE_INTEGER : leftPriority;
    const normalizedRight = rightPriority === -1 ? Number.MAX_SAFE_INTEGER : rightPriority;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }
    return left.name.localeCompare(right.name);
  });

  return ordered
    .map((asset, index) => {
      const resolved = resolveAssetDownload(asset, preferredSource);
      if (!resolved.url) {
        return null;
      }
      return {
        name: asset.name,
        url: resolved.url,
        packageType: asset.package_type || 'unknown',
        platform: asset.platform || platform,
        arch: asset.arch || arch,
        recommended: index === 0,
        source: resolved.source,
        autoUpdateSupported: asset.auto_update?.supported === true,
        autoUpdateTarget: asset.auto_update?.target || null,
        installerFamily: asset.auto_update?.installerFamily || null,
      };
    })
    .filter((asset): asset is DesktopDownloadOption => Boolean(asset));
}

function updateIdentityFromManifest(manifest: DesktopUpdateManifest): string | null {
  const latestVersion = normalizeVersion(manifest.version);
  const latestCommit = manifest.commit?.trim() || null;

  if (BUILD_INFO.channel === 'nightly') {
    return latestCommit || latestVersion || null;
  }

  return latestVersion || null;
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

function normalizeRecentCommits(manifest: DesktopUpdateManifest): DesktopUpdateRecentCommit[] {
  const entries = Array.isArray(manifest.recent_commits) ? manifest.recent_commits : [];
  const normalized = entries
    .map((entry) => {
      const id = entry.id?.trim() || '';
      const shortId = entry.short_id?.trim() || id.slice(0, 7);
      const title = entry.title?.trim() || '';
      const publishedAt = entry.published_at?.trim() || null;
      if (!id && !shortId && !title && !publishedAt) {
        return null;
      }
      return {
        id: id || shortId,
        shortId,
        title,
        publishedAt,
      };
    })
    .filter((entry): entry is DesktopUpdateRecentCommit => Boolean(entry))
    .slice(0, RECENT_COMMITS_LIMIT);

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackCommit = manifest.commit?.trim() || '';
  const fallbackTitle = manifest.commit_title?.trim() || '';
  const fallbackPublishedAt = manifest.published_at?.trim() || null;
  if (!fallbackCommit && !fallbackTitle && !fallbackPublishedAt) {
    return [];
  }

  return [{
    id: fallbackCommit,
    shortId: fallbackCommit.slice(0, 7),
    title: fallbackTitle,
    publishedAt: fallbackPublishedAt,
  }];
}

function currentInstallerFamily(): InstallerFamily {
  if (process.platform === 'linux') {
    return process.env.APPIMAGE ? 'appimage' : 'manual';
  }
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(process.resourcesPath || '', 'app-update.yml')) ? 'mac-zip' : 'manual';
  }
  if (process.platform === 'win32') {
    if (process.env.TX5DR_INSTALLER_FAMILY === 'nsis') return 'nsis';
    return fs.existsSync(path.join(process.resourcesPath || '', 'app-update.yml')) ? 'nsis' : 'unknown';
  }
  return 'unknown';
}

function expectedAutoTargetForCurrentPlatform(): AutoUpdateTarget | null {
  if (process.platform === 'win32') return 'nsis';
  if (process.platform === 'darwin') return 'mac-zip';
  if (process.platform === 'linux') return 'appimage';
  return null;
}

function absoluteOrRelativeToFile(fileUrl: string, nextUrl: string): string {
  if (/^https?:\/\//i.test(nextUrl)) return nextUrl;
  const base = new URL(fileUrl);
  return new URL(nextUrl, base).href;
}

function buildUpdateInfoFromAsset(
  manifest: DesktopUpdateManifest,
  asset: DesktopUpdateAsset,
  downloadUrl: string,
): UpdateInfo | null {
  const auto = asset.auto_update;
  const version = normalizeVersion(manifest.version);
  if (!auto?.supported || !version) return null;

  const files = auto.files && auto.files.length > 0
    ? auto.files.map((file) => ({
      url: absoluteOrRelativeToFile(downloadUrl, String(file.url || file.path || downloadUrl)),
      sha512: String(file.sha512 || auto.sha512 || asset.sha512 || ''),
      size: typeof file.size === 'number' ? file.size : asset.size,
      blockMapSize: typeof file.blockMapSize === 'number' ? file.blockMapSize : auto.blockMapSize,
      isAdminRightsRequired: file.isAdminRightsRequired,
    }))
    : [{
      url: downloadUrl,
      sha512: String(auto.sha512 || asset.sha512 || ''),
      size: asset.size,
      blockMapSize: auto.blockMapSize,
    }];

  if (files.some((file) => !file.sha512)) {
    return null;
  }

  const primary = files[0];
  return {
    version,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseName: manifest.tag || manifest.version || null,
    releaseNotes: manifest.release_notes || null,
    releaseDate: manifest.published_at || new Date().toISOString(),
    minimumSystemVersion: auto.minimumSystemVersion,
  };
}

function resolvePreparedAutoUpdate(
  manifest: DesktopUpdateManifest,
  preferredSource: UpdateSource,
): { update: PreparedAutoUpdate | null; reason: string | null } {
  const platform = currentPlatform();
  const arch = currentArch();
  const expectedTarget = expectedAutoTargetForCurrentPlatform();
  if (!expectedTarget) {
    return { update: null, reason: 'auto_update_platform_unsupported' };
  }

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const candidates = assets.filter((asset) => asset.platform === platform && asset.arch === arch && asset.auto_update?.supported === true);
  const asset = candidates.find((candidate) => candidate.auto_update?.target === expectedTarget) || candidates[0] || null;
  if (!asset) {
    return { update: null, reason: 'auto_update_asset_unavailable' };
  }

  const installerFamily = currentInstallerFamily();
  const expectedInstallerFamily = String(asset.auto_update?.installerFamily || expectedTarget);
  if (process.platform === 'win32' && installerFamily !== 'nsis') {
    return { update: null, reason: 'auto_update_requires_nsis_installer' };
  }
  if (process.platform === 'linux' && installerFamily !== 'appimage') {
    return { update: null, reason: 'auto_update_requires_appimage' };
  }
  if (process.platform === 'darwin' && installerFamily === 'manual') {
    return { update: null, reason: 'auto_update_requires_signed_zip_install' };
  }

  const resolved = resolveAssetDownload(asset, preferredSource);
  if (!resolved.url) {
    return { update: null, reason: 'auto_update_download_url_unavailable' };
  }

  const updateInfo = buildUpdateInfoFromAsset(manifest, asset, resolved.url);
  if (!updateInfo) {
    return { update: null, reason: 'auto_update_metadata_incomplete' };
  }

  return {
    update: {
      asset,
      downloadUrl: resolved.url,
      source: resolved.source,
      updateInfo,
      target: asset.auto_update?.target || expectedTarget,
      installerFamily: expectedInstallerFamily,
    },
    reason: null,
  };
}

function toProgressInfo(input: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number }): DesktopDownloadProgress {
  return {
    percent: Number.isFinite(input.percent) ? Math.max(0, Math.min(100, input.percent || 0)) : 0,
    transferred: Number.isFinite(input.transferred) ? input.transferred || 0 : 0,
    total: Number.isFinite(input.total) ? input.total || 0 : 0,
    bytesPerSecond: Number.isFinite(input.bytesPerSecond) ? input.bytesPerSecond || 0 : 0,
  };
}

export class DesktopUpdateService {
  private status: DesktopUpdateStatus = createInitialStatus();
  private preparedAutoUpdate: PreparedAutoUpdate | null = null;
  private readonly updater = autoUpdater;
  private readonly prepareInstall?: () => Promise<void>;
  private readonly beforeQuitAndInstall?: () => void;
  private readonly onQuitAndInstallError?: () => void;
  private readonly onStatus?: (status: DesktopUpdateStatus) => void;
  private eventHandlersConfigured = false;

  constructor(options: DesktopUpdateServiceOptions = {}) {
    this.prepareInstall = options.prepareInstall;
    this.beforeQuitAndInstall = options.beforeQuitAndInstall;
    this.onQuitAndInstallError = options.onQuitAndInstallError;
    this.onStatus = options.onStatus;
    this.configureUpdater();
  }

  getStatus(): DesktopUpdateStatus {
    this.refreshPendingInstallState();
    return {
      ...this.status,
      recentCommits: [...this.status.recentCommits],
      downloadOptions: [...this.status.downloadOptions],
      downloadProgress: this.status.downloadProgress ? { ...this.status.downloadProgress } : null,
    };
  }

  private setStatus(update: Partial<DesktopUpdateStatus>, notify = true): DesktopUpdateStatus {
    this.status = {
      ...this.status,
      ...update,
    };
    const snapshot = this.getStatus();
    if (notify) {
      this.onStatus?.(snapshot);
    }
    return snapshot;
  }

  private refreshPendingInstallState(): void {
    const pendingState = getInitialPendingState();
    const pendingChanged = pendingState.pendingInstallIdentity !== this.status.pendingInstallIdentity
      || pendingState.lastInstallFailed !== this.status.lastInstallFailed;
    if (!pendingChanged) return;
    this.status = {
      ...this.status,
      pendingInstallIdentity: pendingState.pendingInstallIdentity,
      lastInstallFailed: pendingState.lastInstallFailed,
      phase: pendingState.lastInstallFailed ? 'error' : this.status.phase,
      errorMessage: pendingState.lastInstallFailed ? pendingState.errorMessage : this.status.errorMessage,
      autoUpdateReason: pendingState.lastInstallFailed ? pendingState.errorMessage : this.status.autoUpdateReason,
    };
  }

  private configureUpdater(): void {
    if (this.eventHandlersConfigured) return;
    this.eventHandlersConfigured = true;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.logger = logger;

    this.updater.on('checking-for-update', () => {
      this.setStatus({ checking: true, phase: 'checking', errorMessage: null });
    });

    this.updater.on('update-available', () => {
      this.setStatus({ checking: false, phase: 'available', errorMessage: null });
    });

    this.updater.on('update-not-available', () => {
      this.setStatus({ checking: false, phase: this.status.updateAvailable ? 'unsupported' : 'idle' });
    });

    this.updater.on('download-progress', (progress) => {
      this.setStatus({
        phase: 'downloading',
        downloadProgress: toProgressInfo(progress),
        errorMessage: null,
      });
    });

    this.updater.on('update-downloaded', () => {
      this.setStatus({
        phase: 'downloaded',
        downloaded: true,
        downloadProgress: this.status.downloadProgress || { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        errorMessage: null,
      });
    });

    this.updater.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('electron updater failed', error);
      this.setStatus({
        checking: false,
        phase: this.status.phase === 'downloading' ? 'available' : 'error',
        errorMessage: message,
        downloaded: false,
      });
    });
  }

  async checkForUpdates(policy: UpdateSourcePolicy = 'auto'): Promise<DesktopUpdateStatus> {
    this.preparedAutoUpdate = null;
    this.setStatus({
      checking: true,
      phase: 'checking',
      errorMessage: null,
      downloadProgress: null,
      downloaded: false,
    });

    try {
      const preferredSource = await resolvePreferredSource(policy);
      const manifest = await fetchJson<DesktopUpdateManifest>(getOssManifestUrl(BUILD_INFO.channel), 8000);
      const downloadOptions = listDownloadOptions(manifest, preferredSource);
      const recentCommits = normalizeRecentCommits(manifest);
      const downloadAsset = downloadOptions[0] || null;
      const updateAvailable = shouldUpdateFromManifest(manifest);
      const identity = updateIdentityFromManifest(manifest);
      const prepared = updateAvailable ? resolvePreparedAutoUpdate(manifest, preferredSource) : { update: null, reason: null };
      this.preparedAutoUpdate = prepared.update;
      const pendingState = getInitialPendingState();

      this.setStatus({
        channel: BUILD_INFO.channel,
        currentVersion: BUILD_INFO.version,
        currentCommit: BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort,
        checking: false,
        updateAvailable,
        latestVersion: normalizeVersion(manifest.version) || null,
        latestCommit: manifest.commit?.trim() || null,
        latestCommitTitle: manifest.commit_title?.trim() || null,
        recentCommits,
        publishedAt: manifest.published_at || null,
        releaseNotes: manifest.release_notes || null,
        downloadUrl: prepared.update?.downloadUrl || downloadAsset?.url || null,
        downloadOptions,
        metadataSource: 'oss',
        downloadSource: prepared.update?.source || downloadAsset?.source || null,
        errorMessage: pendingState.errorMessage,
        target: 'electron-app',
        distribution: 'electron',
        identity,
        websiteUrl: WEBSITE_URL,
        phase: updateAvailable ? (prepared.update ? 'available' : 'unsupported') : pendingState.phase,
        autoUpdateSupported: Boolean(prepared.update),
        autoUpdateTarget: prepared.update?.target || null,
        autoUpdateInstallerFamily: prepared.update?.installerFamily || currentInstallerFamily(),
        autoUpdateReason: prepared.reason || pendingState.errorMessage,
        downloadProgress: null,
        downloaded: false,
        pendingInstallIdentity: pendingState.pendingInstallIdentity,
        lastInstallFailed: pendingState.lastInstallFailed,
      });

      if (this.preparedAutoUpdate) {
        await this.prepareElectronUpdater(this.preparedAutoUpdate);
      }

      logger.info('desktop update status refreshed', {
        metadataSource: 'oss',
        downloadSource: this.status.downloadSource,
        updateAvailable,
        autoUpdateSupported: this.status.autoUpdateSupported,
        autoUpdateReason: this.status.autoUpdateReason,
        latestVersion: this.status.latestVersion,
        latestCommit: this.status.latestCommit,
      });
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pendingState = getInitialPendingState();
      if (pendingState.lastInstallFailed) {
        this.setStatus({
          checking: false,
          phase: pendingState.phase,
          errorMessage: pendingState.errorMessage,
          autoUpdateReason: pendingState.errorMessage,
          pendingInstallIdentity: pendingState.pendingInstallIdentity,
          lastInstallFailed: pendingState.lastInstallFailed,
        });
        logger.error('desktop update check failed with pending install failure', error);
        return this.getStatus();
      }
      this.setStatus({
        checking: false,
        phase: 'error',
        errorMessage: message,
      });
      logger.error('desktop update check failed', error);
      return this.getStatus();
    }
  }

  private async prepareElectronUpdater(prepared: PreparedAutoUpdate): Promise<UpdateCheckResult | null> {
    this.updater.setFeedURL({
      provider: 'custom',
      updateProvider: LatestJsonUpdateProvider,
      updateInfo: prepared.updateInfo,
    } as Tx5drCustomPublishOptions);

    const result = await this.updater.checkForUpdates();
    if (result && !result.isUpdateAvailable) {
      this.setStatus({
        phase: 'unsupported',
        autoUpdateSupported: false,
        autoUpdateReason: 'auto_update_semver_not_newer',
      });
    }
    return result;
  }

  async download(): Promise<DesktopUpdateStatus> {
    if (this.status.phase === 'downloaded' || this.status.downloaded) {
      return this.getStatus();
    }
    if (this.status.phase === 'downloading') {
      return this.getStatus();
    }
    if (!this.status.updateAvailable) {
      throw new Error('update_not_available');
    }
    if (!this.preparedAutoUpdate || !this.status.autoUpdateSupported) {
      throw new Error(this.status.autoUpdateReason || 'auto_update_unsupported');
    }

    this.setStatus({ phase: 'downloading', errorMessage: null, downloadProgress: null });
    try {
      await this.updater.downloadUpdate();
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        phase: 'available',
        errorMessage: message,
        downloaded: false,
      });
      throw error;
    }
  }

  async installAndRestart(): Promise<DesktopUpdateStatus> {
    if (!this.status.downloaded && this.status.phase !== 'downloaded') {
      throw new Error('update_not_downloaded');
    }
    if (!this.preparedAutoUpdate) {
      throw new Error('auto_update_not_prepared');
    }

    this.setStatus({ phase: 'installing', errorMessage: null });
    try {
      if (this.prepareInstall) {
        await this.prepareInstall();
      }
      writePendingUpdateInstall(this.status);
      this.beforeQuitAndInstall?.();
      this.updater.quitAndInstall(process.platform === 'win32', true);
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      clearPendingUpdateInstall();
      this.onQuitAndInstallError?.();
      this.setStatus({ phase: 'downloaded', errorMessage: message });
      logger.error('desktop update install failed before handoff', error);
      throw error;
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
