import { fetchChannelManifest, EmptyReleaseChannelError, releaseIdentity, updateOperation } from '@tx5dr/core';
import { UpdatePreferencesSchema, UpdateInstallRequestSchema, SystemUpdateStatusSchema, type UpdateSelection } from '@tx5dr/contracts';
import { CancellationToken } from 'builder-util-runtime';
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

const WEBSITE_URL = 'https://tx5dr.com';
const RECENT_COMMITS_LIMIT = 10;
const PENDING_UPDATE_FILE = 'pending-update-install.json';

type UpdateChannel = 'release' | 'nightly';
type UpdateSource = 'oss' | 'github';
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

export interface DesktopUpdateStatus extends UpdateSelection {
  channel: UpdateChannel;
  currentVersion: string;
  currentCommit: string | null;
  currentPublishedAt: string | null;
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
  channel?: UpdateChannel;
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
  getChannel?: () => UpdateChannel;
  saveChannel?: (channel: UpdateChannel) => void;
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

function normalizeVersion(value: string | null | undefined): string {
  return (value || '').trim().replace(/^v/i, '');
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
    channel: status.targetChannel,
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
  if ((!pending.channel && pending.identity === currentIdentity()) ||
      (pending.channel === BUILD_INFO.channel && pending.version === BUILD_INFO.version &&
       (!pending.commit || BUILD_INFO.commit.startsWith(pending.commit) || pending.commit.startsWith(BUILD_INFO.commitShort)))) {
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
    currentPublishedAt: BUILD_INFO.buildTimestamp === 'development' ? null : BUILD_INFO.buildTimestamp,
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
): { source: UpdateSource; url: string | null } {
  const candidates: Array<{ source: UpdateSource; url: string | null }> = [
    { source: 'oss', url: asset.url_cn || asset.url_oss || asset.url || null },
    { source: 'oss', url: asset.url || null },
  ];

  for (const candidate of candidates) {
    if (candidate.url) {
      return candidate;
    }
  }

  return { source: 'oss', url: null };
}

function listDownloadOptions(manifest: DesktopUpdateManifest): DesktopDownloadOption[] {
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
      const resolved = resolveAssetDownload(asset);
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
    return fs.existsSync(path.join(path.dirname(app.getPath('exe')), 'Uninstall TX-5DR.exe')) ? 'nsis' : 'manual';
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

  const resolved = resolveAssetDownload(asset);
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
  private generation = 0;
  private changingChannel = false;
  private downloadToken: CancellationToken | null = null;
  private downloadTask: Promise<string[]> | null = null;
  private readonly saveChannel?: (channel: UpdateChannel) => void;

  constructor(options: DesktopUpdateServiceOptions = {}) {
    this.status.targetChannel = options.getChannel?.() ?? BUILD_INFO.channel;
    this.status.currentChannel = BUILD_INFO.channel;
    this.status.channelEditable = true;
    this.saveChannel = options.saveChannel;
    this.prepareInstall = options.prepareInstall;
    this.beforeQuitAndInstall = options.beforeQuitAndInstall;
    this.onQuitAndInstallError = options.onQuitAndInstallError;
    this.onStatus = options.onStatus;
    this.configureUpdater();
  }

  async setChannel(input: unknown): Promise<DesktopUpdateStatus> {
    const { channel } = UpdatePreferencesSchema.parse(input);
    if (this.status.phase === 'installing' || this.changingChannel) throw new Error('update_busy');
    this.changingChannel = true;
    ++this.generation;
    try {
      this.downloadToken?.cancel();
      await this.downloadTask?.catch(() => undefined);
      this.saveChannel?.(channel);
      this.preparedAutoUpdate = null;
      this.setStatus({ ...createInitialStatus(), currentChannel: BUILD_INFO.channel, targetChannel: channel, channelEditable: true });
    } finally { this.changingChannel = false; }
    return this.checkForUpdates();
  }

  getStatus(): DesktopUpdateStatus {
    this.refreshPendingInstallState();
    SystemUpdateStatusSchema.parse(this.status);
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
    if (this.status.phase === 'installing') return;
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
      if (this.changingChannel) return;
      this.setStatus({ checking: true, phase: 'checking', errorMessage: null });
    });

    this.updater.on('update-available', () => {
      if (this.changingChannel) return;
      this.setStatus({ checking: false, phase: 'available', errorMessage: null });
    });

    this.updater.on('update-not-available', () => {
      if (this.changingChannel) return;
      this.setStatus({ checking: false, phase: this.status.updateAvailable ? 'unsupported' : 'idle' });
    });

    this.updater.on('download-progress', (progress) => {
      if (this.changingChannel) return;
      this.setStatus({
        phase: 'downloading',
        downloadProgress: toProgressInfo(progress),
        errorMessage: null,
      });
    });

    this.updater.on('update-downloaded', () => {
      if (this.changingChannel) return;
      this.setStatus({
        phase: 'downloaded',
        downloaded: true,
        downloadProgress: this.status.downloadProgress || { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        errorMessage: null,
      });
    });

    this.updater.on('error', (error) => {
      if (this.changingChannel) return;
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

  async checkForUpdates(): Promise<DesktopUpdateStatus> {
    if (this.changingChannel || this.downloadTask || ['downloading', 'downloaded', 'installing'].includes(this.status.phase)) return this.getStatus();
    const generation = ++this.generation;
    const channel = this.status.targetChannel ?? BUILD_INFO.channel;
    this.preparedAutoUpdate = null;
    this.setStatus({
      checking: true,
      phase: 'checking',
      errorMessage: null,
      downloadProgress: null,
      downloaded: false,
    });

    try {
      const { manifest, source } = await fetchChannelManifest('app', channel, process.env.TX5DR_DOWNLOAD_BASE_URL || 'https://dl.tx5dr.com');
      if (generation !== this.generation) return this.getStatus();
      let stableAvailable = false;
      if (BUILD_INFO.channel === 'nightly' && channel === 'nightly') {
        try { await fetchChannelManifest('app', 'release', process.env.TX5DR_DOWNLOAD_BASE_URL || 'https://dl.tx5dr.com'); stableAvailable = true; } catch { /* Optional migration discovery. */ }
        if (generation !== this.generation) return this.getStatus();
      }
      const downloadOptions = listDownloadOptions(manifest);
      const recentCommits = normalizeRecentCommits(manifest);
      const downloadAsset = downloadOptions[0] || null;
      const operation = updateOperation({ channel: BUILD_INFO.channel, version: BUILD_INFO.version, commit: BUILD_INFO.commit }, manifest);
      const updateAvailable = operation !== 'none';
      const identity = releaseIdentity(manifest);
      const prepared = updateAvailable ? resolvePreparedAutoUpdate(manifest) : { update: null, reason: null };
      this.preparedAutoUpdate = prepared.update;
      const pendingState = getInitialPendingState();

      this.setStatus({
        stableAvailable,
        channel: BUILD_INFO.channel,
        currentChannel: BUILD_INFO.channel, targetChannel: channel, operation,
        availability: updateAvailable ? 'available' : 'up-to-date',
        compatibilityWarnings: operation === 'downgrade' ? ['downgrade_data_compatibility'] : [],
        currentVersion: BUILD_INFO.version,
        currentCommit: BUILD_INFO.commit === 'development' ? null : BUILD_INFO.commitShort,
        currentPublishedAt: BUILD_INFO.buildTimestamp === 'development' ? null : BUILD_INFO.buildTimestamp,
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
        metadataSource: source,
        downloadSource: prepared.update?.source || downloadAsset?.source || null,
        errorMessage: pendingState.errorMessage,
        target: 'electron-app',
        distribution: 'electron',
        identity,
        websiteUrl: `${WEBSITE_URL}/?channel=${channel}#downloads`,
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


      logger.info('desktop update status refreshed', {
        metadataSource: source,
        downloadSource: this.status.downloadSource,
        updateAvailable,
        autoUpdateSupported: this.status.autoUpdateSupported,
        autoUpdateReason: this.status.autoUpdateReason,
        latestVersion: this.status.latestVersion,
        latestCommit: this.status.latestCommit,
      });
      return this.getStatus();
    } catch (error) {
      if (generation !== this.generation) return this.getStatus();
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
        phase: error instanceof EmptyReleaseChannelError ? 'idle' : 'error',
        availability: error instanceof EmptyReleaseChannelError ? 'empty' : 'error',
        updateAvailable: false, latestVersion: null, identity: null, downloadOptions: [], downloadUrl: null,
        errorMessage: error instanceof EmptyReleaseChannelError ? null : message,
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

  async download(input: unknown): Promise<DesktopUpdateStatus> {
    const request = UpdateInstallRequestSchema.parse(input);
    if (this.changingChannel || this.status.phase === 'installing') throw new Error('update_busy');
    if (request.identity !== this.status.identity) throw new Error('update_target_changed');
    if (this.status.operation === 'downgrade' && !request.allowDowngrade) throw new Error('update_downgrade_confirmation_required');
    if (this.status.phase === 'downloaded' || this.status.downloaded) {
      return this.getStatus();
    }
    if (this.downloadTask || this.status.phase === 'downloading') {
      return this.getStatus();
    }
    if (!this.status.updateAvailable) {
      throw new Error('update_not_available');
    }
    if (!this.preparedAutoUpdate || !this.status.autoUpdateSupported) {
      throw new Error(this.status.autoUpdateReason || 'auto_update_unsupported');
    }

    this.updater.allowPrerelease = this.status.targetChannel === 'nightly';
    this.updater.allowDowngrade = this.status.targetChannel !== BUILD_INFO.channel && request.allowDowngrade;
    this.downloadToken = new CancellationToken();
    const token = this.downloadToken;
    this.setStatus({ phase: 'downloading', errorMessage: null, downloadProgress: null });
    const prepared = this.preparedAutoUpdate;
    this.downloadTask = (async () => {
      const result = await this.prepareElectronUpdater(prepared);
      if (token.cancelled) throw new Error('update_cancelled');
      if (!result?.isUpdateAvailable) throw new Error('auto_update_semver_not_newer');
      this.setStatus({ phase: 'downloading' });
      try { return await this.updater.downloadUpdate(token); }
      catch (error) {
        if (token.cancelled) throw error;
        const alternate = prepared.asset.url_github || prepared.asset.url_global;
        if (!alternate || alternate === prepared.downloadUrl || !alternate.startsWith('https://')) throw error;
        const fallback = { ...prepared, source: 'github' as const, downloadUrl: alternate,
          updateInfo: { ...prepared.updateInfo, files: prepared.updateInfo.files.map(file => ({ ...file,
            url: new URL(new URL(file.url).pathname.split('/').pop()!, alternate).href,
          })) },
        };
        // The same confirmed bytes and hashes are downloaded from the independent mirror.
        await this.prepareElectronUpdater(fallback);
        if (token.cancelled) throw new Error('update_cancelled');
        this.preparedAutoUpdate = fallback;
        this.setStatus({ phase: 'downloading', downloadSource: 'github', downloadUrl: alternate, errorMessage: null });
        return this.updater.downloadUpdate(token);
      }
    })();
    try {
      await this.downloadTask;
      return this.getStatus();
    } catch (error) {
      if (this.changingChannel) return this.getStatus();
      const message = error instanceof Error ? error.message : String(error);
      if (!this.changingChannel) this.setStatus({
        phase: 'available',
        errorMessage: message,
        downloaded: false,
      });
      throw error;
    } finally {
      this.downloadTask = null;
      this.downloadToken = null;
    }
  }

  async installAndRestart(input: unknown): Promise<DesktopUpdateStatus> {
    const request = UpdateInstallRequestSchema.parse(input);
    if (this.changingChannel || request.identity !== this.status.identity) throw new Error('update_target_changed');
    if (this.status.operation === 'downgrade' && !request.allowDowngrade) throw new Error('update_downgrade_confirmation_required');
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
      // Keep the NSIS installer visible on Windows so users can see progress during slow updates.
      this.updater.quitAndInstall(false, true);
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
