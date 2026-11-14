import { EventEmitter } from 'eventemitter3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { StationTestRunSchema } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { assertRadioExecution, prepareRadioTransmission } from '../radio/RadioExecutionPolicy.js';
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { PhysicalTxCoordinator } from '../transmission/PhysicalTxCoordinator.js';
import { StationTestRuntime } from './StationTestRuntime.js';

vi.mock('../simulation/PeerSession.js', () => ({ PeerSession: class {
  observe = vi.fn(); start = vi.fn(async () => {}); stop = vi.fn(async () => {});
  render = () => new Float32Array(0); getTracePath = () => '/tmp/peer.jsonl';
} }));
vi.mock('../simulation/RttyPeerSession.js', () => ({ RttyPeerSession: class {
  observe = vi.fn(); start = vi.fn(async () => {}); stop = vi.fn(async () => {});
  render = () => new Float32Array(0); getTracePath = () => '/tmp/peer.jsonl';
} }));

const target = { type: 'serial' as const, serial: { path: '/dev/null', rigModel: 1 }, pttMethod: 'cat' as const };
let close: () => Promise<void>;
let frequency = 14074000;
let power = 0.05;
let generation = 1;
let definition: object;
let radioMode: string;
let softwareMode: string;
let forceStop = vi.fn(async () => {});
let handlers: Record<string, (request: { body: unknown }) => Promise<unknown>>;

