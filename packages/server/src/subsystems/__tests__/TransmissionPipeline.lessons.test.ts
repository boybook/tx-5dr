// Characterization tests for the transmit-path lessons in
// docs/proposals/plugin-kernel/ft8-lessons.md (RX-25, TX-10, TX-11, TX-13, TX-15).
// They describe current behaviour and must fail if the lesson is broken.
import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioPlaybackReadiness } from '../../audio/AudioStreamManager.js';
import { AudioMixer } from '../../audio/AudioMixer.js';
import { DigitalFrameCoordinator } from '../../transmission/DigitalFrameCoordinator.js';
import { OperatorIntentCoordinator } from '../../transmission/OperatorIntentCoordinator.js';
import { PhysicalTxCoordinator } from '../../transmission/PhysicalTxCoordinator.js';
import { TransmissionPipeline } from '../TransmissionPipeline.js';

const SLOT_START_MS = 30_000;
const SLOT_ID = `slot-${SLOT_START_MS}`;
const FT8_MODE = {
  name: 'FT8',
  slotMs: 15_000,
  toleranceMs: 100,
  windowTiming: [],
  transmitTiming: 500,
  encodeAdvance: 0,
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Same formula RadioOperatorManager uses for the frame waveform cursor origin
 * (RadioOperatorManager.ts: `slotStartMs + max(0, transmitTiming - compensation)`).
 * That side is pinned by RadioOperatorManager.test.ts
 * 'anchors the mid-slot waveform cursor to the compensated transmit start'.
 */
function operatorManagerCursorOrigin(compensationMs: number): number {
  return SLOT_START_MS + Math.max(0, FT8_MODE.transmitTiming - compensationMs);
}

function createMockMixer() {
  return Object.assign(new EventEmitter(), {
    addOperatorAudio: vi.fn(),
    mixFrameById: vi.fn(async (_frameId: string, _revision: number, _offsetMs?: number): Promise<any> => null),
    mixFrame: vi.fn(async (): Promise<any> => null),
    scheduleFrameMixing: vi.fn(),
    retainFrame: vi.fn(),
    releaseFrame: vi.fn(),
    clearSlotCache: vi.fn(),
    cloneFrameTracks: vi.fn(),
    clearFrame: vi.fn(),
    getFrameSnapshot: vi.fn(),
  });
}

function createHarness(options: {
  nowMs?: number;
  compensationMs?: number;
  mixer?: AudioMixer | ReturnType<typeof createMockMixer>;
  prepareAudioPlayback?: () => Promise<AudioPlaybackReadiness>;
  tailHold?: Promise<void>;
} = {}) {
  let nowMs = options.nowMs ?? SLOT_START_MS + 100;
  const engineEmitter = new EventEmitter();
  const encodeQueue = new EventEmitter();
  const audioDones = [deferred<void>()];
  let playbackIndex = 0;
  let playing = false;
  const setPTT = vi.fn(async (_active: boolean) => undefined);
  const playAudio = vi.fn((_audioData: Float32Array, _sampleRate: number, playOptions?: { onPlaybackStarted?: () => void }) => {
    const done = audioDones[playbackIndex] ?? (audioDones[playbackIndex] = deferred<void>());
    playbackIndex += 1;
    playing = true;
    playOptions?.onPlaybackStarted?.();
    return done.promise.finally(() => { playing = false; });
  });
  const stopCurrentPlayback = vi.fn(async () => {
    playing = false;
    if (playbackIndex > 0) audioDones[playbackIndex - 1]!.reject(new Error('playback interrupted'));
    return 0;
  });
  const prepareAudioPlayback = vi.fn(options.prepareAudioPlayback ?? (async (): Promise<AudioPlaybackReadiness> => ({
    ready: true,
    waitedForDrain: false,
  })));
  const sleep = vi.fn(async (_ms: number) => {
    if (options.tailHold) await options.tailHold;
  });
  let frameSequence = 0;
  const digitalFrameCoordinator = new DigitalFrameCoordinator({
    now: () => nowMs,
    idFactory: () => `frame-${++frameSequence}`,
  });
  const physicalTxCoordinator = new PhysicalTxCoordinator({
    isRadioConnected: () => true,
    setPTT,
    playAudio,
    stopCurrentPlayback,
    prepareAudioPlayback,
    isAudioPlaying: () => playing,
    setTxDialOffset: vi.fn(async () => undefined),
    clearTxDialOffset: vi.fn(async () => undefined),
    now: () => nowMs,
    sleep,
  }, { idFactory: () => 'lease-1' });
  const audioMixer = options.mixer ?? createMockMixer();
  const operatorManager = {
    processPendingTransmissions: vi.fn(),
    updateActiveTransmissionOperators: vi.fn(),
    notifyPhysicalTransmissionComplete: vi.fn(),
    requestStrategyStop: vi.fn(() => 'not-found'),
    getOperatorById: vi.fn(() => ({ stop: vi.fn() })),
    getTransmissionFactContext: vi.fn(() => ({
      frequency: 7_074_000,
      frequencyContext: { mode: 'FT8', radioMode: 'USB', frequency: 7_074_000 },
    })),
    releaseTargetReservation: vi.fn(),
    deferPreparedFrameToNextSlot: vi.fn((frameId: string, reason: string) => (
      digitalFrameCoordinator.deferFrame(frameId, reason)?.phase === 'cancelled'
    )),
    requeuePhysicalFrameAfterOutputFailure: vi.fn((): string[] => []),
  };
  const deps = {
    engineEmitter,
    audioMixer,
    audioStreamManager: { playAudio, stopCurrentPlayback },
    spectrumScheduler: { setPTTActive: vi.fn() },
    encodeQueue,
    operatorManager,
    digitalFrameCoordinator,
    physicalTxCoordinator,
    intentCoordinator: new OperatorIntentCoordinator(),
    clockSource: { now: () => nowMs },
    getCurrentMode: () => FT8_MODE,
    getCompensationMs: () => options.compensationMs ?? 0,
    onBeforeStartPTT: vi.fn(async () => undefined),
    validateDigitalFrameStart: vi.fn(),
  };
  const pipeline = new TransmissionPipeline(deps as never);
  pipeline.setup();

  const completions: Array<Record<string, any>> = [];
  engineEmitter.on('transmissionComplete', (event: Record<string, any>) => completions.push(event));

  return {
    pipeline,
    deps,
    audioMixer,
    digitalFrameCoordinator,
    physicalTxCoordinator,
    operatorManager,
    setPTT,
    playAudio,
    stopCurrentPlayback,
    prepareAudioPlayback,
    sleep,
    completions,
    getAudioDone: (index: number) => audioDones[index] ?? (audioDones[index] = deferred<void>()),
    setNow: (value: number) => { nowMs = value; },
  };
}

type Harness = ReturnType<typeof createHarness>;

function prepareEncodingFrame(harness: Harness, input: {
  operatorIds: string[];
  playbackStartMs?: number;
  slotEndMs?: number;
  expectedDurationMs?: number;
  decisionEpoch?: number;
  nowMs?: number;
}) {
  const prepared = harness.digitalFrameCoordinator.prepareFrame({
    slotId: SLOT_ID,
    intents: input.operatorIds.map((operatorId) => ({
      operatorId,
      source: 'standard-qso' as const,
      reason: 'lesson test',
      text: `${operatorId.toUpperCase()} TEST 73`,
      decisionEpoch: input.decisionEpoch ?? 1,
    })),
    nowMs: input.nowMs,
    slotEndMs: input.slotEndMs,
    expectedDurationMs: input.expectedDurationMs,
    playbackStartMs: input.playbackStartMs,
  });
  const frame = prepared.frame!;
  harness.digitalFrameCoordinator.beginEncoding(frame.frameId);
  return { frame, intents: prepared.intents };
}

function acceptEncodes(harness: Harness, prepared: ReturnType<typeof prepareEncodingFrame>) {
  for (const intent of prepared.intents) {
    harness.digitalFrameCoordinator.acceptEncodeResult({
      frameId: prepared.frame.frameId,
      operatorId: intent.operatorId!,
      decisionEpoch: intent.decisionEpoch,
      revision: prepared.frame.revision,
    });
  }
}

async function deliverEncode(
  harness: Harness,
  prepared: ReturnType<typeof prepareEncodingFrame>,
  operatorId: string,
  audioData = new Float32Array(1_000),
  sampleRate = 1_000,
): Promise<void> {
  const intent = prepared.intents.find((candidate) => candidate.operatorId === operatorId)!;
  await (harness.pipeline as any).handleEncodeComplete({
    operatorId,
    audioData,
    sampleRate,
    duration: audioData.length / sampleRate,
    request: {
      operatorId,
      message: intent.text,
      frequency: 1_500,
      frameId: prepared.frame.frameId,
      frameRevision: prepared.frame.revision,
      decisionEpoch: intent.decisionEpoch,
      requestId: `${prepared.frame.frameId}-${operatorId}`,
      slotStartMs: SLOT_START_MS,
    },
  });
}

/** Ramp waveform whose sample value equals its index, so trimming is observable. */
function rampWaveform(length: number): Float32Array {
  return Float32Array.from({ length }, (_, index) => index);
}

function mockMix(frame: { frameId: string; revision: number }, trackOperatorIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    operatorIds: trackOperatorIds,
    trackIds: trackOperatorIds.map((operatorId) => `${operatorId}\u0000default`),
    audioData: new Float32Array(1_000),
    sampleRate: 1_000,
    duration: 1,
    playbackOffsetMs: 0,
    txDialShiftHz: 0,
    frameId: frame.frameId,
    frameRevision: frame.revision,
    slotId: SLOT_ID,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TransmissionPipeline transmit compensation (RX-25 / TX-13, pinned before kernel migration)', () => {
  // Pre-migration characterization: today the compensation is subtracted
  // separately by SlotClock, TransmissionPipeline and RadioOperatorManager.
  // After the migration the kernel subtracts it once; these three sites must
  // stay equivalent (see packages/core/test/slot-clock-compensation.test.ts and
  // RadioOperatorManager.test.ts 'anchors the mid-slot waveform cursor to the
  // compensated transmit start').
  it.each([
    { compensationMs: 300, target: SLOT_START_MS + 200 },
    { compensationMs: -200, target: SLOT_START_MS + 700 },
  ])('schedules the mix at slot start + transmitTiming - compensation ($compensationMs ms)', async ({ compensationMs, target }) => {
    const harness = createHarness({ nowMs: SLOT_START_MS + 100, compensationMs });
    const mixer = harness.audioMixer as ReturnType<typeof createMockMixer>;
    const prepared = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a'],
      playbackStartMs: operatorManagerCursorOrigin(compensationMs),
    });

    await deliverEncode(harness, prepared, 'operator-a');

    expect(mixer.addOperatorAudio).toHaveBeenCalledOnce();
    expect(mixer.mixFrameById).not.toHaveBeenCalled();
    expect(mixer.scheduleFrameMixing).toHaveBeenCalledWith(
      { frameId: prepared.frame.frameId, revision: prepared.frame.revision },
      target,
      target,
    );
    // The pipeline target and the waveform cursor origin are the same instant:
    // at the scheduled target nothing of the waveform has been skipped yet.
    expect(harness.digitalFrameCoordinator.getPlaybackOffsetMs(prepared.frame.frameId, target)).toBe(0);
  });

  it('mixes immediately once now reaches the compensated target (+300 ms), where zero compensation would still schedule', async () => {
    const compensated = createHarness({ nowMs: SLOT_START_MS + 200, compensationMs: 300 });
    const compensatedMixer = compensated.audioMixer as ReturnType<typeof createMockMixer>;
    const compensatedFrame = prepareEncodingFrame(compensated, {
      operatorIds: ['operator-a'],
      playbackStartMs: operatorManagerCursorOrigin(300),
    });
    await deliverEncode(compensated, compensatedFrame, 'operator-a');
    expect(compensatedMixer.scheduleFrameMixing).not.toHaveBeenCalled();
    expect(compensatedMixer.mixFrameById).toHaveBeenCalledWith(
      compensatedFrame.frame.frameId,
      compensatedFrame.frame.revision,
      0,
    );

    const uncompensated = createHarness({ nowMs: SLOT_START_MS + 200, compensationMs: 0 });
    const uncompensatedMixer = uncompensated.audioMixer as ReturnType<typeof createMockMixer>;
    const uncompensatedFrame = prepareEncodingFrame(uncompensated, {
      operatorIds: ['operator-a'],
      playbackStartMs: operatorManagerCursorOrigin(0),
    });
    await deliverEncode(uncompensated, uncompensatedFrame, 'operator-a');
    expect(uncompensatedMixer.mixFrameById).not.toHaveBeenCalled();
    expect(uncompensatedMixer.scheduleFrameMixing).toHaveBeenCalledWith(
      expect.anything(),
      SLOT_START_MS + 500,
      SLOT_START_MS + 500,
    );
  });

  it('clamps the compensated transmit offset at zero (never before the slot start)', async () => {
    // +800 ms exceeds FT8 transmitTiming (500 ms): target = slot start, not slot start - 300.
    const harness = createHarness({ nowMs: SLOT_START_MS + 100, compensationMs: 800 });
    const mixer = harness.audioMixer as ReturnType<typeof createMockMixer>;
    const prepared = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a'],
      playbackStartMs: operatorManagerCursorOrigin(800),
    });
    expect(operatorManagerCursorOrigin(800)).toBe(SLOT_START_MS);

    await deliverEncode(harness, prepared, 'operator-a');

    expect(mixer.scheduleFrameMixing).not.toHaveBeenCalled();
    expect(mixer.mixFrameById).toHaveBeenCalledWith(prepared.frame.frameId, prepared.frame.revision, 100);
  });

  it.each([300, -200])('skips exactly the time elapsed since the compensated start when encoding finishes late (%i ms)', async (compensationMs) => {
    const origin = operatorManagerCursorOrigin(compensationMs);
    const harness = createHarness({ nowMs: origin + 1_234, compensationMs });
    const mixer = harness.audioMixer as ReturnType<typeof createMockMixer>;
    const prepared = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a'],
      playbackStartMs: origin,
    });

    await deliverEncode(harness, prepared, 'operator-a');

    expect(mixer.scheduleFrameMixing).not.toHaveBeenCalled();
    expect(mixer.mixFrameById).toHaveBeenCalledTimes(1);
    expect(mixer.mixFrameById).toHaveBeenCalledWith(prepared.frame.frameId, prepared.frame.revision, 1_234);
  });
});

