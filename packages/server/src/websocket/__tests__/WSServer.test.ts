import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserRole, WSMessageType, type SystemStatus } from '@tx5dr/contracts';
import { WSConnection, WSServer } from '../WSServer.js';
import { ConfigManager } from '../../config/config-manager.js';

function createStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    isRunning: false,
    isDecoding: false,
    currentMode: { name: 'VOICE' } as any,
    currentTime: Date.now(),
    nextSlotIn: 0,
    audioStarted: false,
    radioConnected: true,
    engineMode: 'voice',
    ...overrides,
  };
}

describe('WSServer initial frequency snapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds an initial voice frequency event from the current known radio frequency', () => {
    const configManager = ConfigManager.getInstance();
    vi.spyOn(configManager, 'getLastVoiceFrequency').mockReturnValue({
      frequency: 14270000,
      radioMode: 'USB',
      band: '20m',
      description: '14.270 MHz 20m Calling',
    });

    const server = Object.create(WSServer.prototype) as any;
    server.digitalRadioEngine = {
      getRadioManager: () => ({
        getKnownFrequency: () => 14123456,
        isConnected: () => true,
      }),
      getEngineMode: () => 'voice',
    };

    const result = (server as any).buildInitialFrequencyState(createStatus());

    expect(result).toMatchObject({
      frequency: 14123456,
      mode: 'VOICE',
      band: '20m',
      radioMode: 'USB',
      radioConnected: true,
      source: 'radio',
    });
    expect(result.description).toBe('14.123 MHz 20m');
  });

  it('falls back to the saved voice frequency when no live radio frequency is known yet', () => {
    const configManager = ConfigManager.getInstance();
    vi.spyOn(configManager, 'getLastVoiceFrequency').mockReturnValue({
      frequency: 14270000,
      radioMode: 'USB',
      band: '20m',
      description: '14.270 MHz 20m Calling',
    });

    const server = Object.create(WSServer.prototype) as any;
    server.digitalRadioEngine = {
      getRadioManager: () => ({
        getKnownFrequency: () => null,
        isConnected: () => true,
      }),
      getEngineMode: () => 'voice',
    };

    const result = (server as any).buildInitialFrequencyState(createStatus());

    expect(result).toEqual({
      frequency: 14270000,
      mode: 'VOICE',
      band: '20m',
      description: '14.270 MHz 20m Calling',
      radioMode: 'USB',
      radioConnected: true,
      source: 'radio',
    });
  });

  it('filters own callsign lookup by the selected operator only', () => {
    const server = Object.create(WSServer.prototype) as any;
    server.digitalRadioEngine = {
      operatorManager: {
        getOperator: vi.fn((operatorId: string) => {
          if (operatorId === 'op-a') {
            return { config: { myCallsign: 'BG5AAA' } };
          }
          if (operatorId === 'op-b') {
            return { config: { myCallsign: 'BH1BBB' } };
          }
          return null;
        }),
      },
    };

    const selectedCallsigns = (server as any).getSelectedOperatorCallsigns('op-b');
    const noSelectionCallsigns = (server as any).getSelectedOperatorCallsigns(null);

    expect(Array.from(selectedCallsigns)).toEqual(['BH1BBB']);
    expect(Array.from(noSelectionCallsigns)).toEqual([]);
  });

  it('only shows the radio connected toast on disconnected-to-connected transitions', () => {
    const server = Object.create(WSServer.prototype) as any;
    server.lastRadioConnectedForToast = null;

    expect(server.shouldBroadcastRadioConnectedToast(false)).toBe(false);
    expect(server.shouldBroadcastRadioConnectedToast(true)).toBe(true);
    expect(server.shouldBroadcastRadioConnectedToast(true)).toBe(false);
    expect(server.shouldBroadcastRadioConnectedToast(false)).toBe(false);
    expect(server.shouldBroadcastRadioConnectedToast(true)).toBe(true);
  });
});

function createTestConnection(id = 'conn-test'): { connection: WSConnection; sent: Array<{ type: string; data: any }> } {
  const sent: Array<{ type: string; data: any }> = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ws = {
    readyState: 1,
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    off: vi.fn(),
    close: vi.fn(),
    send: vi.fn((raw: string) => {
      const parsed = JSON.parse(raw);
      sent.push({ type: parsed.type, data: parsed.data });
    }),
  };
  return { connection: new WSConnection(ws, id), sent };
}

