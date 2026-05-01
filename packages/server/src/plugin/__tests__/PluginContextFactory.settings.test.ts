import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_DECODE_WINDOW_SETTINGS,
  type DigitalRadioEngineEvents,
  MODES,
  type PluginPermission,
  type RealtimeSettingsResponseData,
} from '@tx5dr/contracts';
import type { LoadedPlugin, PluginManagerDeps } from '../types.js';
import { PluginContextFactory } from '../PluginContextFactory.js';
import { ConfigManager } from '../../config/config-manager.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createDeps(overrides: Partial<PluginManagerDeps> = {}): PluginManagerDeps {
  return {
    eventEmitter: new EventEmitter<DigitalRadioEngineEvents>(),
    getOperators: () => [],
    getOperatorById: () => undefined,
    getCurrentMode: () => MODES.FT8,
    getOperatorAutomationSnapshot: () => null,
    requestOperatorCall: () => {},
    getRadioFrequency: async () => null,
    setRadioFrequency: () => {},
    getRadioBand: () => '20m',
    getRadioConnected: () => true,
    getLatestSlotPack: () => null,
    interruptOperatorTransmission: async () => {},
    hasWorkedCallsign: async () => false,
    resetOperatorRuntime: () => {},
    dataDir: '/tmp',
    ...overrides,
  };
}

function createPlugin(permissions: PluginPermission[] = []): LoadedPlugin {
  return {
    definition: {
      name: 'settings-test-plugin',
      version: '1.0.0',
      type: 'utility',
      permissions,
    },
    isBuiltIn: false,
  };
}

function mockConfigManager() {
  const ft8 = {
    myCallsign: 'BG4IAJ',
    myGrid: 'OM96',
    frequency: 14_074_000,
    transmitPower: 25,
    autoReply: false,
    maxQSOTimeout: 6,
    maxSameTransmissionCount: 20,
    decodeWhileTransmitting: false,
    spectrumWhileTransmitting: true,
  };
  let realtime = {
    transportPolicy: 'auto' as const,
    rtcDataAudioPublicHost: null as string | null,
    rtcDataAudioPublicUdpPort: null as number | null,
  };
  let ntpServers = ['pool.ntp.org'];
  const configManager = {
    getFT8Config: vi.fn(() => ({ ...ft8 })),
    updateFT8Config: vi.fn(async (patch: Partial<typeof ft8>) => { Object.assign(ft8, patch); }),
    getDecodeWindowSettings: vi.fn(() => DEFAULT_DECODE_WINDOW_SETTINGS),
    updateDecodeWindowSettings: vi.fn(async () => undefined),
    getRealtimeTransportPolicy: vi.fn(() => realtime.transportPolicy),
    updateRealtimeTransportPolicy: vi.fn(async (transportPolicy: typeof realtime.transportPolicy) => { realtime = { ...realtime, transportPolicy }; }),
    getRtcDataAudioPublicHost: vi.fn(() => realtime.rtcDataAudioPublicHost),
    updateRtcDataAudioPublicHost: vi.fn(async (rtcDataAudioPublicHost: string | null) => { realtime = { ...realtime, rtcDataAudioPublicHost }; }),
    getRtcDataAudioPublicUdpPort: vi.fn(() => realtime.rtcDataAudioPublicUdpPort),
    updateRtcDataAudioPublicUdpPort: vi.fn(async (rtcDataAudioPublicUdpPort: number | null) => { realtime = { ...realtime, rtcDataAudioPublicUdpPort }; }),
    getCustomFrequencyPresets: vi.fn(() => null),
    updateCustomFrequencyPresets: vi.fn(async () => undefined),
    resetCustomFrequencyPresets: vi.fn(async () => undefined),
    getStationInfo: vi.fn(() => ({ callsign: 'BG4IAJ' })),
    updateStationInfo: vi.fn(async () => undefined),
    getPSKReporterConfig: vi.fn(() => ({
      enabled: false,
      receiverCallsign: '',
      receiverLocator: '',
      decodingSoftware: 'TX-5DR',
      antennaInformation: '',
      reportIntervalSeconds: 30,
      useTestServer: false,
      stats: { todayReportCount: 0, totalReportCount: 0, consecutiveFailures: 0 },
    })),
    updatePSKReporterConfig: vi.fn(async () => undefined),
    getNtpServers: vi.fn(() => ntpServers),
    getDefaultNtpServers: vi.fn(() => ['pool.ntp.org']),
    updateNtpServers: vi.fn(async (servers: string[]) => { ntpServers = servers; }),
  };
  vi.spyOn(ConfigManager, 'getInstance').mockReturnValue(configManager as unknown as ConfigManager);
  return configManager;
}

