import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { DeviceUiProjectionService } from '../DeviceUiProjectionService.js';

const ft8Mode = { name: 'FT8', slotMs: 15_000, transmitTiming: 500 } as any;
const lanAccess = { webPort: 8076, hostname: 'tx5dr', networkInterfaces: { eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }] as any[] } };

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
    const service = new DeviceUiProjectionService(createEngine(), { version: 'test-version', stationCallsign: 'BG5DRB', now: () => 123, networkAccess: lanAccess });

    expect(service.getSnapshot()).toMatchObject({
      server: { status: 'ok', version: 'test-version', webPort: 8076 },
      station: { callsign: 'BG5DRB' },
      engine: { running: true, mode: 'digital', currentMode: { name: 'FT8', slotMs: 15_000 }, state: 'running' },
      radio: { connected: true, frequency: 14_074_000, radioMode: 'USB-D', ptt: false, tx: false },
      ft8: { slot: null, utc: null, cycle: null, periodMs: 15_000, recentDecodeRawMessages: [] },
      cw: {
        decoder: {
          enabled: false,
          active: false,
          state: 'disabled',
          muted: false,
          pendingText: '',
          committedText: '',
          lastDecodeAt: null,
        },
        keyer: {
          active: false,
          mode: null,
          messageId: null,
          currentText: null,
          lastText: null,
        },
        currentTx: {
          active: false,
          messages: [],
          lastMessage: null,
        },
      },
      access: { localUrl: 'http://192.168.1.10:8076', localUrls: ['http://192.168.1.10:8076'] },
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
    const service = new DeviceUiProjectionService(engine, { now: () => 10, networkAccess: { webPort: 8076, hostname: 'tx5dr', networkInterfaces: {} } });

    expect(() => service.getSnapshot()).not.toThrow();
    expect(service.getSnapshot()).toMatchObject({
      engine: { running: false, mode: null, currentMode: null },
      radio: { connected: false, frequency: null, radioMode: null, ptt: false, tx: false },
      ft8: { lastDecodeRawMessage: 'CQ TEST AA00' },
      access: { localUrl: null, localUrls: [] },
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

  it('projects CW decoder transcript and keyer TX state', () => {
    const engine = createEngine({
      getStatus: vi.fn(() => ({
        isRunning: true,
        engineMode: 'cw',
        currentMode: { name: 'CW' },
        radioConnected: true,
        currentRadioMode: 'CW',
        engineState: 'running',
      })),
    });
    const service = new DeviceUiProjectionService(engine, { now: () => 200 });

    expect(service.getSnapshot().cw.decoder).toMatchObject({
      enabled: false,
      active: false,
      state: 'disabled',
      pendingText: '',
      committedText: '',
    });

    engine.emit('cwDecoderStatusChanged', {
      enabled: true,
      active: true,
      state: 'listening',
      muted: false,
      pendingText: 'TES',
      committedText: 'CQ CQ',
      lastDecodeAt: 180,
      updatedAt: 181,
    });
    engine.emit('cwDecoderEvent', {
      kind: 'transcript_pending',
      pending: {
        sessionId: 'cw-1',
        version: 1,
        text: 'TEST',
        finalized: false,
        updatedAt: 190,
      },
      timestamp: 190,
    });
    engine.emit('cwDecoderEvent', {
      kind: 'commit',
      segment: {
        id: 'seg-1',
        sessionId: 'cw-1',
        sequence: 1,
        text: 'TEST',
        finalized: true,
        prependSpace: true,
        updatedAt: 195,
      },
      text: 'TEST',
      timestamp: 195,
    });
    engine.emit('cwDecoderEvent', {
      kind: 'transcript_commit',
      segment: {
        id: 'seg-1',
        sessionId: 'cw-1',
        sequence: 1,
        text: 'TEST',
        finalized: true,
        prependSpace: true,
        updatedAt: 195,
      },
      timestamp: 195,
    });
    engine.emit('cwKeyerStatusChanged', {
      active: true,
      mode: 'playing',
      startedBy: 'client-1',
      startedByLabel: 'Operator',
      messageId: null,
      nextRunAt: null,
      error: null,
      currentText: 'DE BG5DRB K',
      lastText: 'CQ CQ DE BG5DRB K',
    });

    expect(service.getSnapshot()).toMatchObject({
      engine: { mode: 'cw', currentMode: { name: 'CW' } },
      cw: {
        decoder: {
          enabled: true,
          active: true,
          state: 'listening',
          pendingText: '',
          committedText: 'CQ CQ TEST',
          lastDecodeAt: 195,
        },
        keyer: {
          active: true,
          mode: 'playing',
          messageId: null,
          currentText: 'DE BG5DRB K',
          lastText: 'CQ CQ DE BG5DRB K',
        },
        currentTx: {
          active: true,
          messages: ['DE BG5DRB K', 'CQ CQ DE BG5DRB K'],
          lastMessage: 'DE BG5DRB K',
        },
      },
    });

    engine.emit('cwDecoderEvent', {
      kind: 'transcript_reset',
      sessionId: 'cw-1',
      timestamp: 210,
    });

    expect(service.getSnapshot().cw.decoder).toMatchObject({
      pendingText: '',
      committedText: '',
    });

    engine.emit('cwDecoderStatusChanged', {
      enabled: true,
      active: false,
      state: 'disabled',
      muted: false,
      pendingText: 'STALE',
      committedText: 'STALE TEXT',
      lastDecodeAt: 216,
      updatedAt: 217,
    });

    expect(service.getSnapshot().cw.decoder).toMatchObject({
      enabled: false,
      active: false,
      state: 'disabled',
      pendingText: '',
      committedText: '',
      lastDecodeAt: null,
    });

    engine.emit('cwDecoderStatusChanged', {
      enabled: false,
      active: false,
      state: 'disabled',
      muted: false,
      pendingText: 'STALE',
      committedText: 'STALE TEXT',
      lastDecodeAt: 220,
      updatedAt: 221,
    });

    expect(service.getSnapshot().cw.decoder).toMatchObject({
      enabled: false,
      active: false,
      state: 'disabled',
      pendingText: '',
      committedText: '',
      lastDecodeAt: null,
    });
  });

  it('hydrates CW snapshot from existing engine status during bootstrap', () => {
    const engine = createEngine({
      getStatus: vi.fn(() => ({
        isRunning: true,
        engineMode: 'cw',
        currentMode: { name: 'CW' },
        radioConnected: true,
        currentRadioMode: 'CW',
        engineState: 'running',
      })),
      getCWDecoderStatus: vi.fn(() => ({
        enabled: true,
        active: true,
        state: 'decoding',
        muted: false,
        pendingText: 'TES',
        committedText: 'CQ CQ',
        lastDecodeAt: 300,
        updatedAt: 301,
      })),
      getCWKeyerManager: vi.fn(() => ({
        getStatus: vi.fn(() => ({
          active: true,
          mode: 'playing',
          startedBy: 'client-1',
          startedByLabel: 'Operator',
          messageId: null,
          nextRunAt: null,
          error: null,
          currentText: 'DE BG5DRB K',
          lastText: 'CQ CQ DE BG5DRB K',
        })),
      })),
    });
    const service = new DeviceUiProjectionService(engine, { now: () => 400 });

    expect(service.getSnapshot()).toMatchObject({
      engine: { mode: 'cw', currentMode: { name: 'CW' } },
      cw: {
        decoder: {
          enabled: true,
          active: true,
          state: 'decoding',
          pendingText: 'TES',
          committedText: 'CQ CQ',
          lastDecodeAt: 300,
        },
        keyer: {
          active: true,
          mode: 'playing',
          currentText: 'DE BG5DRB K',
          lastText: 'CQ CQ DE BG5DRB K',
        },
        currentTx: {
          active: true,
          messages: ['DE BG5DRB K', 'CQ CQ DE BG5DRB K'],
          lastMessage: 'DE BG5DRB K',
        },
      },
    });

    engine.emit('cwKeyerStatusChanged', {
      active: false,
      mode: 'idle',
      startedBy: null,
      startedByLabel: null,
      messageId: null,
      nextRunAt: null,
      error: null,
      currentText: null,
      lastText: null,
    });

    expect(service.getSnapshot().cw.currentTx).toEqual({
      active: false,
      messages: [],
      lastMessage: null,
    });
  });
});
