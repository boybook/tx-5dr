import { EventEmitter } from 'eventemitter3';
import type { AudioPlaybackReadiness } from '../../audio/AudioStreamManager.js';
import { describe, expect, it, vi } from 'vitest';
import { DigitalFrameCoordinator } from '../../transmission/DigitalFrameCoordinator.js';
import { OperatorIntentCoordinator } from '../../transmission/OperatorIntentCoordinator.js';
import { PhysicalTxCoordinator } from '../../transmission/PhysicalTxCoordinator.js';
import { TransmissionPipeline } from '../TransmissionPipeline.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(options: {
  pttStart?: Promise<void>;
  nowMs?: number;
  slotEndMs?: number;
  expectedDurationMs?: number;
  beforeStart?: Promise<void>;
  dialOffset?: Promise<void>;
  stopPlayback?: Promise<void>;
  playbackStartMs?: number;
  operatorIds?: string[];
  validateDigitalFrameStart?: (operatorIds: readonly string[]) => void;
} = {}) {
  const engineEmitter = new EventEmitter();
  const encodeQueue = new EventEmitter();
  const mixerEmitter = new EventEmitter();
  const audioDones = [deferred<void>()];
  let playbackIndex = 0;
  let playing = false;
  let nowMs = options.nowMs ?? 1_000;
  const setPTT = vi.fn(async (active: boolean) => {
    if (active && options.pttStart) await options.pttStart;
  });
  const playAudio = vi.fn((_audioData: Float32Array, _sampleRate: number, options?: { onPlaybackStarted?: () => void }) => {
    const audioDone = audioDones[playbackIndex] ?? (audioDones[playbackIndex] = deferred<void>());
    playbackIndex += 1;
    playing = true;
    options?.onPlaybackStarted?.();
    return audioDone.promise.finally(() => {
      playing = false;
    });
  });
  const stopCurrentPlayback = vi.fn(async () => {
    playing = false;
    audioDones[Math.max(0, playbackIndex - 1)].reject(new Error('playback interrupted'));
    if (options.stopPlayback) await options.stopPlayback;
    return 0;
  });
  const prepareAudioPlayback = vi.fn(async (): Promise<AudioPlaybackReadiness> => ({
    ready: true,
    waitedForDrain: false,
  }));
  let frameSequence = 0;
  const digitalFrameCoordinator = new DigitalFrameCoordinator({ idFactory: () => `frame-${++frameSequence}` });
  const frameMixes = new Map<string, Record<string, any>>();
  const physicalTxCoordinator = new PhysicalTxCoordinator({
    isRadioConnected: () => true,
    setPTT,
    playAudio,
    stopCurrentPlayback,
    prepareAudioPlayback,
    isAudioPlaying: () => playing,
    setTxDialOffset: vi.fn(async () => {
      if (options.dialOffset) await options.dialOffset;
    }),
    clearTxDialOffset: vi.fn(async () => undefined),
    now: () => nowMs,
    sleep: vi.fn(async () => undefined),
  }, { idFactory: () => 'lease-1' });
  const audioMixer = Object.assign(mixerEmitter, {
    addOperatorAudio: vi.fn(),
    mixFrameById: vi.fn(async (frameId: string, revision: number) => frameMixes.get(`${frameId}:${revision}`) ?? null),
    mixFrame: vi.fn(async (snapshot: { frameId: string; revision: number }) => frameMixes.get(`${snapshot.frameId}:${snapshot.revision}`) ?? null),
    scheduleFrameMixing: vi.fn(),
    retainFrame: vi.fn(),
    releaseFrame: vi.fn(),
    clearSlotCache: vi.fn(),
    cloneFrameTracks: vi.fn((
      _source: unknown,
      target: { frameId: string; frameRevision: number; slotId: string },
      retainedOperatorIds: string[],
    ) => ({
      frameId: target.frameId,
      revision: target.frameRevision,
      slotId: target.slotId,
      txDialShiftHz: 0,
      tracks: new Map(retainedOperatorIds.map((operatorId) => [operatorId, { operatorId }])),
    })),
    clearFrame: vi.fn(),
    clear: vi.fn(),
  });
  const operatorManager = {
    getPendingTransmissionsCount: vi.fn(() => 0),
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
    deferPreparedFrameToNextSlot: vi.fn((frameId: string, reason: string) => {
      return digitalFrameCoordinator.deferFrame(frameId, reason)?.phase === 'cancelled';
    }),
    requeuePhysicalFrameAfterOutputFailure: vi.fn((): string[] => []),
  };
  const intentCoordinator = new OperatorIntentCoordinator();
  const transmissionTracker = {
    updatePhase: vi.fn(),
    recordAudioAddedToMixer: vi.fn(),
  };
  const deps = {
    engineEmitter,
    audioMixer,
    audioStreamManager: { playAudio, stopCurrentPlayback },
    spectrumScheduler: { setPTTActive: vi.fn() },
    transmissionTracker,
    encodeQueue,
    operatorManager,
    digitalFrameCoordinator,
    physicalTxCoordinator,
    intentCoordinator,
    clockSource: { now: () => nowMs },
    getCurrentMode: () => ({ name: 'FT8', slotMs: 15_000, transmitTiming: 500 }),
    getCompensationMs: () => 0,
    onBeforeStartPTT: vi.fn(async () => {
      if (options.beforeStart) await options.beforeStart;
    }),
    validateDigitalFrameStart: vi.fn((operatorIds: readonly string[]) => {
      options.validateDigitalFrameStart?.(operatorIds);
    }),
  };
  const pipeline = new TransmissionPipeline(deps as never);
  pipeline.setup();

  const operatorIds = options.operatorIds ?? ['operator-a'];
  const prepared = digitalFrameCoordinator.prepareFrame({
    slotId: 'slot-0',
    intents: operatorIds.map((operatorId) => ({
      operatorId,
      source: 'standard-qso' as const,
      reason: 'test',
      text: operatorId === 'operator-a' ? 'A B 73' : `${operatorId} TEST 73`,
      decisionEpoch: 1,
    })),
    slotEndMs: options.slotEndMs,
    expectedDurationMs: options.expectedDurationMs,
    playbackStartMs: options.playbackStartMs,
  });
  digitalFrameCoordinator.beginEncoding(prepared.frame!.frameId);
  prepared.intents.forEach((intent) => {
    digitalFrameCoordinator.acceptEncodeResult({
      frameId: prepared.frame!.frameId,
      operatorId: intent.operatorId!,
      decisionEpoch: intent.decisionEpoch,
      revision: prepared.frame!.revision,
    });
  });
  const mixedAudio = {
    operatorIds,
    audioData: new Float32Array(12_000),
    sampleRate: 12_000,
    duration: 1,
    playbackOffsetMs: 0,
    txDialShiftHz: 681,
    frameId: prepared.frame!.frameId,
    frameRevision: prepared.frame!.revision,
    slotId: 'slot-0',
  };
  frameMixes.set(`${prepared.frame!.frameId}:${prepared.frame!.revision}`, mixedAudio);

  return {
    pipeline,
    deps,
    setPTT,
    playAudio,
    prepareAudioPlayback,
    audioDone: audioDones[0],
    getAudioDone: (index: number) => audioDones[index] ?? (audioDones[index] = deferred<void>()),
    mixedAudio,
    prepared,
    setFrameMix: (frameId: string, revision: number, audio: Record<string, any>) => {
      frameMixes.set(`${frameId}:${revision}`, audio);
    },
    setNow: (value: number) => { nowMs = value; },
  };
}

