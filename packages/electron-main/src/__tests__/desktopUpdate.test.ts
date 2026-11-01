import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const state = vi.hoisted(() => ({ userData: '', buildInfo: {
  channel: 'nightly', version: '1.0.1-nightly.1+gaaaaaaa', commit: 'a'.repeat(40), commitShort: 'aaaaaaa', buildTimestamp: '2026-10-24T00:00:00Z',
}, listeners: {} as Record<string, (...args: any[]) => void>, updater: {
  autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false,
  logger: undefined as unknown, setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  on: vi.fn(),
} }));
vi.mock('electron', () => ({ app: { isReady: () => true, getPath: () => state.userData }, shell: { openExternal: vi.fn() } }));
vi.mock('electron-updater', () => ({ autoUpdater: state.updater, Provider: class {} }));
vi.mock('../generated/buildInfo.js', () => ({ BUILD_INFO: state.buildInfo }));
import { DesktopUpdateService } from '../desktopUpdate.js';

function manifest(channel: string, version: string) {
  return { product: 'app', channel, version, tag: channel === 'nightly' ? 'nightly-app' : 'v1.0.0', commit: 'b'.repeat(40), published_at: '2026-10-24T01:00:00Z', assets: [{
    name: 'TX-5DR.AppImage', url: 'https://downloads.test/builds/target/TX-5DR.AppImage', platform: 'linux', arch: process.arch, package_type: 'AppImage', size: 100, sha256: 'a'.repeat(64), sha512: 'digest',
    auto_update: { supported: true, target: 'appimage', installerFamily: 'appimage', sha512: 'digest' },
  }] };
}

const originalPlatform = process.platform;
const originalAppImage = process.env.APPIMAGE;
const originalBuildInfo = { ...state.buildInfo };
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  if (originalAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = originalAppImage;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(state.userData, { recursive: true, force: true });
  Object.assign(state.buildInfo, originalBuildInfo);
});
beforeEach(() => {
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tx5dr-update-test-'));
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.clearAllMocks();
  process.env.APPIMAGE = '/tmp/TX-5DR.AppImage';
  state.updater.on.mockImplementation((name, callback) => { state.listeners[name] = callback; });
  state.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true });
  state.updater.downloadUpdate.mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('/release/') ? manifest('release', '1.0.0') : manifest('nightly', '1.0.1-nightly.2') })));
});