beforeEach(() => { vi.useFakeTimers(); frequency = 14074000; power = 0.05; generation = 1; definition = {}; radioMode = 'USB'; softwareMode = 'FT8'; handlers = {}; });
afterEach(async () => { await close?.(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture(mode: 'FT8' | 'RTTY' = 'FT8') {
  softwareMode = mode;
  vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
    getActiveProfileId: () => 'rig', getRadioConfig: () => target,
    getPSKReporterConfig: () => ({ enabled: false }), getRigctldConfig: () => ({ enabled: false }),
  } as unknown as ConfigManager);
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  const radio = Object.assign(new EventEmitter(), { isConnected: () => true, getConnectionGeneration: () => generation, getKnownFrequency: () => frequency,
    getMode: vi.fn(async () => ({ mode: radioMode, bandwidth: 3000 })),
    getCapabilityState: () => ({ supported: true }), getCurrentConnection: () => ({ getRFPower: async () => power }) });
  const audio = Object.assign(new EventEmitter(), { getAudioPlaybackReadiness: () => ({ ready: true }), setBasebandContribution: vi.fn() });
  forceStop = vi.fn(async () => {});
  const engine = { getClockSource: () => ({ now: Date.now }), getRadioManager: () => radio,
    getCurrentMode: () => ({ name: softwareMode }), getAudioStreamManager: () => audio,
    forceStopTransmission: forceStop, stop: vi.fn(async () => {}),
    pluginManager: { getSimulationScenarios: () => [], getLoadedPlugin: () => ({ definition }) },
  } as unknown as DigitalRadioEngine;
  const server = { get: (route: string, _options: unknown, handler: typeof handlers[string]) => { handlers[route] = handler; },
    post: (route: string, _options: unknown, handler: typeof handlers[string]) => { handlers[route] = handler; },
    addHook: (_name: string, handler: () => Promise<void>) => { close = handler; },
  } as unknown as FastifyInstance;
  const runtime = new StationTestRuntime(StationTestRunSchema.parse({ version: 1, hardware: true, profileId: 'rig', mode,
    dialFrequencyHz: frequency, scenarioProvider: 'provider', seed: 'safety', artifactDir: '/tmp', maxDurationMs: 2000,
    peers: [{ id: 'remote', callsign: 'JA1AAA', grid: 'PM95', scenarioId: mode === 'RTTY' ? 'rtty-answering' : 'standard',
      audioFrequencyHz: mode === 'RTTY' ? 2210 : 1500 }] }));
  await runtime.attach(engine, server);
  const arm = () => handlers['/api/station-test/arm']!({ body: { sessionId: runtime.sessionId, dummyLoadInstalled: true, minimumPowerSetManually: true } });
  return { runtime, arm, radio };
}

describe('hardware test permission', () => {
  it('defaults to denied for every RF source, including self-keyed CW', async () => {
    await fixture();
    for (const source of ['digital', 'ptt', 'test', 'cw', 'tuner', 'cw-keyer-test', 'manual']) {
      expect(() => assertRadioExecution({ kind: 'transmit', source })).toThrow();
    }
  });
  it('allows scoped digital output only after exact manual acknowledgements', async () => {
    const { runtime, arm } = await fixture();
    await expect(handlers['/api/station-test/arm']!({ body: { sessionId: runtime.sessionId, dummyLoadInstalled: true } })).rejects.toThrow();
    await arm();
    await expect(prepareRadioTransmission('digital')).resolves.toBeUndefined();
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'digital' })).not.toThrow();
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'cw' })).toThrow();
    expect(runtime.status().powerEvidence).toBe('readback');
    expect(() => assertRadioExecution({ kind: 'capability-write', id: 'rf_power' })).toThrow();
    expect(() => assertRadioExecution({ kind: 'power' })).toThrow();
    expect(() => assertRadioExecution({ kind: 'connect', config: { type: 'none' } })).toThrow();
  });
  it('revokes on operating context change before another physical operation', async () => {
    const { runtime, arm } = await fixture(); await arm(); frequency = 7074000;
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'ptt' })).toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.status().phase).toBe('failed'); expect(forceStop).toHaveBeenCalled();
  });
  it('expires without restoring permission on reconnect', async () => {
    const { runtime, arm } = await fixture(); await arm(); await vi.advanceTimersByTimeAsync(2000);
    expect(runtime.status().phase).toBe('failed');
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'ptt' })).toThrow();
  });
  it('cannot reuse a grant for a new connection at the same frequency', async () => {
    const { runtime, arm, radio } = await fixture(); await arm(); generation = 2;
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'digital' })).toThrow();
    radio.emit('connected'); await runtime.stop('cleanup');
    expect(runtime.status().error).toContain('generation changed');
  });
  it('records unsupported power readback as manual confirmation', async () => {
    const { runtime, arm, radio } = await fixture();
    vi.spyOn(radio, 'getCapabilityState').mockReturnValue({ supported: false });
    await arm(); expect(runtime.status().powerEvidence).toBe('manual-confirmation');
    expect(() => assertRadioExecution({ kind: 'capability-write', id: 'rf_power' })).toThrow();
  });
  it('revokes permission when the owning CLI pipe ends', async () => {
    const { runtime, arm } = await fixture(); await arm(); process.stdin.emit('end');
    await runtime.stop('cleanup');
    expect(runtime.status().error).toContain('owner disconnected');
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'digital' })).toThrow();
  });
  it('stops if manually set power changes', async () => {
    const { runtime, arm } = await fixture(); await arm(); power = 0.25;
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.status().error).toContain('RF power changed'); expect(forceStop).toHaveBeenCalled();
  });
  it('stops when the frozen scenario provider is replaced', async () => {
    const { runtime, arm } = await fixture(); await arm(); definition = {};
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'digital' })).toThrow();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.status().phase).toBe('failed');
  });
  it('stops on controller loss and makes stop idempotent', async () => {
    const { runtime, arm, radio } = await fixture(); await arm();
    await vi.advanceTimersByTimeAsync(100); radio.emit('disconnected');
    await runtime.stop('cleanup'); await runtime.stop('again');
    expect(runtime.status().phase).toBe('failed'); expect(forceStop).toHaveBeenCalledOnce();
  });

  it('rejects a physical lease before PTT when the CAT mode changes while software stays on FT8', async () => {
    const { runtime, arm } = await fixture();
    await arm();
    const setPTT = vi.fn(async () => {});
    const transmitter = new PhysicalTxCoordinator({ isRadioConnected: () => true, setPTT,
      playAudio: async () => {}, stopCurrentPlayback: async () => 0 });
    radioMode = 'LSB';
    await expect(transmitter.acquireLease({ source: 'digital', reason: 'mode regression' })).rejects.toThrow('radio mode changed');
    expect(setPTT).not.toHaveBeenCalled();
    expect(transmitter.getSnapshot().phase).toBe('idle');
    expect(runtime.status().phase).toBe('failed');
    expect(forceStop).toHaveBeenCalledOnce();
  });

  it('checks CAT mode at the PTT owner too and always allows PTT release after revocation', async () => {
    const { arm } = await fixture();
    await arm();
    const manager = new PhysicalRadioManager();
    const setPTT = vi.fn(async () => {});
    (manager as unknown as { connection: unknown }).connection = { setPTT };
    await expect(manager.setPTT(true)).resolves.toBeUndefined();
    radioMode = 'LSB';
    await expect(manager.setPTT(true)).rejects.toThrow('radio mode changed');
    await expect(manager.setPTT(false)).resolves.toBeUndefined();
    expect(setPTT.mock.calls).toEqual([[true], [false]]);
  });

  it('monitors the actual mode during an armed transmission even without another TX request', async () => {
    const { runtime, arm } = await fixture();
    await arm(); radioMode = 'LSB';
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.status().error).toContain('radio mode changed');
    expect(forceStop).toHaveBeenCalledOnce();
  });

  it('revokes immediately on a mode capability change, including a change back before the next poll', async () => {
    const { runtime, arm, radio } = await fixture();
    await arm();
    radio.emit('capabilityChanged', { id: 'radio_mode', supported: true, value: 'LSB' });
    radio.emit('capabilityChanged', { id: 'radio_mode', supported: true, value: 'USB' });
    expect(runtime.status().phase).toBe('failed');
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'ptt' })).toThrow();
  });

  it.each(['direct', 'compound'] as const)('revokes before a %s mode write can reach the connection', async kind => {
    const { runtime, arm } = await fixture();
    await arm();
    const manager = new PhysicalRadioManager();
    const setMode = vi.fn(), applyOperatingState = vi.fn();
    (manager as unknown as { connection: unknown }).connection = { setMode, applyOperatingState };
    await expect(kind === 'direct' ? manager.setMode('LSB') : manager.applyOperatingState({ mode: 'LSB' })).rejects.toThrow('mode writes invalidate');
    expect(setMode).not.toHaveBeenCalled(); expect(applyOperatingState).not.toHaveBeenCalled();
    expect(runtime.status().phase).toBe('failed');
  });

  it.each(['unavailable', 'unknown'] as const)('does not grant permission with %s CAT mode readback', async kind => {
    const { runtime, arm, radio } = await fixture();
    if (kind === 'unavailable') radio.getMode.mockRejectedValue(new Error('CAT mode read failed'));
    else radioMode = 'UNKNOWN';
    await expect(arm()).rejects.toThrow();
    expect(runtime.status().expiresAt).toBeNull();
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'digital' })).toThrow();
  });

  it('rejects a mode change while the administrator grant is being prepared', async () => {
    const { runtime, arm, radio } = await fixture();
    radio.getMode.mockResolvedValueOnce({ mode: 'USB', bandwidth: 3000 }).mockResolvedValueOnce({ mode: 'LSB', bandwidth: 3000 });
    await expect(arm()).rejects.toThrow('context changed while arming');
    expect(runtime.status().expiresAt).toBeNull();
  });

  it('rejects overlapping grants and cannot arm after stop while CAT readback is pending', async () => {
    const { runtime, arm, radio } = await fixture();
    let finish!: (value: { mode: string; bandwidth: number }) => void;
    radio.getMode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = expect(arm()).rejects.toThrow('context changed while arming');
    await expect(arm()).rejects.toThrow('not ready');
    await runtime.stop('administrator cancelled');
    finish({ mode: 'USB', bandwidth: 3000 });
    await pending;
    expect(runtime.status().phase).toBe('stopped');
    expect(runtime.status().expiresAt).toBeNull();
  });

  it('revokes when mode readback fails after arming', async () => {
    const { runtime, arm, radio } = await fixture();
    await arm();
    radio.getMode.mockRejectedValue(new Error('CAT mode read failed'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.status().phase).toBe('failed');
    expect(forceStop).toHaveBeenCalledOnce();
  });

  it.each(['reconnect', 'stop', 'expiry'] as const)('isolates delayed mode readback after %s', async action => {
    const { runtime, arm, radio } = await fixture();
    await arm();
    let finish!: (value: { mode: string; bandwidth: number }) => void;
    radio.getMode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = prepareRadioTransmission('digital');
    const denied = expect(pending).rejects.toThrow('permission changed');
    if (action === 'reconnect') generation++;
    else if (action === 'stop') await runtime.stop('cancelled during mode readback');
    else await vi.advanceTimersByTimeAsync(2000);
    finish({ mode: 'USB', bandwidth: 3000 });
    await denied;
    expect(runtime.status().phase).toBe(action === 'stop' ? 'stopped' : 'failed');
  });
});