describe('WSServer security filtering', () => {
  it('keeps public viewers from self-subscribing to operators', async () => {
    const { connection, sent } = createTestConnection('conn-public');
    connection.setPublicViewer();
    connection.completeHandshake([]);

    const server = Object.create(WSServer.prototype) as any;
    server.getConnection = vi.fn(() => connection);
    server.digitalRadioEngine = {
      operatorManager: {
        getOperatorsStatus: vi.fn(() => [
          { id: 'op-a', context: { myCall: 'BG5AAA' } },
          { id: 'op-b', context: { myCall: 'BH1BBB' } },
        ]),
      },
    };
    server.sendProjectedRecentSlotPacks = vi.fn();

    await (server as any).handleSetClientEnabledOperators('conn-public', {
      enabledOperatorIds: ['op-a', 'op-b'],
    });

    expect(connection.getEnabledOperatorIds()).toEqual([]);
    expect(connection.getSelectedOperatorId()).toBeNull();
    expect(sent.find(message => message.type === WSMessageType.OPERATORS_LIST)?.data).toEqual({ operators: [] });
  });

  it('rejects non-auth commands before handshake', async () => {
    const send = vi.fn();
    const server = Object.create(WSServer.prototype) as any;
    server.getConnection = vi.fn(() => ({
      hasResolvedIdentity: () => true,
      isHandshakeCompleted: () => false,
      isPublicViewer: () => false,
      send,
    }));

    await (server as any).handleClientCommand('conn-1', {
      type: WSMessageType.GET_PLUGIN_RUNTIME_LOG_HISTORY,
      data: { limit: 1 },
    });

    expect(send).toHaveBeenCalledWith(WSMessageType.ERROR, expect.objectContaining({
      code: 'UNAUTHORIZED',
      message: 'handshake_required',
    }));
  });

  it('redacts operator identity from public slot packs and tx logs', async () => {
    const { connection, sent } = createTestConnection('conn-public');
    connection.setPublicViewer();
    connection.completeHandshake([]);

    const server = Object.create(WSServer.prototype) as any;
    server.slotPackProjectionService = {
      projectSlotPack: vi.fn(async (slotPack: any) => slotPack),
    };
    const slotPack = {
      id: 'slot-1',
      startMs: 1000,
      frames: [
        {
          utc: '00:00:00',
          snr: -999,
          dt: 0,
          freq: 14074000,
          message: 'CQ BG5AAA PM00',
          operatorId: 'op-a',
          logbookAnalysis: { callsign: 'BG5AAA' },
        },
      ],
      stats: {},
      decodeHistory: [],
    };

    const customized = await (server as any).customizeSlotPackForClient(connection, slotPack);
    expect(customized.frames[0].operatorId).toBeUndefined();
    expect(customized.frames[0].logbookAnalysis).toBeUndefined();

    server.getActiveConnections = vi.fn(() => [connection]);
    (server as any).broadcastTransmissionLog({
      operatorId: 'op-a',
      time: '000000',
      message: 'CQ BG5AAA PM00',
      frequency: 14074000,
      slotStartMs: 1000,
    });

    expect(sent.find(message => message.type === WSMessageType.TRANSMISSION_LOG)?.data.operatorId).toBe('public-tx');
  });

  it('redacts radio topology and PTT operator ids for public viewers', () => {
    const { connection: publicConnection, sent: publicSent } = createTestConnection('conn-public');
    publicConnection.setPublicViewer();
    publicConnection.completeHandshake([]);

    const { connection: adminConnection, sent: adminSent } = createTestConnection('conn-admin');
    adminConnection.setAuthenticated(UserRole.ADMIN, [], 'admin');
    adminConnection.completeHandshake([]);

    const server = Object.create(WSServer.prototype) as any;
    server.getActiveConnections = vi.fn(() => [publicConnection, adminConnection]);

    (server as any).broadcastRadioStatusChanged({
      connected: true,
      status: 'connected',
      radioInfo: null,
      radioConfig: {
        type: 'icom-wlan',
        icomWlan: { ip: '192.168.1.50', port: 50001, userName: 'radio-user', password: 'radio-secret' },
        cwKeyPort: '/dev/tty.cw',
      },
    });
    (server as any).broadcastPttStatusChanged({
      isTransmitting: true,
      operatorIds: ['op-a'],
      operatorId: 'op-a',
    });

    expect(publicSent.find(message => message.type === WSMessageType.RADIO_STATUS_CHANGED)?.data.radioConfig).toEqual({ type: 'icom-wlan' });
    expect(adminSent.find(message => message.type === WSMessageType.RADIO_STATUS_CHANGED)?.data.radioConfig.icomWlan.password).toBe('radio-secret');
    expect(publicSent.find(message => message.type === WSMessageType.PTT_STATUS_CHANGED)?.data.operatorIds).toEqual([]);
    expect(adminSent.find(message => message.type === WSMessageType.PTT_STATUS_CHANGED)?.data.operatorIds).toEqual(['op-a']);
  });
});

