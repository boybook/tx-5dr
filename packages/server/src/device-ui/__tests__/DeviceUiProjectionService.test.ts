import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { DeviceUiProjectionService } from '../DeviceUiProjectionService.js';

const ft8Mode = { name: 'FT8', slotMs: 15_000, transmitTiming: 500 } as any;

function createEngine(overrides: Record<string, unknown> = {}): any {
  const emitter = new EventEmitter<any>();
  return Object.assign(emitter, {
    getStatus: vi.fn(() => ({
      isRunning: true,
      engineMode: 'digital',
      currentMode: ft8Mode,
      radioConnected: true,
      currentRadioMode: 'USB-D',
      isPTTActive: false,
      engineState: 'running',
    })),
    getCurrentSlotInfo: vi.fn(() => null),
    getActiveSlotPacks: vi.fn(() => []),
    operatorManager: { getOperatorsStatus: vi.fn(() => []) },
    getRadioManager: vi.fn(() => ({
      isConnected: vi.fn(() => true),
      getKnownFrequency: vi.fn(() => 14_074_000),
    })),
    getVoiceKeyerManager: vi.fn(() => null),
    getVoiceSessionManager: vi.fn(() => null),
    ...overrides,
  });
}

describe('DeviceUiProjectionService', () => {
  it('builds a safe initial snapshot from available engine status', () => {
    const service = new DeviceUiProjectionService(createEngine(), { webPort: 8076, version: 'test-version', stationCallsign: 'BG5DRB', now: () => 123 });

    expect(service.getSnapshot()).toMatchObject({
      server: { status: 'ok', version: 'test-version', webPort: 8076 },
      station: { callsign: 'BG5DRB' },
      engine: { running: true, mode: 'digital', currentMode: { name: 'FT8', slotMs: 15_000 }, state: 'running' },
      radio: { connected: true, frequency: 14_074_000, radioMode: 'USB-D', ptt: false, tx: false },
      ft8: { slot: null, utc: null, cycle: null, periodMs: 15_000, recentDecodeRawMessages: [] },
      access: { localUrl: 'http://localhost:8076' },
      updatedAt: 123,
    });
  });

  it('keeps safe defaults when engine getters throw or return incomplete data', () => {
    const engine = createEngine({
      getStatus: vi.fn(() => { throw new Error('status unavailable'); }),
      getCurrentSlotInfo: vi.fn(() => { throw new Error('slot unavailable'); }),
      getActiveSlotPacks: vi.fn(() => [{ frames: [{ message: 'CQ TEST AA00' }] }]),
      getRadioManager: vi.fn(() => ({
        isConnected: vi.fn(() => { throw new Error('radio unavailable'); }),
        getKnownFrequency: vi.fn(() => undefined),
      })),
    });
    const service = new DeviceUiProjectionService(engine, { webPort: null, now: () => 10 });

    expect(() => service.getSnapshot()).not.toThrow();
    expect(service.getSnapshot()).toMatchObject({
      engine: { running: false, mode: null, currentMode: null },
      radio: { connected: false, frequency: null, radioMode: null, ptt: false, tx: false },
      ft8: { lastDecodeRawMessage: 'CQ TEST AA00' },
      access: { localUrl: null },
    });
  });

  it('updates the in-memory projection from slot, decode, frequency, PTT, and operator events', () => {
    const engine = createEngine();
    const service = new DeviceUiProjectionService(engine, { webPort: 8080, now: () => 1000 });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);

    engine.emit('frequencyChanged', {
      frequency: 7_074_000,
      mode: 'FT8',
      band: '40m',
      description: '40m FT8',
      radioMode: 'USB-D',
      radioConnected: true,
    });
    engine.emit('slotStart', {
      id: 'FT8-1',
      startMs: 15_000,
      phaseMs: 0,
      driftMs: 0,
      cycleNumber: 1,
      utcSeconds: 15,
      mode: 'FT8',
    });
    engine.emit('slotPackUpdated', {
      slotId: 'FT8-1',
      startMs: 15_000,
      endMs: 30_000,
      frames: [{ snr: -10, freq: 1200, dt: 0.2, message: 'CQ DX BG2AAA OM88' }],
      stats: {},
      decodeHistory: [],
      frequencyContext: { frequency: 7_074_000, radioMode: 'USB-D' },
    });
    engine.emit('operatorStatusUpdate', {
      id: 'op1',
      isActive: true,
      isTransmitting: true,
      currentSlot: 'TX1',
      context: { myCall: 'BG2AAA', myGrid: 'OM88', targetCall: 'K1ABC' },
      strategy: { name: 'manual', state: 'tx', availableSlots: ['TX1'] },
      slots: { TX1: 'K1ABC BG2AAA -10' },
    });
    engine.emit('pttStatusChanged', { isTransmitting: true, operatorIds: ['op1'] });

    const snapshot = service.getSnapshot();
    expect(snapshot.radio).toMatchObject({ frequency: 7_074_000, ptt: true, tx: true });
    expect(snapshot.ft8).toMatchObject({
      utc: 15,
      cycle: 1,
      lastDecodeRawMessage: 'CQ DX BG2AAA OM88',
      recentDecodeRawMessages: ['CQ DX BG2AAA OM88'],
      recentFramesSlotId: 'FT8-1',
      recentFramesSlotStartMs: 15_000,
      recentFrames: [{
        slotId: 'FT8-1',
        slotStartMs: 15_000,
        message: 'CQ DX BG2AAA OM88',
        countryZh: '中国·黑龙江',
        countryEn: 'China·Heilongjiang',
      }],
      currentTx: {
        active: true,
        operatorIds: ['op1'],
        messages: ['K1ABC BG2AAA -10'],
        lastMessage: 'K1ABC BG2AAA -10',
      },
    });
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    const calls = listener.mock.calls.length;
    engine.emit('connected');
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('projects voice summary without pairing state', () => {
    const engine = createEngine({
      getStatus: vi.fn(() => ({ isRunning: true, engineMode: 'voice', currentMode: { name: 'VOICE' }, currentRadioMode: 'USB' })),
    });
    const service = new DeviceUiProjectionService(engine, { now: () => 50 });

    engine.emit('voicePttLockChanged', { locked: true, lockedBy: 'client-1', lockedByLabel: 'Operator', lockedAt: 40, timeoutMs: 180_000 });
    engine.emit('voiceKeyerStatusChanged', {
      active: true,
      callsign: 'BG2AAA',
      slotId: 'cq',
      mode: 'playing',
      repeating: false,
      startedBy: 'client-1',
      startedByLabel: 'Operator',
      nextRunAt: null,
      error: null,
    });

    expect(service.getSnapshot().voice).toEqual({
      active: true,
      radioMode: 'USB',
      pttLocked: true,
      pttLockedByLabel: 'Operator',
      keyerActive: true,
      keyerMode: 'playing',
      keyerSlotId: 'cq',
    });
    expect(JSON.stringify(service.getSnapshot())).not.toContain('pair');
  });
});