describe('TransmissionPipeline late encode completion (TX-15)', () => {
  it('starts from the current waveform cursor when FT8 encoding completes after the target time', async () => {
    // FT8 encodeAdvance=0: encoding starts at the transmit boundary and always
    // completes after it. The pipeline must mix at the current cursor and play
    // the remainder immediately, not schedule and play the waveform from 0.
    const mixer = new AudioMixer();
    const scheduleSpy = vi.spyOn(mixer, 'scheduleFrameMixing');
    const mixSpy = vi.spyOn(mixer, 'mixFrameById');
    const origin = operatorManagerCursorOrigin(0);
    const harness = createHarness({ nowMs: origin + 380, mixer });
    const prepared = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a'],
      playbackStartMs: origin,
      slotEndMs: SLOT_START_MS + FT8_MODE.slotMs,
      expectedDurationMs: 12_640,
    });

    const handling = deliverEncode(harness, prepared, 'operator-a', rampWaveform(12_640), 1_000);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(mixSpy.mock.calls.map((call) => call[2])).not.toContain(0);
    expect(mixSpy).toHaveBeenCalledWith(prepared.frame.frameId, prepared.frame.revision, 380);
    const played = harness.playAudio.mock.calls[0]![0] as Float32Array;
    expect(played).toHaveLength(12_640 - 380);
    expect(played[0]).toBe(380);

    harness.getAudioDone(0).resolve();
    await handling;
    expect(harness.completions).toEqual([
      expect.objectContaining({ operatorId: 'operator-a', success: true, physicalConfirmed: true }),
    ]);
  });
});

