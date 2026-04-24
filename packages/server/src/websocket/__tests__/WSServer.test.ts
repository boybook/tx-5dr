import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemStatus } from '@tx5dr/contracts';
import { WSServer } from '../WSServer.js';
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
