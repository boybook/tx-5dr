import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';

const mockGetRealtimeTransportPolicy = vi.fn<[], 'auto' | 'force-compat'>();
const mockGetLiveKitPublicUrl = vi.fn<[], string | null>();
const mockLiveKitEnabled = vi.fn<[], boolean>();
const mockLiveKitRuntimeAvailable = vi.fn<[], boolean>();
const mockGetConnectivityHints = vi.fn();
const mockIssueClientToken = vi.fn();
const mockFinalizeToken = vi.fn();
const mockGetScopeHealth = vi.fn();

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getRealtimeTransportPolicy: () => mockGetRealtimeTransportPolicy(),
      getLiveKitPublicUrl: () => mockGetLiveKitPublicUrl(),
    }),
  },
}));

vi.mock('../LiveKitConfig.js', () => ({
  LiveKitConfig: {
    isEnabled: () => mockLiveKitEnabled(),
    isRuntimeAvailable: () => mockLiveKitRuntimeAvailable(),
    getConnectivityHints: () => mockGetConnectivityHints(),
  },
}));

vi.mock('../LiveKitAuthService.js', () => ({
  LiveKitAuthService: class {
    issueClientToken = mockIssueClientToken;
    finalizeToken = mockFinalizeToken;
  },
}));

vi.mock('../../openwebrx/OpenWebRXStationManager.js', () => ({
  OpenWebRXStationManager: {
    getInstance: () => ({
      getListenStatus: () => null,
      getAudioMonitorService: () => null,
    }),
  },
}));

describe('RealtimeTransportManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetRealtimeTransportPolicy.mockReturnValue('auto');
    mockGetLiveKitPublicUrl.mockReturnValue(null);
    mockLiveKitEnabled.mockReturnValue(true);
    mockLiveKitRuntimeAvailable.mockReturnValue(true);
    mockGetConnectivityHints.mockReturnValue({
      signalingUrl: 'ws://livekit.example.test:7880',
      signalingPort: 7880,
      rtcTcpPort: 7881,
      udpPortRange: '50000-50100',
      publicUrlOverrideActive: false,
    });
    mockGetScopeHealth.mockReturnValue({
      healthy: true,
      updatedAt: Date.now(),
      issueCode: null,
    });
    mockIssueClientToken.mockReturnValue({
      url: 'ws://livekit.example.test:7880',
      token: 'livekit-token',
      participantIdentity: 'listener-1',
      participantName: 'Listener',
      roomName: 'radio-room',
    });
    mockFinalizeToken.mockResolvedValue({
      url: 'ws://livekit.example.test:7880',
      token: 'livekit-token',
      participantIdentity: 'listener-1',
      participantName: 'Listener',
      roomName: 'radio-room',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createManager() {
    const { RealtimeTransportManager } = await import('../RealtimeTransportManager.js');
    return RealtimeTransportManager.initialize(
      {} as never,
      { getScopeHealth: mockGetScopeHealth } as never,
    );
  }

  function createIssueSessionParams(
    overrides: Partial<Parameters<Awaited<ReturnType<typeof createManager>>['issueSession']>[0]> = {},
  ) {
    return {
      scope: 'radio' as const,
      direction: 'recv' as const,
      role: UserRole.VIEWER,
      clientKind: 'web',
      roomName: 'radio-room',
      requestHeaders: {
        host: 'radio.example.test:8076',
        'x-forwarded-proto': 'http',
      },
      requestProtocol: 'http',
      ...overrides,
    };
  }

  it('returns ws-compat only when server policy forces compatibility mode', async () => {
    mockGetRealtimeTransportPolicy.mockReturnValue('force-compat');

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams());

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.effectiveTransportPolicy).toBe('force-compat');
    expect(session.selectionReason).toBe('server-policy');
    expect(session.forcedCompatibilityMode).toBe(true);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
    expect(mockIssueClientToken).not.toHaveBeenCalled();
  });

  it('respects an explicit ws-compat override and skips the livekit offer', async () => {
    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      transportOverride: 'ws-compat',
    }));

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.selectionReason).toBe('client-override');
    expect(session.forcedCompatibilityMode).toBe(true);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
    expect(mockIssueClientToken).not.toHaveBeenCalled();
  });

  it('falls back to ws-compat when livekit is disabled even if the client asked for livekit', async () => {
    mockLiveKitEnabled.mockReturnValue(false);

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      transportOverride: 'livekit',
    }));

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.selectionReason).toBe('livekit-disabled');
    expect(session.forcedCompatibilityMode).toBe(true);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
  });

  it('prefers ws-compat first but still keeps livekit as a secondary offer when the receive bridge is unhealthy', async () => {
    mockGetScopeHealth.mockReturnValue({
      healthy: false,
      updatedAt: Date.now(),
      issueCode: 'SIGNALING_UNREACHABLE',
    });

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams());

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.selectionReason).toBe('bridge-unhealthy');
    expect(session.forcedCompatibilityMode).toBe(false);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat', 'livekit']);
  });

  it('derives the compat websocket URL from the browser origin when a dev proxy rewrites host to the backend', async () => {
    mockGetRealtimeTransportPolicy.mockReturnValue('force-compat');

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      requestHeaders: {
        host: '127.0.0.1:4000',
        origin: 'http://localhost:8076',
        referer: 'http://localhost:8076/',
      },
      requestProtocol: 'http',
    }));

    expect(session.offers).toHaveLength(1);
    expect(session.offers[0]?.transport).toBe('ws-compat');
    expect(session.offers[0]?.url).toBe('ws://localhost:8076/api/realtime/ws-compat');
  });
});