describe('desktop installation verification', () => {
  function pendingPath() { return path.join(state.userData, 'pending-update-install.json'); }
  function writePending(overrides: Record<string, unknown> = {}) {
    fs.writeFileSync(pendingPath(), JSON.stringify({
      identity: state.buildInfo.commit, version: state.buildInfo.version,
      commit: state.buildInfo.commit, writtenAt: '2026-10-24T00:00:00Z', ...overrides,
    }));
  }

  it.each(['full', 'short'])('accepts the legacy nightly %s SHA record and stays clear after restart', (format) => {
    const commit = format === 'full' ? state.buildInfo.commit : state.buildInfo.commitShort;
    writePending({ identity: commit, commit });
    expect(new DesktopUpdateService().getStatus()).toMatchObject({
      phase: 'idle', pendingInstallIdentity: null, lastInstallFailed: false, errorMessage: null,
    });
    expect(fs.existsSync(pendingPath())).toBe(false);
    expect(new DesktopUpdateService().getStatus().lastInstallFailed).toBe(false);
  });

  it('accepts a legacy release version identity', () => {
    Object.assign(state.buildInfo, { channel: 'release', version: '1.0.0' });
    writePending({ identity: '1.0.0' });
    expect(new DesktopUpdateService().getStatus().lastInstallFailed).toBe(false);
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  it.each([
    { identity: 'b'.repeat(40), commit: 'b'.repeat(40) },
    { identity: 'aaaaaaa' + 'b'.repeat(33), commit: 'aaaaaaa' + 'b'.repeat(33) },
    { version: '1.0.1-nightly.2' },
    { commit: 'b'.repeat(40) },
    { channel: 'release' },
    { channel: 'nightly', version: '1.0.1-nightly.2' },
    { channel: 'nightly', commit: 'aaaaaaa' + 'b'.repeat(33) },
  ])('retains a genuinely unmatched installation record: %j', (overrides) => {
    writePending(overrides);
    expect(new DesktopUpdateService().getStatus()).toMatchObject({
      phase: 'error', lastInstallFailed: true, errorMessage: 'update_install_not_completed',
    });
    expect(fs.existsSync(pendingPath())).toBe(true);
  });

  it.each(['full', 'short'])('accepts a matching current-format %s SHA record', (format) => {
    writePending({ channel: 'nightly', commit: format === 'full' ? state.buildInfo.commit : state.buildInfo.commitShort });
    expect(new DesktopUpdateService().getStatus().lastInstallFailed).toBe(false);
    expect(fs.existsSync(pendingPath())).toBe(false);
  });

  it('allows Windows NSIS to update despite an old failure and verifies the next startup', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('TX5DR_INSTALLER_FAMILY', 'nsis');
    const target = manifest('nightly', '1.0.1-nightly.2');
    Object.assign(target.assets[0], {
      name: 'TX-5DR-nightly-windows-x64-nsis.exe', platform: 'windows', package_type: 'exe',
      url: 'https://downloads.test/builds/next/TX-5DR-nightly-windows-x64-nsis.exe',
      auto_update: { supported: true, target: 'nsis', installerFamily: 'nsis', sha512: 'digest' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => target })));
    writePending({ identity: 'c'.repeat(40), commit: 'c'.repeat(40) });
    const prepareInstall = vi.fn();
    const service = new DesktopUpdateService({ prepareInstall });
    expect(service.getStatus().lastInstallFailed).toBe(true);
    const available = await service.checkForUpdates();
    expect(available).toMatchObject({ updateAvailable: true, autoUpdateSupported: true, autoUpdateTarget: 'nsis' });
    const request = { identity: available.identity, allowDowngrade: false };
    await service.download(request);
    state.listeners['update-downloaded']();
    await service.installAndRestart(request);
    expect(prepareInstall).toHaveBeenCalledOnce();
    expect(state.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(JSON.parse(fs.readFileSync(pendingPath(), 'utf8'))).toMatchObject({
      channel: 'nightly', version: target.version, commit: target.commit,
    });
    Object.assign(state.buildInfo, { version: target.version, commit: target.commit, commitShort: target.commit.slice(0, 7) });
    expect(new DesktopUpdateService().getStatus()).toMatchObject({ phase: 'idle', lastInstallFailed: false, errorMessage: null });
    expect(fs.existsSync(pendingPath())).toBe(false);
  });
});

describe('desktop channel ownership', () => {
  it('keeps current and selected channel separate and requires explicit downgrade confirmation', async () => {
    const saveChannel = vi.fn(); const prepareInstall = vi.fn();
    const service = new DesktopUpdateService({ saveChannel, prepareInstall });
    const status = await service.setChannel({ channel: 'release' });
    expect(saveChannel).toHaveBeenCalledWith('release');
    expect(status.channel).toBe('nightly'); expect(status.targetChannel).toBe('release');
    expect(status.operation).toBe('downgrade');
    await expect(service.download({ identity: status.identity, allowDowngrade: false })).rejects.toThrow('confirmation');
    expect(state.updater.downloadUpdate).not.toHaveBeenCalled();
    await service.download({ identity: status.identity, allowDowngrade: true });
    expect(state.updater.allowDowngrade).toBe(true);
    state.listeners['update-downloaded']();
    await expect(service.installAndRestart({ identity: 'stale', allowDowngrade: true })).rejects.toThrow('target_changed');
    expect(prepareInstall).not.toHaveBeenCalled();
  });
  it('preserves selection for a genuinely empty channel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const service = new DesktopUpdateService();
    const status = await service.setChannel({ channel: 'release' });
    expect(status.availability).toBe('empty'); expect(status.targetChannel).toBe('release');
    expect(status.updateAvailable).toBe(false); expect(status.errorMessage).toBeNull();
  });
  it('discards a late check after a channel change', async () => {
    let resolveFirst!: (response: unknown) => void;
    const delayed = new Promise(resolve => { resolveFirst = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(() => delayed).mockImplementation(async () => ({ ok: true, status: 200, json: async () => manifest('release', '1.0.0') })));
    const service = new DesktopUpdateService();
    const first = service.checkForUpdates();
    const switched = await service.setChannel({ channel: 'release' });
    resolveFirst({ ok: true, status: 200, json: async () => manifest('nightly', '1.0.1-nightly.2') });
    await first;
    expect(service.getStatus().identity).toBe(switched.identity);
  });
  it('waits for cancellation before switching and never installs the old download', async () => {
    state.updater.downloadUpdate.mockImplementation((token) => new Promise((_resolve, reject) => token.onCancel(() => reject(new Error('cancelled')))));
    const service = new DesktopUpdateService();
    const first = await service.setChannel({ channel: 'release' });
    const downloading = service.download({ identity: first.identity, allowDowngrade: true });
    await vi.waitFor(() => expect(state.updater.downloadUpdate).toHaveBeenCalled());
    const next = await service.setChannel({ channel: 'nightly' });
    await downloading;
    expect(next.targetChannel).toBe('nightly'); expect(next.downloaded).toBe(false);
    await expect(service.installAndRestart({ identity: first.identity, allowDowngrade: true })).rejects.toThrow('target_changed');
  });
  it('does not hand off installation when backup or shutdown fails', async () => {
    const service = new DesktopUpdateService({ prepareInstall: async () => { throw new Error('backup_failed'); } });
    const status = await service.setChannel({ channel: 'release' });
    await service.download({ identity: status.identity, allowDowngrade: true });
    state.listeners['update-downloaded']();
    await expect(service.installAndRestart({ identity: status.identity, allowDowngrade: true })).rejects.toThrow('backup_failed');
    expect(state.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