async function createContext(plugin: LoadedPlugin, deps: PluginManagerDeps = createDeps()) {
  const storageDir = await mkdtemp(join(tmpdir(), 'tx5dr-plugin-settings-'));
  tempDirs.push(storageDir);
  const factory = new PluginContextFactory(deps);
  return factory.create(plugin, undefined, 'global', storageDir, () => {}, () => ({}));
}

describe('PluginContextFactory host settings access', () => {
  it('rejects settings namespaces when plugin permissions are missing', async () => {
    mockConfigManager();
    const ctx = await createContext(createPlugin());

    await expect(ctx.settings.ft8.get()).rejects.toThrow("requires permission 'settings:ft8'");
    await expect(ctx.settings.ntp.update({ servers: ['time.cloudflare.com'] })).rejects.toThrow("requires permission 'settings:ntp'");
  });

  it('allows an ft8-permitted plugin to set guard backdoor values', async () => {
    const configManager = mockConfigManager();
    const ctx = await createContext(createPlugin(['settings:ft8']));

    await expect(ctx.settings.ft8.update({ maxSameTransmissionCount: 0 })).resolves.toMatchObject({ maxSameTransmissionCount: 0 });
    await expect(ctx.settings.ft8.update({ maxSameTransmissionCount: 999 })).resolves.toMatchObject({ maxSameTransmissionCount: 999 });
    expect(configManager.updateFT8Config).toHaveBeenCalledWith({ maxSameTransmissionCount: 0 });
    expect(configManager.updateFT8Config).toHaveBeenCalledWith({ maxSameTransmissionCount: 999 });
  });

  it('validates decode window and NTP updates through host schemas', async () => {
    mockConfigManager();
    const ctx = await createContext(createPlugin(['settings:decode-windows', 'settings:ntp']));

    await expect(ctx.settings.decodeWindows.update({ ft8: { preset: 'custom', customWindowTiming: [-1000] } })).resolves.toBeDefined();
    await expect(ctx.settings.decodeWindows.update({ ft8: { preset: 'custom', customWindowTiming: [-99999] } })).rejects.toThrow();
    await expect(ctx.settings.ntp.update({ servers: ['time.cloudflare.com'] })).resolves.toMatchObject({ servers: ['time.cloudflare.com'] });
    await expect(ctx.settings.ntp.update({ servers: [] })).rejects.toThrow();
  });

  it('emits realtimeSettingsChanged after realtime updates', async () => {
    mockConfigManager();
    const deps = createDeps();
    const realtimeSpy = vi.fn((data: RealtimeSettingsResponseData) => data);
    deps.eventEmitter.on('realtimeSettingsChanged', realtimeSpy);
    const ctx = await createContext(createPlugin(['settings:realtime']), deps);

    await ctx.settings.realtime.update({
      transportPolicy: 'force-compat',
      rtcDataAudioPublicHost: 'radio.example.com',
      rtcDataAudioPublicUdpPort: 50110,
    });

    expect(realtimeSpy).toHaveBeenCalledWith(expect.objectContaining({
      transportPolicy: 'force-compat',
      rtcDataAudioPublicHost: 'radio.example.com',
      rtcDataAudioPublicUdpPort: 50110,
    }));
  });
});