describe('WSServer current slot handshake snapshot', () => {
  it('sends the current slot snapshot to only the new connection', () => {
    const slotInfo = {
      id: 'FT8-42-630000',
      startMs: 630000,
      phaseMs: 7500,
      driftMs: 0,
      cycleNumber: 42,
      utcSeconds: 630,
      mode: 'FT8',
    };
    const server = Object.create(WSServer.prototype) as any;
    server.digitalRadioEngine = {
      getCurrentSlotInfo: vi.fn(() => slotInfo),
    };
    const connection = {
      send: vi.fn(),
    };

    (server as any).sendCurrentSlotSnapshot(connection);

    expect(connection.send).toHaveBeenCalledWith('slotStart', slotInfo);
  });

  it('does not send a slot snapshot when no digital slot is active', () => {
    const server = Object.create(WSServer.prototype) as any;
    server.digitalRadioEngine = {
      getCurrentSlotInfo: vi.fn(() => null),
    };
    const connection = {
      send: vi.fn(),
    };

    (server as any).sendCurrentSlotSnapshot(connection);

    expect(connection.send).not.toHaveBeenCalled();
  });


  it('broadcasts a current slot snapshot after modeChanged', () => {
    const slotInfo = {
      id: 'FT4-84-630000',
      startMs: 630000,
      phaseMs: 2500,
      driftMs: 0,
      cycleNumber: 84,
      utcSeconds: 630,
      mode: 'FT4',
    };
    const server = Object.create(WSServer.prototype) as any;
    server.digitalRadioEngine = {
      getCurrentSlotInfo: vi.fn(() => slotInfo),
    };
    server.broadcastSlotStart = vi.fn();

    (server as any).broadcastCurrentSlotSnapshot();

    expect(server.broadcastSlotStart).toHaveBeenCalledWith(slotInfo);
  });
});

describe('WSServer spectrum subscriptions', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects non-null spectrum subscriptions before handshake', async () => {
    const send = vi.fn();
    const setConnectionSubscription = vi.fn();
    const server = Object.create(WSServer.prototype) as any;
    server.getConnection = vi.fn(() => ({
      isHandshakeCompleted: () => false,
      hasMinRole: () => false,
      getSpectrumSubscription: () => null,
      send,
    }));
    server.spectrumCoordinator = {
      setConnectionSubscription,
      getCapabilities: vi.fn(),
    };

    await (server as any).handleSubscribeSpectrum('conn-1', { kind: 'audio' });

    expect(setConnectionSubscription).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(WSMessageType.SPECTRUM_SUBSCRIPTION_CHANGED, {
      requestedKind: 'audio',
      effectiveKind: null,
      ok: false,
      reason: 'not_authenticated_or_handshake_pending',
    });
  });

  it('acks capability timeout without creating a half subscription', async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const setConnectionSubscription = vi.fn();
    const server = Object.create(WSServer.prototype) as any;
    server.getConnection = vi.fn(() => ({
      isHandshakeCompleted: () => true,
      hasMinRole: () => true,
      getSpectrumSubscription: () => null,
      send,
    }));
    server.spectrumCoordinator = {
      setConnectionSubscription,
      getCapabilities: vi.fn(() => new Promise(() => {})),
    };

    const pending = (server as any).handleSubscribeSpectrum('conn-1', { kind: 'audio' });
    await vi.advanceTimersByTimeAsync(3000);
    await pending;

    expect(setConnectionSubscription).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(WSMessageType.SPECTRUM_SUBSCRIPTION_CHANGED, {
      requestedKind: 'audio',
      effectiveKind: null,
      ok: false,
      reason: 'capabilities_timeout',
    });
  });
});