describe('TransmissionPipeline incomplete mixes (TX-10)', () => {
  function expectAllFailed(harness: Harness, frameId: string, operatorIds: string[], error: string) {
    const frameCompletions = harness.completions.filter((event) => event.frameId === frameId);
    expect(frameCompletions.map((event) => event.operatorId).sort()).toEqual([...operatorIds].sort());
    for (const event of frameCompletions) {
      expect(event).toMatchObject({ success: false, physicalConfirmed: false, error });
    }
    expect(harness.operatorManager.notifyPhysicalTransmissionComplete).not.toHaveBeenCalled();
  }

  it('fails the frame without keying when the ready mix is missing a participant track', async () => {
    const mixer = new AudioMixer();
    const harness = createHarness({ nowMs: SLOT_START_MS + 900, mixer });
    const prepared = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a', 'operator-b'],
      playbackStartMs: SLOT_START_MS + 500,
    });
    // operator-b's encode is accepted but its audio never reaches the mixer cache.
    const intentB = prepared.intents.find((intent) => intent.operatorId === 'operator-b')!;
    harness.digitalFrameCoordinator.acceptEncodeResult({
      frameId: prepared.frame.frameId,
      operatorId: 'operator-b',
      decisionEpoch: intentB.decisionEpoch,
      revision: prepared.frame.revision,
    });

    await deliverEncode(harness, prepared, 'operator-a', new Float32Array(12_640), 1_000);

    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
    expectAllFailed(harness, prepared.frame.frameId, ['operator-a', 'operator-b'], 'mixed frame participants are incomplete');
  });

  it('releases PTT without playing when the mix frozen at PTT acknowledgement lost a participant', async () => {
    const harness = createHarness();
    const mixer = harness.audioMixer as ReturnType<typeof createMockMixer>;
    const prepared = prepareEncodingFrame(harness, { operatorIds: ['operator-a', 'operator-b'] });
    acceptEncodes(harness, prepared);
    mixer.mixFrameById.mockResolvedValueOnce(mockMix(prepared.frame, ['operator-a']));

    await (harness.pipeline as any).handleMixedAudioReady(mockMix(prepared.frame, ['operator-a', 'operator-b']));

    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(harness.playAudio).not.toHaveBeenCalled();
    expectAllFailed(
      harness,
      prepared.frame.frameId,
      ['operator-a', 'operator-b'],
      'digital frame participants changed before audio start',
    );
  });

  it('fails before keying when the post-drain refresh mix lost a participant', async () => {
    const harness = createHarness({
      prepareAudioPlayback: async () => ({ ready: true, waitedForDrain: true }),
    });
    const mixer = harness.audioMixer as ReturnType<typeof createMockMixer>;
    const prepared = prepareEncodingFrame(harness, { operatorIds: ['operator-a', 'operator-b'] });
    acceptEncodes(harness, prepared);
    mixer.mixFrameById.mockResolvedValueOnce(mockMix(prepared.frame, ['operator-b']));

    await (harness.pipeline as any).handleMixedAudioReady(mockMix(prepared.frame, ['operator-a', 'operator-b']));

    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
    expectAllFailed(
      harness,
      prepared.frame.frameId,
      ['operator-a', 'operator-b'],
      'digital frame tracks changed while previous audio drained',
    );
  });

  it('keeps the current audio and fails the replacement when its remix lost a participant', async () => {
    const harness = createHarness({ nowMs: 1_000 });
    const mixer = harness.audioMixer as ReturnType<typeof createMockMixer>;
    const original = prepareEncodingFrame(harness, { operatorIds: ['operator-a', 'operator-b'] });
    acceptEncodes(harness, original);
    mixer.mixFrameById.mockImplementation(async (frameId: string) => (
      frameId === original.frame.frameId ? mockMix(original.frame, ['operator-a', 'operator-b']) : null
    ));
    const originalHandling = (harness.pipeline as any).handleMixedAudioReady(
      mockMix(original.frame, ['operator-a', 'operator-b']),
    );
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacement = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a', 'operator-b'],
      decisionEpoch: 2,
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    expect(harness.digitalFrameCoordinator.getPreparationAction(replacement.frame.frameId)).toBe('restart-current');
    acceptEncodes(harness, replacement);
    mixer.mixFrameById.mockImplementation(async (frameId: string) => (
      frameId === replacement.frame.frameId
        ? mockMix(replacement.frame, ['operator-a'])
        : mockMix(original.frame, ['operator-a', 'operator-b'])
    ));

    await (harness.pipeline as any).handleMixedAudioReady(mockMix(replacement.frame, ['operator-a', 'operator-b']));

    expect(harness.stopCurrentPlayback).not.toHaveBeenCalled();
    expect(harness.playAudio).toHaveBeenCalledTimes(1);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expectAllFailed(
      harness,
      replacement.frame.frameId,
      ['operator-a', 'operator-b'],
      'replacement mix lost one or more frame tracks',
    );

    harness.getAudioDone(0).resolve();
    await originalHandling;
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });
});

