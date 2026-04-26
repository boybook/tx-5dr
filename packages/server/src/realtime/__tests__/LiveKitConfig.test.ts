import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetLiveKitPublicUrl = vi.fn<[], string | null>();

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getLiveKitPublicUrl: () => mockGetLiveKitPublicUrl(),
    }),
  },
}));

vi.mock('../LiveKitCredentialState.js', () => ({
  getLiveKitCredentialRuntimeStatus: () => ({
    source: 'managed-file',
    apiKeyPreview: 'tx5dr-test',
    filePath: '/tmp/livekit.env',
  }),
  getLiveKitCredentialValues: () => ({
    apiKey: 'tx5dr-test',
    apiSecret: 'secret',
  }),
}));

describe('LiveKitConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetLiveKitPublicUrl.mockReturnValue(null);
    delete process.env.LIVEKIT_URL;
    delete process.env.LIVEKIT_TCP_PORT;
    delete process.env.LIVEKIT_UDP_PORT_RANGE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('derives a same-origin /livekit URL for browser clients', async () => {
    const { LiveKitConfig } = await import('../LiveKitConfig.js');

    const resolved = LiveKitConfig.resolvePublicWsUrl({
      headers: {
        host: 'radio.example.test:8443',
        'x-forwarded-proto': 'https',
      },
      protocol: 'https',
    });

    expect(resolved).toBe('wss://radio.example.test:8443/livekit');
  });

  it('reports the browser-facing signaling port from the derived /livekit URL', async () => {
    const { LiveKitConfig } = await import('../LiveKitConfig.js');

    const hints = LiveKitConfig.getConnectivityHints({
      headers: {
        host: 'radio.example.test:8076',
        'x-forwarded-proto': 'http',
      },
      protocol: 'http',
    });

    expect(hints.signalingUrl).toBe('ws://radio.example.test:8076/livekit');
    expect(hints.signalingPort).toBe(8076);
    expect(hints.rtcTcpPort).toBe(7881);
  });

  it('prefers the browser origin when a dev proxy rewrites the host header to the backend port', async () => {
    const { LiveKitConfig } = await import('../LiveKitConfig.js');

    const resolved = LiveKitConfig.resolvePublicWsUrl({
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://localhost:8076',
        referer: 'http://localhost:8076/',
      },
      protocol: 'http',
    });

    expect(resolved).toBe('ws://localhost:8076/livekit');
  });

  it('prefers the configured advanced override when present', async () => {
    mockGetLiveKitPublicUrl.mockReturnValue('wss://voice.example.test/custom-livekit');
    const { LiveKitConfig } = await import('../LiveKitConfig.js');

    const resolved = LiveKitConfig.resolvePublicWsUrl({
      headers: {
        host: 'radio.example.test:8443',
        'x-forwarded-proto': 'https',
      },
      protocol: 'https',
    });

    expect(resolved).toBe('wss://voice.example.test/custom-livekit');
  });
});
