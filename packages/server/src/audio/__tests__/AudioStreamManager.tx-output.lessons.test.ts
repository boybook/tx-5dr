// Characterization tests for lessons TX-36 and TX-38
// (docs/proposals/plugin-kernel/ft8-lessons.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { performance } from 'node:perf_hooks';

const { mockConfigManager, MockRtAudio } = vi.hoisted(() => {
  class HoistedMockRtAudio {
    constructor(_api: number) {}
    getDevices() { return []; }
    getDefaultInputDevice() { return 0; }
    getDefaultOutputDevice() { return 0; }
    openStream() {}
    start() {}
    stop() {}
    closeStream() {}
  }
  return {
    mockConfigManager: {
      getAudioConfig: vi.fn(),
      getOpenWebRXStations: vi.fn((): Array<{ id: string; name: string; url: string }> => []),
      getRadioConfig: vi.fn((): Record<string, unknown> => ({ type: 'icom-wlan' })),
    },
    MockRtAudio: HoistedMockRtAudio,
  };
});

vi.mock('audify', () => ({ default: { RtAudio: MockRtAudio } }));

vi.mock('../../config/config-manager.js', () => ({
  ConfigManager: { getInstance: () => mockConfigManager },
}));

vi.mock('../../utils/audioUtils.js', () => ({
  clearResamplerCache: vi.fn(),
  resampleAudioProfessional: vi.fn(async (samples: Float32Array) => samples),
}));

import { AudioStreamManager } from '../AudioStreamManager.js';
import { DigitalFrameCoordinator } from '../../transmission/DigitalFrameCoordinator.js';
import { OperatorIntentCoordinator } from '../../transmission/OperatorIntentCoordinator.js';
import { PhysicalTxCoordinator } from '../../transmission/PhysicalTxCoordinator.js';
import { TransmissionPipeline } from '../../subsystems/TransmissionPipeline.js';

const ATTACK_SAMPLES_AT_12K = 120; // 10 ms raised cosine

function createIcomManager(adapter: { sendAudio: ReturnType<typeof vi.fn>; getSampleRate: ReturnType<typeof vi.fn> }) {
  const manager = new AudioStreamManager();
  manager.setIcomWlanAudioAdapter(adapter as never);
  Object.assign(manager, { usingIcomWlanOutput: true, isOutputting: true });
  return manager;
}

function createTciManager() {
  const adapter = {
    sendAudio: vi.fn().mockResolvedValue(undefined),
    getSampleRate: vi.fn().mockReturnValue(12_000),
    beginTransmission: vi.fn().mockResolvedValue(undefined),
    drainTransmission: vi.fn().mockResolvedValue(undefined),
    endTransmission: vi.fn().mockResolvedValue(undefined),
    getTxAudioSyncSnapshot: vi.fn().mockReturnValue({
      samplesPerFrame: 512,
      targetLeadMs: 150,
      recommendedPumpIntervalMs: 8,
      sampleRate: 12_000,
      queuedSamples: 0,
      queuedAudioMs: 0,
    }),
  };
  const manager = new AudioStreamManager();
  manager.setTciAudioAdapter(adapter as never);
  Object.assign(manager, { usingTciOutput: true, isOutputting: true });
  return { manager, written: () => concat(adapter.sendAudio.mock.calls.map((call) => call[0] as Float32Array)) };
}

function createAndroidManager() {
  const write = vi.fn(async (_samples: Float32Array, _gain: number) => true);
  const manager = new AudioStreamManager();
  Object.assign(manager, {
    usingAndroidOutput: true,
    isOutputting: true,
    androidAudioOutput: { write },
    outputSampleRate: 12_000,
    outputBufferSize: 1_024,
  });
  return { manager, written: () => concat(write.mock.calls.map((call) => call[0])) };
}