describe('TransmissionPipeline frame audio retention (TX-11)', () => {
  it('keeps committed, on-air and draining frame tracks through slot-cache clears and cache-cap pruning, then releases them at terminal', async () => {
    const mixer = new AudioMixer();
    const tailHold = deferred<void>();
    const harness = createHarness({ nowMs: SLOT_START_MS + 900, mixer, tailHold: tailHold.promise });
    const prepared = prepareEncodingFrame(harness, {
      operatorIds: ['operator-a'],
      playbackStartMs: SLOT_START_MS + 500,
    });
    const { frameId, revision } = prepared.frame;
    const addFiller = (index: number) => mixer.addOperatorAudio(
      'filler',
      new Float32Array(4),
      1_000,
      SLOT_START_MS,
      `filler-${index}`,
      0,
      { frameId: `filler-${index}`, frameRevision: 1, slotId: SLOT_ID },
    );

    const survivedSlotClear: Record<string, boolean> = {};
    harness.digitalFrameCoordinator.on('frameChanged', (frame) => {
      if (frame.frameId !== frameId) return;
      if (frame.phase === 'committed' || frame.phase === 'on_air' || frame.phase === 'draining') {
        addFiller(0);
        mixer.clearSlotCache();
        survivedSlotClear[frame.phase] = mixer.getFrameSnapshot(frameId, revision) !== null;
        // Control: an unretained frame is cleared by the same call.
        expect(mixer.getFrameSnapshot('filler-0', 1)).toBeNull();
      }
    });

    const handling = deliverEncode(harness, prepared, 'operator-a', new Float32Array(12_640), 1_000);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    expect(survivedSlotClear).toEqual({ committed: true, on_air: true });

    // Cache cap (256 frames) pruning while on air: oldest unretained frames go, the on-air frame stays.
    for (let index = 1; index <= 300; index += 1) addFiller(index);
    expect(mixer.getFrameSnapshot('filler-1', 1)).toBeNull();
    expect(mixer.getFrameSnapshot('filler-300', 1)).not.toBeNull();
    expect(mixer.getFrameSnapshot(frameId, revision)?.tracks.size).toBe(1);

    harness.getAudioDone(0).resolve();
    await vi.waitFor(() => expect(harness.sleep).toHaveBeenCalledWith(500));
    expect(harness.digitalFrameCoordinator.getFrame(frameId)?.phase).toBe('draining');
    expect(survivedSlotClear).toEqual({ committed: true, on_air: true, draining: true });
    for (let index = 301; index <= 600; index += 1) addFiller(index);
    expect(mixer.getFrameSnapshot(frameId, revision)).not.toBeNull();

    tailHold.resolve();
    await handling;
    expect(harness.digitalFrameCoordinator.getFrame(frameId)?.phase).toBe('terminal');
    expect(mixer.getFrameSnapshot(frameId, revision)).toBeNull();
  });
});
