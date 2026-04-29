import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { UserRole } from '@tx5dr/contracts';
import { decodeWsCompatAudioFrame, int16ToFloat32Pcm } from '@tx5dr/core';

const mockGetRealtimeTransportPolicy = vi.fn<[], 'auto' | 'force-compat'>();
const mockGetConnectivityHints = vi.fn();
const mockResolveSource = vi.fn();
const mockRtcDataAudioAvailable = vi.fn<[], boolean>();
const mockRtcDataAudioBuildOffer = vi.fn();
const mockRtcDataAudioAcceptConnection = vi.fn();

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: {
    getInstance: () => ({
      getRealtimeTransportPolicy: () => mockGetRealtimeTransportPolicy(),
    }),
  },
}));

vi.mock('../RtcDataAudioManager.js', () => ({
  buildRtcDataAudioConnectivityHints: () => mockGetConnectivityHints(),
  RtcDataAudioManager: class {
    isAvailable = async () => mockRtcDataAudioAvailable();
    isAvailableCached = () => mockRtcDataAudioAvailable();
    getUnavailableReason = () => mockRtcDataAudioAvailable() ? null : 'mock-unavailable';
    buildOffer = mockRtcDataAudioBuildOffer;
    acceptConnection = mockRtcDataAudioAcceptConnection;
  },
}));

vi.mock('../../openwebrx/OpenWebRXStationManager.js', () => ({
  OpenWebRXStationManager: {
    getInstance: () => ({
      getListenStatus: () => null,
      getBufferedPreviewAudioService: () => null,
    }),
  },
}));

