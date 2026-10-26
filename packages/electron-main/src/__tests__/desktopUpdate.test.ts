import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ listeners: {} as Record<string, (...args: any[]) => void>, updater: {
  autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false,
  logger: undefined as unknown, setFeedURL: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  on: vi.fn(),
} }));
vi.mock('electron', () => ({ app: { isReady: () => false }, shell: { openExternal: vi.fn() } }));
vi.mock('electron-updater', () => ({ autoUpdater: state.updater, Provider: class {} }));
vi.mock('../generated/buildInfo.js', () => ({ BUILD_INFO: { channel: 'nightly', version: '1.0.1-nightly.1+gaaaaaaa', commit: 'a'.repeat(40), commitShort: 'aaaaaaa', buildTimestamp: '2026-10-24T00:00:00Z' } }));
import { DesktopUpdateService } from '../desktopUpdate.js';

function manifest(channel: string, version: string) {
  return { product: 'app', channel, version, tag: channel === 'nightly' ? 'nightly-app' : 'v1.0.0', commit: 'b'.repeat(40), published_at: '2026-10-24T01:00:00Z', assets: [{
    name: 'TX-5DR.AppImage', url: 'https://downloads.test/builds/target/TX-5DR.AppImage', platform: 'linux', arch: process.arch, package_type: 'AppImage', size: 100, sha256: 'a'.repeat(64), sha512: 'digest',
    auto_update: { supported: true, target: 'appimage', installerFamily: 'appimage', sha512: 'digest' },
  }] };
}

const originalPlatform = process.platform;
const originalAppImage = process.env.APPIMAGE;
afterEach(() => { Object.defineProperty(process, 'platform', { value: originalPlatform }); if (originalAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = originalAppImage; vi.unstubAllGlobals(); });
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.clearAllMocks();
  process.env.APPIMAGE = '/tmp/TX-5DR.AppImage';
  state.updater.on.mockImplementation((name, callback) => { state.listeners[name] = callback; });
  state.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true });
  state.updater.downloadUpdate.mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('/release/') ? manifest('release', '1.0.0') : manifest('nightly', '1.0.1-nightly.2') })));
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