function concat(chunks: Float32Array[]): Float32Array {
  const output = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

describe('FT8/FT4 envelope on TCI and Android outputs (TX-36)', () => {
  beforeEach(() => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'Radio Audio',
      outputDeviceName: 'Radio Audio',
      sampleRate: 12_000,
      bufferSize: 1_024,
    });
    mockConfigManager.getRadioConfig.mockReturnValue({ type: 'tci', tci: { audioEnabled: true, audioSampleRate: 12_000 } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const outputs = [
    ['TCI', createTciManager],
    ['Android', createAndroidManager],
  ] as const;

  it.each(outputs)('applies the explicit ft8-ft4 attack and release on the %s output path', async (_label, create) => {
    const { manager, written } = create();
    manager.setVolumeGain(1);

    await manager.playAudio(new Float32Array(2_400).fill(0.5), 12_000, {
      playbackKind: 'digital',
      txEnvelopeProfile: 'ft8-ft4',
    });

    const samples = written();
    expect(samples).toHaveLength(2_400);
    expect(samples[0]).toBeCloseTo(0);
    expect(samples[ATTACK_SAMPLES_AT_12K / 2]!).toBeGreaterThan(0.1);
    expect(samples[ATTACK_SAMPLES_AT_12K / 2]!).toBeLessThan(0.4);
    expect(samples[ATTACK_SAMPLES_AT_12K + 10]).toBeCloseTo(0.5);
    expect(samples[1_200]).toBeCloseTo(0.5);
    expect(samples[samples.length - 1]).toBeCloseTo(0);
  });

  it.each(outputs)('does not infer the envelope from the playback kind on the %s output path', async (_label, create) => {
    const { manager, written } = create();
    manager.setVolumeGain(1);

    await manager.playAudio(new Float32Array(2_400).fill(0.5), 12_000, { playbackKind: 'digital' });

    const samples = written();
    expect(samples[0]).toBeCloseTo(0.5);
    expect(samples[samples.length - 1]).toBeCloseTo(0.5);
  });
});

describe('ICOM WLAN transmit release (TX-38, owner decision: intentionally unified)', () => {
  beforeEach(() => {
    mockConfigManager.getAudioConfig.mockReturnValue({
      inputDeviceName: 'ICOM WLAN',
      outputDeviceName: 'ICOM WLAN',
      sampleRate: 48_000,
      bufferSize: 1_024,
    });
    mockConfigManager.getRadioConfig.mockReturnValue({ type: 'icom-wlan' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_000_000);
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // b72b6095 once released ICOM PTT immediately after the last paced write and
  // skipped the tail hold; beab34e2 unified the transmit lifecycle. The owner
  // confirmed the unified behaviour is intended: ICOM waits for the audio the
  // radio has already buffered, then the shared 500 ms digital tail hold.
  it('ICOM uses the unified drain and tail hold: PTT drops only after buffered audio plays out plus 500 ms', async () => {
    const sendTimes: number[] = [];
    const adapter = {
      sendAudio: vi.fn(async () => { sendTimes.push(Date.now()); }),
      getSampleRate: vi.fn().mockReturnValue(12_000),
    };
    const manager = createIcomManager(adapter);
    let playbackSettledAt: number | null = null;
    let pttOffAt: number | null = null;
    const phases: string[] = [];
    const setPTT = vi.fn(async (active: boolean) => {
      if (!active) pttOffAt = Date.now();
    });
    const physicalTxCoordinator = new PhysicalTxCoordinator({
      isRadioConnected: () => true,
      setPTT,
      playAudio: (audioData, sampleRate, options) => manager.playAudio(audioData, sampleRate, options)
        .finally(() => { playbackSettledAt = Date.now(); }),
      stopCurrentPlayback: (options) => manager.stopCurrentPlayback(options),
      prepareAudioPlayback: (kind) => manager.prepareAudioPlayback(kind),
      getAudioPlaybackReadiness: (kind) => manager.getAudioPlaybackReadiness(kind),
      isAudioPlaying: (kind) => manager.isPlaying(kind),
      now: () => Date.now(),
    });
    physicalTxCoordinator.on('phaseChanged', (snapshot) => phases.push(snapshot.phase));

    const digitalFrameCoordinator = new DigitalFrameCoordinator({ now: () => Date.now() });
    const prepared = digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-990000',
      intents: [{ operatorId: 'operator-a', source: 'standard-qso', reason: 'test', text: 'A B 73', decisionEpoch: 1 }],
    });
    const frame = prepared.frame!;
    digitalFrameCoordinator.beginEncoding(frame.frameId);
    digitalFrameCoordinator.acceptEncodeResult({
      frameId: frame.frameId,
      operatorId: 'operator-a',
      decisionEpoch: prepared.intents[0]!.decisionEpoch,
      revision: frame.revision,
    });
    const mixed = {
      operatorIds: ['operator-a'],
      trackIds: ['operator-a\u0000default'],
      audioData: new Float32Array(12_000), // 1 s at the ICOM native rate
      sampleRate: 12_000,
      duration: 1,
      playbackOffsetMs: 0,
      txDialShiftHz: 0,
      frameId: frame.frameId,
      frameRevision: frame.revision,
      slotId: frame.slotId,
    };
    const audioMixer = Object.assign(new EventEmitter(), {
      mixFrameById: vi.fn(async () => mixed),
      retainFrame: vi.fn(),
      releaseFrame: vi.fn(),
      clearFrame: vi.fn(),
      clearSlotCache: vi.fn(),
    });
    const pipeline = new TransmissionPipeline({
      engineEmitter: new EventEmitter(),
      audioMixer,
      audioStreamManager: manager,
      spectrumScheduler: { setPTTActive: vi.fn() },
      encodeQueue: new EventEmitter(),
      operatorManager: {
        deferPreparedFrameToNextSlot: vi.fn(),
        notifyPhysicalTransmissionComplete: vi.fn(),
        getTransmissionFactContext: vi.fn(() => null),
        requeuePhysicalFrameAfterOutputFailure: vi.fn(() => []),
      },
      digitalFrameCoordinator,
      physicalTxCoordinator,
      intentCoordinator: new OperatorIntentCoordinator(),
      clockSource: { now: () => Date.now() },
      getCurrentMode: () => ({ name: 'FT8', slotMs: 15_000, transmitTiming: 500 }),
      getCompensationMs: () => 0,
    } as never);
    pipeline.setup();

    const handling = (pipeline as any).handleMixedAudioReady(mixed) as Promise<void>;
    for (let step = 0; step < 400 && pttOffAt === null; step += 1) {
      await vi.advanceTimersByTimeAsync(5);
    }
    await handling;

    expect(setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(adapter.sendAudio).toHaveBeenCalledTimes(10);
    const firstSendAt = sendTimes[0]!;
    const lastSendAt = sendTimes.at(-1)!;
    // Pacing keeps ~150 ms of lead, so the last write leaves audio buffered in the radio.
    expect(lastSendAt - firstSendAt).toBeLessThan(900);
    // Playback is reported complete only after that buffered audio has played out.
    expect(playbackSettledAt! - lastSendAt).toBeGreaterThanOrEqual(140);
    expect(playbackSettledAt! - firstSendAt).toBeGreaterThanOrEqual(990);
    // Then the same 500 ms tail hold as every other digital output.
    expect(pttOffAt! - playbackSettledAt!).toBeGreaterThanOrEqual(500);
    expect(pttOffAt! - playbackSettledAt!).toBeLessThan(600);
    expect(phases).toContain('draining');
    expect(digitalFrameCoordinator.getFrame(frame.frameId)?.phase).toBe('terminal');
    pipeline.teardown();
  });
});