describe('TransmissionPipeline lifecycle integration', () => {
  it('cancels the owning frame when a non-default stream encode fails', () => {
    const harness = createHarness();
    const frame = harness.deps.digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-1',
      intents: [{
        operatorId: 'operator-a',
        streamId: 'stream-2',
        audioFrequencyHz: 1600,
        source: 'plugin',
        reason: 'parallel lane',
        text: 'A B RR73',
        decisionEpoch: 2,
      }],
    });
    harness.deps.digitalFrameCoordinator.beginEncoding(frame.frame!.frameId);

    (harness.pipeline as any).handleEncodeError(new Error('encoder failed'), {
      operatorId: 'operator-a',
      streamId: 'stream-2',
      message: 'A B RR73',
      frequency: 1600,
      frameId: frame.frame!.frameId,
      frameRevision: frame.frame!.revision,
      decisionEpoch: 2,
    });

    expect(harness.deps.digitalFrameCoordinator.getFrame(frame.frame!.frameId))
      .toMatchObject({ phase: 'cancelled' });
  });

  it('reports on-air only after PTT confirmation and audio start, then completes once', async () => {
    const harness = createHarness();
    const physicalPhases: Array<{ phase: string; pttConfirmed: boolean }> = [];
    const completions: Array<Record<string, unknown>> = [];
    const transmissionLogs: Array<Record<string, unknown>> = [];
    harness.deps.physicalTxCoordinator.on('phaseChanged', (event) => physicalPhases.push(event));
    harness.deps.engineEmitter.on('transmissionComplete', (event) => completions.push(event));
    harness.deps.engineEmitter.on('transmissionLog', (event) => transmissionLogs.push(event));

    const handling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    expect(physicalPhases.some((event) => event.phase === 'active' && event.pttConfirmed === true)).toBe(true);
    expect(transmissionLogs).toEqual([expect.objectContaining({
      frameId: 'frame-1',
      revision: 1,
      playbackGeneration: 1,
      phase: 'on_air',
      physicalConfirmed: true,
      operatorId: 'operator-a',
      message: 'A B 73',
    })]);

    harness.audioDone.resolve();
    await handling;

    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      frameId: 'frame-1',
      success: true,
      physicalConfirmed: true,
    });
    expect(harness.deps.operatorManager.notifyPhysicalTransmissionComplete)
      .toHaveBeenCalledWith('operator-a', 'A B 73');
  });

  it('revalidates the digital frame after encoding and before asserting PTT', async () => {
    const validateStart = vi.fn(() => {
      throw new Error('WW Digi is unavailable on the standard FT8 dial frequency 14.074 MHz');
    });
    const harness = createHarness({ validateDigitalFrameStart: validateStart });

    await (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);

    expect(validateStart).toHaveBeenCalledWith(['operator-a']);
    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
    expect(harness.deps.digitalFrameCoordinator.getFrame('frame-1')).toMatchObject({
      phase: 'terminal',
    });
  });

  it('requeues a severe output failure for the next transmit cycle without reporting success', () => {
    const harness = createHarness();
    harness.deps.operatorManager.requeuePhysicalFrameAfterOutputFailure.mockReturnValue(['operator-a']);
    harness.deps.digitalFrameCoordinator.prepareFrameForHandover('frame-1', ['operator-a']);
    harness.deps.digitalFrameCoordinator.commitFrame('frame-1');
    harness.deps.digitalFrameCoordinator.markOnAir('frame-1');

    (harness.pipeline as any).finishDigitalFramePlayback('frame-1', harness.mixedAudio, {
      success: false,
      reason: 'audio transmission failed',
      error: 'No such device',
      physicalConfirmed: true,
      retryDisposition: 'next-transmit-cycle',
      audioIssue: {
        issueId: 'issue-device-loss',
        streamGeneration: 4,
        kind: 'device-loss',
      },
    });

    expect(harness.deps.operatorManager.requeuePhysicalFrameAfterOutputFailure)
      .toHaveBeenCalledWith('frame-1', 'audio transmission failed');
    expect(harness.deps.operatorManager.notifyPhysicalTransmissionComplete).not.toHaveBeenCalled();
    expect(harness.deps.digitalFrameCoordinator.getFrame('frame-1'))
      .toMatchObject({ phase: 'terminal' });
  });

  it('does not display on-air or start audio while PTT is still starting', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({ pttStart: pttStart.promise });
    const physicalPhases: Array<{ phase: string; pttConfirmed: boolean }> = [];
    harness.deps.physicalTxCoordinator.on('phaseChanged', (event) => physicalPhases.push(event));

    const handling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    expect(harness.playAudio).not.toHaveBeenCalled();
    expect(physicalPhases.some((event) => event.phase === 'active' && event.pttConfirmed === true)).toBe(false);

    pttStart.resolve();
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    harness.audioDone.resolve();
    await handling;
  });

  it('keeps the predecessor lease when a starting replacement is superseded before handover', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({
      pttStart: pttStart.promise,
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    const initialHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));

    const frame2 = harness.deps.digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-0',
      intents: [{
        operatorId: 'operator-a',
        source: 'operator-edit',
        reason: 'first edit while PTT starts',
        text: 'A B RR73',
        decisionEpoch: 2,
      }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    expect(frame2.action).toBe('restart-current');
    harness.deps.digitalFrameCoordinator.beginEncoding(frame2.frame!.frameId);
    harness.deps.digitalFrameCoordinator.acceptEncodeResult({
      frameId: frame2.frame!.frameId,
      operatorId: 'operator-a',
      decisionEpoch: frame2.intents[0].decisionEpoch,
      revision: frame2.frame!.revision,
    });
    const frame2Audio = {
      ...harness.mixedAudio,
      frameId: frame2.frame!.frameId,
      frameRevision: frame2.frame!.revision,
    };
    harness.setFrameMix(frame2.frame!.frameId, frame2.frame!.revision, frame2Audio);
    const frame2Handling = (harness.pipeline as any).handleMixedAudioReady(frame2Audio);
    await vi.waitFor(() => {
      expect(harness.deps.digitalFrameCoordinator.getFrame(frame2.frame!.frameId)?.phase).toBe('prepared');
    });

    const frame3 = harness.deps.digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-0',
      intents: [{
        operatorId: 'operator-a',
        source: 'operator-edit',
        reason: 'newer edit supersedes pending handover',
        text: 'A B 73',
        decisionEpoch: 3,
      }],
      nowMs: 1_100,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    expect(frame3.frame).not.toBeNull();
    expect(harness.deps.digitalFrameCoordinator.getFrame(frame2.frame!.frameId)).toMatchObject({
      phase: 'cancelled',
      superseded: true,
    });

    pttStart.resolve();
    await frame2Handling;
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.deps.audioStreamManager.stopCurrentPlayback).not.toHaveBeenCalled();
    expect(harness.deps.physicalTxCoordinator.getSnapshot()).toMatchObject({
      frameId: harness.prepared.frame!.frameId,
      phase: 'active',
      pttConfirmed: true,
    });

    harness.audioDone.resolve();
    await initialHandling;
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('preserves an active lease at the next slot boundary', async () => {
    const harness = createHarness();
    const handling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    await harness.pipeline.onSlotStart();
    expect(harness.deps.audioMixer.clearSlotCache).not.toHaveBeenCalled();
    expect(harness.deps.audioStreamManager.stopCurrentPlayback).not.toHaveBeenCalled();

    harness.audioDone.resolve();
    await handling;
  });

  it('defers a fully encoded frame when delay consumes the physical slot budget', async () => {
    const harness = createHarness({
      nowMs: 14_000,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
    });

    await (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);

    expect(harness.deps.operatorManager.deferPreparedFrameToNextSlot)
      .toHaveBeenCalledWith('frame-1', expect.stringContaining('no longer fits'));
    expect(harness.deps.audioMixer.clearFrame).toHaveBeenCalledWith('frame-1', 1);
    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
  });

  it('defers a ready frame instead of dropping it while another physical lease is active', async () => {
    const harness = createHarness();
    const leaseId = await harness.deps.physicalTxCoordinator.acquireLease({
      source: 'voice',
      reason: 'voice drain overlaps next digital slot',
    });

    await (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);

    expect(harness.deps.operatorManager.deferPreparedFrameToNextSlot)
      .toHaveBeenCalledWith('frame-1', expect.stringContaining('physical transmitter busy'));
    expect(harness.deps.digitalFrameCoordinator.getFrame('frame-1')).toMatchObject({ phase: 'cancelled' });
    expect(harness.playAudio).not.toHaveBeenCalled();
    await harness.deps.physicalTxCoordinator.releaseLease(leaseId, 'voice complete');
  });

  it('rechecks the complete-frame budget after delayed PTT acknowledgement', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({
      pttStart: pttStart.promise,
      nowMs: 1_000,
      slotEndMs: 3_000,
      expectedDurationMs: 1_000,
    });

    const handling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    harness.setNow(2_000);
    pttStart.resolve();
    await handling;

    expect(harness.deps.operatorManager.deferPreparedFrameToNextSlot)
      .toHaveBeenCalledWith('frame-1', expect.stringContaining('before PTT start'));
    expect(harness.setPTT).toHaveBeenCalledWith(false);
    expect(harness.playAudio).not.toHaveBeenCalled();
  });

  it('plays the cursor-aligned remainder after a slow PTT acknowledgement', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({
      pttStart: pttStart.promise,
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 12_640,
      playbackStartMs: 500,
    });
    harness.mixedAudio.audioData = new Float32Array(12_140);
    harness.mixedAudio.sampleRate = 1_000;
    harness.mixedAudio.duration = 12.14;
    harness.mixedAudio.playbackOffsetMs = 500;
    const finalAudio = {
      ...harness.mixedAudio,
      audioData: new Float32Array(9_940),
      sampleRate: 1_000,
      duration: 9.94,
      playbackOffsetMs: 2_700,
    };
    harness.setFrameMix('frame-1', 1, finalAudio);

    const handling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    harness.setNow(3_200);
    pttStart.resolve();
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    expect(harness.deps.audioMixer.mixFrameById).toHaveBeenCalledWith('frame-1', 1, 2_700);
    expect(harness.playAudio).toHaveBeenCalledWith(
      finalAudio.audioData,
      finalAudio.sampleRate,
      expect.any(Object),
    );
    expect(harness.setPTT).not.toHaveBeenCalledWith(false);
    harness.audioDone.resolve();
    await handling;
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('replaces an on-air correction without toggling the physical PTT lease', async () => {
    const stopPlayback = deferred<void>();
    const harness = createHarness({ stopPlayback: stopPlayback.promise });
    const completions: Array<Record<string, unknown>> = [];
    harness.deps.engineEmitter.on('transmissionComplete', (event) => completions.push(event));
    const oldHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    const replacement = harness.deps.digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-0',
      intents: [{
        operatorId: 'operator-a',
        source: 'late-decode',
        reason: 'late RR73 correction',
        text: 'A B RR73',
        decisionEpoch: 2,
      }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    expect(replacement.action).toBe('restart-current');
    harness.deps.digitalFrameCoordinator.beginEncoding(replacement.frame!.frameId);
    harness.deps.digitalFrameCoordinator.acceptEncodeResult({
      frameId: replacement.frame!.frameId,
      operatorId: 'operator-a',
      decisionEpoch: replacement.intents[0].decisionEpoch,
      revision: replacement.frame!.revision,
    });
    const replacementAudio = {
      ...harness.mixedAudio,
      frameId: replacement.frame!.frameId,
      frameRevision: replacement.frame!.revision,
    };
    harness.setFrameMix(replacement.frame!.frameId, replacement.frame!.revision, replacementAudio);

    const replacementHandling = (harness.pipeline as any).handleMixedAudioReady(replacementAudio);
    await vi.waitFor(() => expect(harness.deps.audioStreamManager.stopCurrentPlayback).toHaveBeenCalled());
    harness.setNow(1_100);
    stopPlayback.resolve();
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));
    expect(harness.prepareAudioPlayback).toHaveBeenCalledTimes(2);
    expect(harness.deps.audioMixer.mixFrameById).toHaveBeenCalledWith('frame-2', 2, 500);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    harness.getAudioDone(1).resolve();
    await Promise.all([oldHandling, replacementHandling]);

    expect(completions.filter((event) => event.frameId === 'frame-1')).toEqual([
      expect.objectContaining({ success: false, physicalConfirmed: true }),
    ]);
    expect(completions.filter((event) => event.frameId === 'frame-2')).toEqual([
      expect.objectContaining({ success: true, physicalConfirmed: true }),
    ]);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('revalidates an active-lease replacement before changing its audio', async () => {
    let blocked = false;
    const stopPlayback = deferred<void>();
    const harness = createHarness({
      stopPlayback: stopPlayback.promise,
      validateDigitalFrameStart: () => {
        if (blocked) throw new Error('WW Digi is unavailable on the standard FT8 dial frequency');
      },
    });
    const initialHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacement = harness.deps.digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-0',
      intents: [{
        operatorId: 'operator-a',
        source: 'late-decode',
        reason: 'late correction after dial change',
        text: 'A B RR73',
        decisionEpoch: 2,
      }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    harness.deps.digitalFrameCoordinator.beginEncoding(replacement.frame!.frameId);
    harness.deps.digitalFrameCoordinator.acceptEncodeResult({
      frameId: replacement.frame!.frameId,
      operatorId: 'operator-a',
      decisionEpoch: replacement.intents[0].decisionEpoch,
      revision: replacement.frame!.revision,
    });
    const replacementAudio = {
      ...harness.mixedAudio,
      frameId: replacement.frame!.frameId,
      frameRevision: replacement.frame!.revision,
    };
    harness.setFrameMix(replacement.frame!.frameId, replacement.frame!.revision, replacementAudio);

    const replacementHandling = (harness.pipeline as any).handleMixedAudioReady(replacementAudio);
    await vi.waitFor(() => expect(harness.deps.audioStreamManager.stopCurrentPlayback).toHaveBeenCalledOnce());
    blocked = true;
    stopPlayback.resolve();
    await Promise.all([initialHandling, replacementHandling]);

    expect(harness.playAudio).toHaveBeenCalledTimes(1);
    expect(harness.deps.digitalFrameCoordinator.getFrame(replacement.frame!.frameId)).toMatchObject({
      phase: 'terminal',
    });
    expect(harness.deps.physicalTxCoordinator.getSnapshot()).toMatchObject({
      phase: 'idle',
    });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('does not double-trim replacement audio across delayed mix and output drain stages', async () => {
    const harness = createHarness({ nowMs: 1_000 });
    const oldHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacement = harness.deps.digitalFrameCoordinator.prepareFrame({
      slotId: 'slot-0',
      intents: [{
        operatorId: 'operator-a',
        source: 'operator-edit',
        reason: 'frequency changed on air',
        text: 'A B 73',
        decisionEpoch: 2,
      }],
      nowMs: 1_000,
      slotEndMs: 15_000,
      expectedDurationMs: 3_000,
      playbackStartMs: 500,
    });
    harness.deps.digitalFrameCoordinator.beginEncoding(replacement.frame!.frameId);
    harness.deps.digitalFrameCoordinator.acceptEncodeResult({
      frameId: replacement.frame!.frameId,
      operatorId: 'operator-a',
      decisionEpoch: replacement.intents[0].decisionEpoch,
      revision: replacement.frame!.revision,
    });

    const delayedMix = deferred<Record<string, any>>();
    const outputDrain = deferred<AudioPlaybackReadiness>();
    harness.deps.audioMixer.mixFrameById.mockReturnValueOnce(delayedMix.promise);
    harness.prepareAudioPlayback.mockReturnValueOnce(outputDrain.promise);
    const replacementHandling = (harness.pipeline as any).handleMixedAudioReady({
      ...harness.mixedAudio,
      frameId: replacement.frame!.frameId,
      frameRevision: replacement.frame!.revision,
    });

    await vi.waitFor(() => expect(harness.deps.audioMixer.mixFrameById).toHaveBeenCalledTimes(2));
    harness.setNow(1_500);
    delayedMix.resolve({
      ...harness.mixedAudio,
      frameId: replacement.frame!.frameId,
      frameRevision: replacement.frame!.revision,
      audioData: new Float32Array(3_000),
      sampleRate: 1_000,
      duration: 3,
    });
    await vi.waitFor(() => expect(harness.prepareAudioPlayback).toHaveBeenCalledTimes(2));

    harness.setNow(1_750);
    outputDrain.resolve({ ready: true, waitedForDrain: true });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));
    expect(harness.playAudio.mock.calls[1]?.[0]).toHaveLength(2_250);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);

    harness.getAudioDone(1).resolve();
    await Promise.all([oldHandling, replacementHandling]);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('removes one mixed-frame operator by replacing audio while keeping PTT asserted', async () => {
    const harness = createHarness({ operatorIds: ['operator-a', 'operator-b'] });
    const initialHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacementAudio = {
      ...harness.mixedAudio,
      frameId: 'frame-2',
      frameRevision: 2,
      operatorIds: ['operator-b'],
      audioData: new Float32Array(10_000),
      duration: 10_000 / 12_000,
    };
    harness.setFrameMix('frame-2', 2, replacementAudio);

    const removal = harness.pipeline.removeOperatorFromTransmission('operator-a');
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));

    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.deps.physicalTxCoordinator.getSnapshot()).toMatchObject({
      frameId: 'frame-2',
      operatorIds: ['operator-b'],
      phase: 'active',
      pttConfirmed: true,
    });
    expect(harness.deps.audioMixer.cloneFrameTracks).toHaveBeenCalledWith(
      { frameId: 'frame-1', frameRevision: 1 },
      { frameId: 'frame-2', frameRevision: 2, slotId: 'slot-0' },
      ['operator-b\u0000default'],
    );

    harness.getAudioDone(1).resolve();
    await Promise.all([initialHandling, removal]);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('releases PTT when the last active frame operator is explicitly removed', async () => {
    const harness = createHarness();
    const initialHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    await harness.pipeline.removeOperatorFromTransmission('operator-a');
    await initialHandling;

    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(harness.deps.physicalTxCoordinator.getSnapshot().phase).toBe('idle');
  });

  it('stops shared PTT only after every mixed-frame operator is removed', async () => {
    const harness = createHarness({ operatorIds: ['operator-a', 'operator-b'] });
    const initialHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacementAudio = {
      ...harness.mixedAudio,
      frameId: 'frame-2',
      frameRevision: 2,
      operatorIds: ['operator-b'],
      audioData: new Float32Array(10_000),
      duration: 10_000 / 12_000,
    };
    harness.setFrameMix('frame-2', 2, replacementAudio);

    const removeA = harness.pipeline.removeOperatorFromTransmission('operator-a');
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.deps.physicalTxCoordinator.getSnapshot().operatorIds).toEqual(['operator-b']);

    const removeB = harness.pipeline.removeOperatorFromTransmission('operator-b');
    await Promise.all([initialHandling, removeA, removeB]);

    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(harness.deps.physicalTxCoordinator.getSnapshot().phase).toBe('idle');
  });

  it('hands a starting PTT lease directly to the retained operator mix', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({
      operatorIds: ['operator-a', 'operator-b'],
      pttStart: pttStart.promise,
    });
    const initialHandling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));

    const replacementAudio = {
      ...harness.mixedAudio,
      frameId: 'frame-2',
      frameRevision: 2,
      operatorIds: ['operator-b'],
      audioData: new Float32Array(10_000),
      duration: 10_000 / 12_000,
    };
    harness.setFrameMix('frame-2', 2, replacementAudio);
    const removal = harness.pipeline.removeOperatorFromTransmission('operator-a');
    expect(harness.playAudio).not.toHaveBeenCalled();

    pttStart.resolve();
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.deps.physicalTxCoordinator.getSnapshot()).toMatchObject({
      frameId: 'frame-2',
      operatorIds: ['operator-b'],
      phase: 'active',
    });

    harness.audioDone.resolve();
    await Promise.all([initialHandling, removal]);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('defers without asserting PTT when previous audio cannot be drained', async () => {
    const harness = createHarness();
    harness.prepareAudioPlayback.mockRejectedValueOnce(
      new Error('RtAudio output drain timed out after 20ms'),
    );

    await (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);

    expect(harness.deps.operatorManager.deferPreparedFrameToNextSlot)
      .toHaveBeenCalledWith('frame-1', expect.stringContaining('audio output preparation failed'));
    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
  });

  it('rechecks waveform position and slot budget after a delayed output drain', async () => {
    const outputDrain = deferred<AudioPlaybackReadiness>();
    const harness = createHarness({
      nowMs: 1_000,
      slotEndMs: 3_000,
      expectedDurationMs: 1_000,
      playbackStartMs: 500,
    });
    harness.prepareAudioPlayback.mockReturnValueOnce(outputDrain.promise);

    const handling = (harness.pipeline as any).handleMixedAudioReady(harness.mixedAudio);
    await vi.waitFor(() => expect(harness.prepareAudioPlayback).toHaveBeenCalledOnce());
    harness.setNow(2_500);
    outputDrain.resolve({ ready: true, waitedForDrain: true });
    await handling;

    expect(harness.deps.audioMixer.mixFrameById).toHaveBeenCalledWith('frame-1', 1, 2_000);
    expect(harness.deps.operatorManager.deferPreparedFrameToNextSlot)
      .toHaveBeenCalledWith('frame-1', expect.stringContaining('before PTT start'));
    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
  });

  it('tombstones an old-slot encode without interrupting an active physical lease', async () => {
    const harness = createHarness();
    const leaseId = await harness.deps.physicalTxCoordinator.acquireLease({
      source: 'voice',
      reason: 'voice remains active across slot boundary',
    });
    const completions: Array<Record<string, unknown>> = [];
    harness.deps.engineEmitter.on('transmissionComplete', (event) => completions.push(event));

    await harness.pipeline.onSlotStart({ id: 'slot-2' });
    expect(harness.deps.digitalFrameCoordinator.getFrame('frame-1')).toMatchObject({ phase: 'cancelled' });
    expect(harness.deps.audioMixer.clearFrame).toHaveBeenCalledWith('frame-1', 1);
    expect(harness.deps.audioMixer.clearSlotCache).not.toHaveBeenCalled();
    expect(harness.setPTT).not.toHaveBeenCalledWith(false);

    await (harness.pipeline as any).handleEncodeComplete({
      operatorId: 'operator-a',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      duration: 1,
      request: {
        frameId: 'frame-1',
        frameRevision: 1,
        decisionEpoch: harness.prepared.intents[0].decisionEpoch,
        requestId: 'late-frame-1',
      },
    });
    expect(harness.deps.audioMixer.addOperatorAudio).not.toHaveBeenCalled();
    expect(completions).toEqual([]);
    expect(harness.deps.physicalTxCoordinator.getSnapshot()).toMatchObject({
      leaseId,
      phase: 'active',
    });
    await harness.deps.physicalTxCoordinator.releaseLease(leaseId, 'voice complete');
  });
});