/** A real lease owner whose PTT goes through the real radio owner, as in DigitalRadioEngine. */
function physicalTransmitter() {
  const manager = new PhysicalRadioManager();
  const setPTT = vi.fn(async (_active: boolean) => {});
  (manager as unknown as { connection: unknown }).connection = { setPTT };
  const transmitter = new PhysicalTxCoordinator({ isRadioConnected: () => true, setPTT: active => manager.setPTT(active),
    playAudio: async () => {}, stopCurrentPlayback: async () => 0 });
  return { manager, setPTT, transmitter };
}

describe('RTTY hardware test permission', () => {
  const rfSources = ['rtty', 'digital', 'ptt', 'test', 'voice', 'voice-keyer', 'cw', 'sstv', 'tune-tone', 'manual', 'tuner', 'cw-keyer-test'];
  // The runner's RTTY dial; Hamlib reports the IC-705 LSB data mode as PKTLSB; the operator sets 0% power.
  beforeEach(() => { frequency = 14080000; radioMode = 'PKTLSB'; power = 0; });

  it('denies every RF source before ARM, including rtty', async () => {
    const { runtime } = await fixture('RTTY');
    expect(runtime.status().phase).toBe('ready');
    for (const source of rfSources) expect(() => assertRadioExecution({ kind: 'transmit', source })).toThrow();
    const { transmitter, setPTT } = physicalTransmitter();
    await expect(transmitter.acquireLease({ source: 'rtty', reason: 'before ARM' })).rejects.toThrow('not authorized');
    await expect(transmitter.acquireLease({ source: 'digital', reason: 'before ARM' })).rejects.toThrow('only permits RTTY');
    expect(setPTT).not.toHaveBeenCalled();
  });

  it('after ARM keys an rtty lease and its PTT on the LSB data mode, with readback before each, and releases it', async () => {
    const { runtime, arm, radio } = await fixture('RTTY');
    await arm();
    expect(runtime.status()).toMatchObject({ phase: 'armed', powerEvidence: 'readback' });
    expect(radio.getMode).toHaveBeenCalledTimes(2);
    const { transmitter, setPTT } = physicalTransmitter();
    const leaseId = await transmitter.acquireLease({ source: 'rtty', reason: 'RTTY transmission', operatorIds: ['station-operator'] });
    // One CAT mode readback for the lease owner and one for the PTT owner.
    expect(radio.getMode).toHaveBeenCalledTimes(4);
    expect(setPTT.mock.calls).toEqual([[true]]);
    await expect(transmitter.releaseLease(leaseId, 'RTTY transmission completed')).resolves.toMatchObject({ success: true });
    expect(setPTT.mock.calls).toEqual([[true], [false]]);
    expect(runtime.status().phase).toBe('armed');
  });

  it.each(['digital', 'voice', 'voice-keyer', 'cw', 'sstv', 'tune-tone', 'manual'])('after ARM still denies a %s lease before PTT', async source => {
    const { runtime, arm } = await fixture('RTTY');
    await arm();
    const { transmitter, setPTT } = physicalTransmitter();
    await expect(transmitter.acquireLease({ source: source as 'digital', reason: 'out of scope' })).rejects.toThrow('only permits RTTY');
    expect(setPTT).not.toHaveBeenCalled();
    expect(transmitter.getSnapshot().phase).toBe('idle');
    expect(runtime.status().phase).toBe('armed');
  });

  it('after ARM still denies the tuner and CW keyer test sources', async () => {
    const { arm } = await fixture('RTTY');
    await arm();
    for (const source of ['tuner', 'cw-keyer-test']) expect(() => assertRadioExecution({ kind: 'transmit', source })).toThrow('only permits RTTY');
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'rtty' })).not.toThrow();
  });

  it.each(['direct', 'compound'] as const)('revokes before a %s RTTY data-mode write reaches the radio after ARM', async kind => {
    const { runtime, arm } = await fixture('RTTY');
    await arm();
    const manager = new PhysicalRadioManager();
    const setMode = vi.fn(), applyOperatingState = vi.fn();
    (manager as unknown as { connection: unknown }).connection = { setMode, applyOperatingState };
    const write = kind === 'direct'
      ? manager.setMode('LSB', undefined, { intent: 'digital' })
      : manager.applyOperatingState({ frequency: 14080000, mode: 'LSB', bandwidth: 'nochange', options: { intent: 'digital' }, tolerateModeFailure: true });
    await expect(write).rejects.toThrow('mode writes invalidate');
    expect(setMode).not.toHaveBeenCalled(); expect(applyOperatingState).not.toHaveBeenCalled();
    expect(runtime.status().phase).toBe('failed');
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'rtty' })).toThrow();
  });

  it('rejects RF and physical power changes before and after ARM without reaching the radio', async () => {
    const { arm } = await fixture('RTTY');
    expect(() => assertRadioExecution({ kind: 'capability-write', id: 'rf_power' })).toThrow('prohibited');
    await arm();
    const manager = new PhysicalRadioManager();
    const setRFPower = vi.fn();
    (manager as unknown as { connection: unknown }).connection = { setRFPower };
    await expect(manager.writeCapability('rf_power', 0.5)).rejects.toThrow('prohibited');
    await expect(manager.writeCapabilityGroup('power', { rf_power: 0.5 }, 'session')).rejects.toThrow('prohibited');
    const task = vi.fn(async () => {});
    await expect(manager.withPowerOperation('power off', task)).rejects.toThrow('prohibited');
    expect(task).not.toHaveBeenCalled(); expect(setRFPower).not.toHaveBeenCalled();
  });

  it.each(['cat-mode', 'power', 'owner-pipe', 'expiry', 'software-mode', 'dial'] as const)(
    'revokes an armed RTTY transmission on %s change, still releases PTT, and denies the next lease',
    async change => {
      const { runtime, arm } = await fixture('RTTY');
      await arm();
      const { transmitter, setPTT } = physicalTransmitter();
      const leaseId = await transmitter.acquireLease({ source: 'rtty', reason: 'RTTY transmission' });
      if (change === 'cat-mode') { radioMode = 'LSB'; await vi.advanceTimersByTimeAsync(1000); }
      else if (change === 'power') { power = 0.1; await vi.advanceTimersByTimeAsync(1000); }
      else if (change === 'owner-pipe') process.stdin.emit('end');
      else if (change === 'expiry') await vi.advanceTimersByTimeAsync(2000);
      else if (change === 'software-mode') { softwareMode = 'FT8'; await vi.advanceTimersByTimeAsync(100); }
      else { frequency = 14080100; await vi.advanceTimersByTimeAsync(100); }
      expect(runtime.status().phase).toBe('failed');
      expect(forceStop).toHaveBeenCalledOnce();
      // PTT release is never gated by the revoked permission.
      await expect(transmitter.releaseLease(leaseId, 'revoked')).resolves.toMatchObject({ success: true });
      expect(setPTT.mock.calls).toEqual([[true], [false]]);
      await expect(transmitter.acquireLease({ source: 'rtty', reason: 'after revocation' })).rejects.toThrow();
      expect(setPTT.mock.calls).toHaveLength(2);
    },
  );
});

describe('FT8 hardware test permission scope', () => {
  it('still rejects the rtty source after ARM while digital remains permitted', async () => {
    const { runtime, arm } = await fixture('FT8');
    await arm();
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'rtty' })).toThrow('only permits FT8');
    const { transmitter, setPTT } = physicalTransmitter();
    await expect(transmitter.acquireLease({ source: 'rtty', reason: 'out of scope' })).rejects.toThrow('only permits FT8');
    expect(setPTT).not.toHaveBeenCalled();
    expect(runtime.status().phase).toBe('armed');
    expect(() => assertRadioExecution({ kind: 'transmit', source: 'digital' })).not.toThrow();
  });
});