describe('RealtimeTransportManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockGetRealtimeTransportPolicy.mockReturnValue('auto');
    mockGetConnectivityHints.mockReturnValue({
      signalingUrl: 'ws://radio.example.test:8076/api/realtime/rtc-data-audio',
      localUdpPort: 50110,
      publicCandidateEnabled: false,
      publicEndpoint: null,
      iceServers: ['stun:stun.l.google.com:19302'],
      fallbackTransport: 'ws-compat',
    });
    mockResolveSource.mockReset();
    mockRtcDataAudioAvailable.mockReturnValue(true);
    mockRtcDataAudioBuildOffer.mockImplementation((params) => ({
      transport: 'rtc-data-audio',
      direction: params.direction,
      url: 'ws://radio.example.test:8076/api/realtime/rtc-data-audio',
      token: 'rtc-token',
      participantIdentity: params.direction === 'send' ? 'rtc-send:test' : null,
      participantName: params.label ?? null,
    }));
    mockRtcDataAudioAcceptConnection.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createManager() {
    const { RealtimeTransportManager } = await import('../RealtimeTransportManager.js');
    return RealtimeTransportManager.initialize(
      {} as never,
      { resolveSource: mockResolveSource } as never,
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
      requestHeaders: {
        host: 'radio.example.test:8076',
        'x-forwarded-proto': 'http',
      },
      requestProtocol: 'http',
      ...overrides,
    };
  }

  it('prefers rtc-data-audio by default and keeps ws-compat as fallback', async () => {
    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams());

    expect(session.preferredTransport).toBe('rtc-data-audio');
    expect(session.selectionReason).toBe('default-rtc-data-audio');
    expect(session.forcedCompatibilityMode).toBe(false);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['rtc-data-audio', 'ws-compat']);
  });

  it('returns ws-compat only when server policy forces compatibility mode', async () => {
    mockGetRealtimeTransportPolicy.mockReturnValue('force-compat');

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams());

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.effectiveTransportPolicy).toBe('force-compat');
    expect(session.selectionReason).toBe('server-policy');
    expect(session.forcedCompatibilityMode).toBe(true);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
  });

  it('respects an explicit ws-compat override', async () => {
    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      transportOverride: 'ws-compat',
    }));

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.selectionReason).toBe('client-override');
    expect(session.forcedCompatibilityMode).toBe(true);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
  });

  it('resolves TX buffer policy for ws-compat send sessions', async () => {
    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      direction: 'send',
      role: UserRole.OPERATOR,
      transportOverride: 'ws-compat',
      voiceTxBufferPreference: { profile: 'stable' },
    }));

    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
    expect(session.voiceTxBufferPolicy).toMatchObject({
      profile: 'stable',
      targetMs: 170,
      uplinkMaxBufferedAudioMs: 340,
    });
  });

  it('passes TX buffer policy into rtc-data-audio send offers', async () => {
    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      direction: 'send',
      role: UserRole.OPERATOR,
      voiceTxBufferPreference: { profile: 'custom', customTargetBufferMs: 220 },
    }));

    expect(session.offers.map((offer) => offer.transport)).toEqual(['rtc-data-audio', 'ws-compat']);
    expect(session.voiceTxBufferPolicy).toMatchObject({
      profile: 'custom',
      targetMs: 220,
    });
    expect(mockRtcDataAudioBuildOffer).toHaveBeenCalledWith(expect.objectContaining({
      voiceTxBufferPolicy: expect.objectContaining({
        profile: 'custom',
        targetMs: 220,
      }),
    }));
  });

  it('falls back to ws-compat when rtc-data-audio is unavailable', async () => {
    mockRtcDataAudioAvailable.mockReturnValue(false);
    mockRtcDataAudioBuildOffer.mockResolvedValue(null);

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams());

    expect(session.preferredTransport).toBe('ws-compat');
    expect(session.selectionReason).toBe('rtc-data-audio-unavailable');
    expect(session.forcedCompatibilityMode).toBe(false);
    expect(session.offers.map((offer) => offer.transport)).toEqual(['ws-compat']);
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

  it('does not leak an internal nginx listen port into Cloudflare-facing compat websocket URLs', async () => {
    mockGetRealtimeTransportPolicy.mockReturnValue('force-compat');

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      requestHeaders: {
        host: '5dr2.992218.xyz',
        origin: 'https://5dr2.992218.xyz',
        referer: 'https://5dr2.992218.xyz/',
        'x-forwarded-host': '5dr2.992218.xyz',
        'x-forwarded-port': '8076',
        'x-forwarded-proto': 'http',
      },
      requestProtocol: 'http',
    }));

    expect(session.offers).toHaveLength(1);
    expect(session.offers[0]?.transport).toBe('ws-compat');
    expect(session.offers[0]?.url).toBe('wss://5dr2.992218.xyz/api/realtime/ws-compat');
  });

  it('sends ws-compat recv frames through the transport-edge integer decimator', async () => {
    const source = Object.assign(new EventEmitter(), {
      id: 'native-radio:radio',
      sourcePath: 'native-radio',
      getLatestStats: () => null,
    });
    mockResolveSource.mockReturnValue(source);

    const manager = await createManager();
    const session = await manager.issueSession(createIssueSessionParams({
      transportOverride: 'ws-compat',
    }));
    const offer = session.offers[0];
    expect(offer?.transport).toBe('ws-compat');

    const sent: Array<string | Buffer> = [];
    const socket = {
      readyState: 1,
      send: vi.fn((payload: string | Buffer) => {
        sent.push(payload);
      }),
      close: vi.fn(),
      once: vi.fn(),
      on: vi.fn(),
    };

    manager.acceptCompatConnection(socket as never, `/api/realtime/ws-compat?token=${offer?.token}`);
    const sourceSamples = new Float32Array(96).fill(0.5);
    source.emit('audioFrame', {
      samples: sourceSamples,
      sampleRate: 48000,
      channels: 1,
      timestamp: 1234,
      sequence: 10,
      sourceKind: 'native-radio',
      nativeSourceKind: 'audio-device',
    });

    expect(socket.close).not.toHaveBeenCalled();
    expect(sent[0]).toBe(JSON.stringify({
      type: 'ready',
      transport: 'ws-compat',
      direction: 'recv',
      scope: 'radio',
    }));
    expect(Buffer.isBuffer(sent[1])).toBe(true);
    const binary = sent[1] as Buffer;
    const decoded = decodeWsCompatAudioFrame(
      binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength),
    );
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.samplesPerChannel).toBe(48);
    expect(decoded.sequence).toBe(0);
    expect(decoded.timestampMs).toBe(1234);
    const float32 = int16ToFloat32Pcm(decoded.pcm);
    expect(float32[0]).toBeCloseTo(0.5, 3);
    expect(float32[float32.length - 1]).toBeCloseTo(0.5, 3);
  });
});
