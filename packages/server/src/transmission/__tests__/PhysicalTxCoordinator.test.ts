import { describe, expect, it, vi } from 'vitest';
import { PhysicalTxCoordinator } from '../PhysicalTxCoordinator.js';

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
  pttStop?: Promise<void>;
  pttStopSequence?: Promise<void>[];
  audioStop?: Promise<void>;
  txDialStart?: Promise<unknown>;
  txDialResult?: unknown;
  clearTxDialOffset?: () => Promise<void>;
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  audioPreparation?: Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  let playing = false;
  let pttStopIndex = 0;
  const audioDones = [deferred<void>()];
  let playbackIndex = 0;
  const setPTT = vi.fn(async (active: boolean) => {
    if (active && options.pttStart) await options.pttStart;
    if (!active) {
      const stop = options.pttStopSequence?.[pttStopIndex++] ?? options.pttStop;
      if (stop) await stop;
    }
  });
  const playAudio = vi.fn((_audioData: Float32Array, _sampleRate: number, options?: { onPlaybackStarted?: () => void }) => {
    const audio = audioDones[playbackIndex] ?? (audioDones[playbackIndex] = deferred<void>());
    playbackIndex += 1;
    playing = true;
    options?.onPlaybackStarted?.();
    return audio.promise.finally(() => {
      if (playbackIndex <= 1 || audio === audioDones[playbackIndex - 1]) playing = false;
    });
  });
  const stopCurrentPlayback = vi.fn(async () => {
    if (options.audioStop) await options.audioStop;
    playing = false;
    audioDones[Math.max(0, playbackIndex - 1)].reject(new Error('playback interrupted'));
    return 0;
  });
  const prepareAudioPlayback = vi.fn(async () => options.audioPreparation
    ? options.audioPreparation
    : false);
  const coordinator = new PhysicalTxCoordinator({
    isRadioConnected: () => true,
    setPTT,
    playAudio,
    stopCurrentPlayback,
    prepareAudioPlayback,
    isAudioPlaying: () => playing,
    setTxDialOffset: vi.fn(async () => options.txDialStart
      ? options.txDialStart
      : options.txDialResult),
    clearTxDialOffset: options.clearTxDialOffset ?? vi.fn(async () => undefined),
    now: options.now ?? (() => 0),
    sleep: options.sleep ?? vi.fn(async () => undefined),
  }, {
    idFactory: (() => {
      let id = 0;
      return () => `lease-${++id}`;
    })(),
    operationTimeoutMs: options.operationTimeoutMs ?? 100,
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 100,
  });
  return {
    coordinator,
    setPTT,
    playAudio,
    stopCurrentPlayback,
    prepareAudioPlayback,
    audio: audioDones[0],
    getAudio: (index: number) => audioDones[index] ?? (audioDones[index] = deferred<void>()),
  };
}

function preparedReplacement(
  harness: ReturnType<typeof createHarness>,
  input: {
    frameId: string;
    operatorIds: string[];
    reason: string;
    audioData?: Float32Array;
    sampleRate?: number;
    tailHoldMs?: number;
    slotEndMs?: number;
    waveformStartMs?: number;
  },
) {
  const snapshot = harness.coordinator.getSnapshot();
  return {
    frameId: input.frameId,
    operatorIds: input.operatorIds,
    reason: input.reason,
    playbackKind: 'digital' as const,
    audioData: input.audioData ?? new Float32Array(12),
    sampleRate: input.sampleRate ?? 12_000,
    tailHoldMs: input.tailHoldMs,
    waveformStartMs: input.waveformStartMs ?? 0,
    slotEndMs: input.slotEndMs,
    expectedLeaseEpoch: snapshot.epoch,
    expectedPlaybackGeneration: snapshot.playbackGeneration,
    expectedFrameId: snapshot.frameId,
  };
}

describe('PhysicalTxCoordinator', () => {
  it('fences every physical source while idle maintenance is running', async () => {
    const operation = deferred<void>();
    const harness = createHarness();
    const maintenance = harness.coordinator.runIdleMaintenance(
      { reason: 'scheduled band switch' },
      () => operation.promise,
    );

    await expect(harness.coordinator.acquireLease({ source: 'voice', reason: 'voice PTT' }))
      .rejects.toThrow('maintenance is active');
    expect(harness.setPTT).not.toHaveBeenCalled();

    operation.resolve();
    await maintenance;
    const leaseId = await harness.coordinator.acquireLease({ source: 'manual', reason: 'after maintenance' });
    await harness.coordinator.releaseLease(leaseId, 'done');
  });

  it('rejects background maintenance without interrupting an active lease', async () => {
    const harness = createHarness();
    const leaseId = await harness.coordinator.acquireLease({ source: 'cw', reason: 'CW keyer' });
    const operation = vi.fn(async () => undefined);

    await expect(harness.coordinator.runIdleMaintenance(
      { reason: 'scheduled band switch' },
      operation,
    )).rejects.toThrow('physical transmitter is active');
    expect(operation).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot()).toMatchObject({ leaseId, phase: 'active' });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    await harness.coordinator.releaseLease(leaseId, 'done');
  });

  it('waits for previous output drain before asserting PTT for an audio lease', async () => {
    const audioPreparation = deferred<boolean>();
    const harness = createHarness({ audioPreparation: audioPreparation.promise });

    const transmission = harness.coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-after-drain',
      reason: 'replacement',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.prepareAudioPlayback).toHaveBeenCalledWith('digital'));

    expect(harness.setPTT).not.toHaveBeenCalledWith(true);
    expect(harness.playAudio).not.toHaveBeenCalled();

    audioPreparation.resolve(true);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    harness.audio.resolve();
    await expect(transmission).resolves.toMatchObject({ success: true });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('does not pulse PTT when audio output preparation fails', async () => {
    const audioPreparation = deferred<boolean>();
    const harness = createHarness({ audioPreparation: audioPreparation.promise });
    const transmission = harness.coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-drain-failed',
      reason: 'replacement',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.prepareAudioPlayback).toHaveBeenCalledOnce());
    audioPreparation.reject(new Error('RtAudio output drain timed out after 20ms'));

    await expect(transmission).rejects.toThrow('audio output preparation failed');
    expect(harness.setPTT).not.toHaveBeenCalled();
    expect(harness.playAudio).not.toHaveBeenCalled();
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('publishes active only after PTT is confirmed and audio starts', async () => {
    const harness = createHarness();
    const phases: string[] = [];
    const terminals = vi.fn();
    harness.coordinator.on('phaseChanged', (snapshot) => phases.push(snapshot.phase));
    harness.coordinator.on('terminal', terminals);

    const transmission = harness.coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'slot',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
      tailHoldMs: 500,
    });

    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    expect(phases).toEqual(['starting', 'active']);
    harness.audio.resolve();
    const result = await transmission;

    expect(result).toMatchObject({ success: true, physicalConfirmed: true, frameId: 'frame-1' });
    expect(phases).toEqual(['starting', 'active', 'draining', 'stopping', 'idle']);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(terminals).toHaveBeenCalledTimes(1);
  });

  it('replaces digital audio generations without releasing the physical PTT lease', async () => {
    const harness = createHarness();
    const leaseId = await harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a', 'b'],
      reason: 'mixed frame',
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
    });
    const first = harness.coordinator.playAudioOnLease(leaseId, {
      frameId: 'frame-1',
      operatorIds: ['a', 'b'],
      reason: 'initial audio',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacement = harness.coordinator.replaceAudioOnLease(leaseId, preparedReplacement(harness, {
      frameId: 'frame-2',
      operatorIds: ['b'],
      reason: 'operator a removed',
      audioData: new Float32Array(8),
    }));

    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));
    await expect(first).resolves.toMatchObject({
      success: false,
      frameId: 'frame-1',
      leaseContinues: true,
    });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      leaseId,
      frameId: 'frame-2',
      operatorIds: ['b'],
      phase: 'active',
      pttConfirmed: true,
    });

    harness.getAudio(1).resolve();
    await expect(replacement).resolves.toMatchObject({ success: true, frameId: 'frame-2' });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('drains the stopped output and resynchronizes prepared audio before replacing on the same lease', async () => {
    let nowMs = 1_000;
    const outputDrain = deferred<boolean>();
    const harness = createHarness({ now: () => nowMs });
    const leaseId = await harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'initial audio',
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
    });
    const first = harness.coordinator.playAudioOnLease(leaseId, {
      frameId: 'frame-1',
      operatorIds: ['a'],
      audioData: new Float32Array(12_000),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    harness.prepareAudioPlayback.mockReturnValueOnce(outputDrain.promise);
    const replacement = harness.coordinator.replaceAudioOnLease(leaseId, preparedReplacement(harness, {
      frameId: 'frame-2',
      operatorIds: ['a'],
      reason: 'frequency changed on air',
      audioData: new Float32Array(12_000),
      sampleRate: 12_000,
      waveformStartMs: nowMs,
      slotEndMs: 5_000,
    }));

    await vi.waitFor(() => expect(harness.stopCurrentPlayback).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(harness.prepareAudioPlayback).toHaveBeenCalledTimes(2));
    expect(harness.playAudio).toHaveBeenCalledTimes(1);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);

    nowMs = 1_250;
    outputDrain.resolve(true);
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));
    expect(harness.playAudio.mock.calls[1]?.[0]).toHaveLength(9_000);
    await expect(first).resolves.toMatchObject({ frameId: 'frame-1', leaseContinues: true });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);

    harness.getAudio(1).resolve();
    await expect(replacement).resolves.toMatchObject({ frameId: 'frame-2', success: true });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('releases PTT exactly once when replacement output drain fails after handover commit', async () => {
    const harness = createHarness();
    const terminals = vi.fn();
    harness.coordinator.on('terminal', terminals);
    const leaseId = await harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'initial audio',
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
    });
    const first = harness.coordinator.playAudioOnLease(leaseId, {
      frameId: 'frame-1',
      operatorIds: ['a'],
      audioData: new Float32Array(12_000),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledOnce());

    harness.prepareAudioPlayback.mockRejectedValueOnce(
      new Error('RtAudio output drain timed out after 20ms'),
    );
    const replacement = harness.coordinator.replaceAudioOnLease(leaseId, preparedReplacement(harness, {
      frameId: 'frame-2',
      operatorIds: ['a'],
      reason: 'frequency changed on air',
      audioData: new Float32Array(12_000),
      sampleRate: 12_000,
    }));

    await expect(first).resolves.toMatchObject({ frameId: 'frame-1', leaseContinues: true });
    await expect(replacement).resolves.toMatchObject({
      frameId: 'frame-1',
      success: false,
      error: expect.stringContaining('audio output preparation failed'),
    });
    expect(harness.playAudio).toHaveBeenCalledTimes(1);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(terminals).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('lets a replacement take ownership while the same PTT lease is still starting', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({
      pttStart: pttStart.promise,
      operationTimeoutMs: 5_000,
    });
    const acquiring = harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'slow PTT start',
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
    });
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    const leaseId = harness.coordinator.getSnapshot().leaseId!;
    const replacement = harness.coordinator.replaceAudioOnLease(leaseId, preparedReplacement(harness, {
      frameId: 'frame-2',
      operatorIds: ['a'],
      reason: 'correction arrived during PTT start',
      audioData: new Float32Array(8),
    }));
    expect(harness.playAudio).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(harness.coordinator.getSnapshot()).toMatchObject({
        leaseId,
        frameId: 'frame-1',
        phase: 'starting',
        pttConfirmed: false,
      });
    });

    pttStart.resolve();
    await acquiring;
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      frameId: 'frame-2',
      phase: 'active',
      pttConfirmed: true,
    });

    harness.audio.resolve();
    await expect(replacement).resolves.toMatchObject({ success: true });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('does not start replacement audio after a force interrupt wins during remix', async () => {
    const audioStop = deferred<void>();
    const harness = createHarness({ audioStop: audioStop.promise });
    const leaseId = await harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'initial',
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
    });
    const first = harness.coordinator.playAudioOnLease(leaseId, {
      frameId: 'frame-1',
      operatorIds: ['a'],
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const replacement = harness.coordinator.replaceAudioOnLease(leaseId, preparedReplacement(harness, {
      frameId: 'frame-2',
      operatorIds: ['a'],
      reason: 'handover interrupted after old audio stop began',
      audioData: new Float32Array(8),
    }));
    await vi.waitFor(() => expect(harness.stopCurrentPlayback).toHaveBeenCalled());

    const forced = harness.coordinator.forceInterrupt('emergency during remix');
    audioStop.resolve();

    await expect(first).resolves.toMatchObject({ leaseContinues: true });
    await expect(replacement).resolves.toMatchObject({ success: false });
    await expect(forced).resolves.toMatchObject({ success: false });
    expect(harness.playAudio).toHaveBeenCalledTimes(1);
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('does not let an old tail-hold generation release a replacement generation', async () => {
    const oldTail = deferred<void>();
    let sleepCalls = 0;
    const harness = createHarness({
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) await oldTail.promise;
      },
    });
    const leaseId = await harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      frameRevision: 1,
      operatorIds: ['a'],
      reason: 'initial',
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
    });
    const first = harness.coordinator.playAudioOnLease(leaseId, {
      frameId: 'frame-1',
      frameRevision: 1,
      operatorIds: ['a'],
      reason: 'initial audio',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
      tailHoldMs: 500,
    });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));
    harness.audio.resolve();
    await vi.waitFor(() => expect(harness.coordinator.getSnapshot().phase).toBe('draining'));

    const replacement = harness.coordinator.replaceAudioOnLease(leaseId, preparedReplacement(harness, {
      frameId: 'frame-2',
      operatorIds: ['a'],
      reason: 'replacement during old tail hold',
      audioData: new Float32Array(8),
    }));
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(2));
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.coordinator.getSnapshot()).toMatchObject({
      frameId: 'frame-2',
      playbackGeneration: 2,
      phase: 'active',
    });

    oldTail.resolve();
    await expect(first).resolves.toMatchObject({
      frameId: 'frame-1',
      frameRevision: 1,
      success: false,
      leaseContinues: true,
    });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);
    expect(harness.coordinator.getSnapshot()).toMatchObject({ frameId: 'frame-2', phase: 'active' });

    harness.getAudio(1).resolve();
    await expect(replacement).resolves.toMatchObject({ frameId: 'frame-2', success: true });
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('bounds a playback backend that never acknowledges its first write', async () => {
    const stopCurrentPlayback = vi.fn(async () => 0);
    const setPTT = vi.fn(async (_active: boolean) => undefined);
    const coordinator = new PhysicalTxCoordinator({
      isRadioConnected: () => true,
      setPTT,
      playAudio: vi.fn(() => new Promise<void>(() => undefined)),
      stopCurrentPlayback,
    }, {
      idFactory: () => 'lease-audio-start-timeout',
      operationTimeoutMs: 100,
      audioStartTimeoutMs: 20,
    });

    await expect(coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-audio-start-timeout',
      reason: 'slot',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    })).resolves.toMatchObject({ success: false, physicalConfirmed: true });

    expect(stopCurrentPlayback).toHaveBeenCalledWith({ kind: 'digital' });
    expect(setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
    expect(coordinator.getSnapshot().phase).toBe('idle');
  });

  it('does not let an ordinary stop preempt the protected starting phase', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({ pttStart: pttStart.promise });
    const acquiring = harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'slot',
    });
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));

    expect(harness.coordinator.requestNormalStop('strategy stop')).toBe('deferred');
    expect(harness.setPTT).not.toHaveBeenCalledWith(false);

    pttStart.resolve();
    const leaseId = await acquiring;
    expect(harness.coordinator.getSnapshot().phase).toBe('active');
    await harness.coordinator.releaseLease(leaseId, 'frame complete');
    expect(harness.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('compensates a late PTT start when force interrupt happens during starting', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({ pttStart: pttStart.promise });
    const phases: string[] = [];
    harness.coordinator.on('phaseChanged', (snapshot) => phases.push(snapshot.phase));

    const acquiring = harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['a'],
      reason: 'slot',
    });
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    const forced = harness.coordinator.forceInterrupt('emergency');
    pttStart.resolve();

    await expect(acquiring).rejects.toThrow('interrupted');
    const result = await forced;
    expect(result?.success).toBe(false);
    expect(harness.setPTT.mock.calls.filter(([active]) => !active).length).toBeGreaterThanOrEqual(1);
    expect(phases).not.toContain('active');
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('does not assert PTT after force interrupt wins during pre-start work', async () => {
    const beforeStart = deferred<void>();
    const harness = createHarness();
    const acquiring = harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      reason: 'delayed device preparation',
      beforeStart: () => beforeStart.promise,
    });
    await vi.waitFor(() => expect(harness.coordinator.getSnapshot().phase).toBe('starting'));

    const forced = harness.coordinator.forceInterrupt('shutdown');
    beforeStart.resolve();

    await expect(acquiring).rejects.toThrow('interrupted');
    await forced;
    expect(harness.setPTT).not.toHaveBeenCalledWith(true);
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('keeps a late PTT compensation fenced before allowing the next lease', async () => {
    const pttStart = deferred<void>();
    const pttStop = deferred<void>();
    const harness = createHarness({
      pttStart: pttStart.promise,
      pttStop: pttStop.promise,
      operationTimeoutMs: 250,
    });
    const acquiring = harness.coordinator.acquireLease({
      source: 'digital',
      frameId: 'frame-1',
      reason: 'old frame',
    });
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    const forced = harness.coordinator.forceInterrupt('replace old frame');
    pttStart.resolve();

    await expect(acquiring).rejects.toThrow('interrupted');
    await expect(forced).resolves.toMatchObject({ success: false });
    expect(harness.coordinator.getSnapshot().phase).toBe('unknown');
    await expect(harness.coordinator.acquireLease({ source: 'manual', reason: 'too early' }))
      .rejects.toThrow('busy');

    pttStop.resolve();
    await vi.waitFor(() => expect(harness.coordinator.getSnapshot().phase).toBe('idle'));
    const nextLease = await harness.coordinator.acquireLease({ source: 'manual', reason: 'new lease' });
    expect(harness.setPTT.mock.calls.at(-1)).toEqual([true]);
    await Promise.resolve();
    expect(harness.setPTT.mock.calls.at(-1)).toEqual([true]);
    await harness.coordinator.releaseLease(nextLease, 'done');
  });

  it('continues to PTT-off when source cleanup never settles', async () => {
    const audioStop = deferred<void>();
    const harness = createHarness({ audioStop: audioStop.promise, cleanupTimeoutMs: 20 });
    const transmission = harness.coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-1',
      reason: 'slot',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(harness.playAudio).toHaveBeenCalledTimes(1));

    const result = await harness.coordinator.forceInterrupt('emergency');
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('source cleanup timed out') });
    expect(harness.setPTT).toHaveBeenCalledWith(false);
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
    await expect(harness.coordinator.acquireLease({ source: 'manual', reason: 'too early' }))
      .rejects.toThrow('cleanup is still settling');

    audioStop.resolve();
    harness.audio.resolve();
    await expect(transmission).resolves.toMatchObject({ success: false });
    await vi.waitFor(async () => {
      const leaseId = await harness.coordinator.acquireLease({ source: 'manual', reason: 'cleanup settled' });
      await harness.coordinator.releaseLease(leaseId, 'done');
    });
  });

  it('reports unknown when dial-offset cleanup fails after PTT-off', async () => {
    const harness = createHarness({
      clearTxDialOffset: vi.fn().mockRejectedValue(new Error('CAT cleanup failed')),
    });
    const leaseId = await harness.coordinator.acquireLease({ source: 'manual', reason: 'manual PTT' });
    const result = await harness.coordinator.releaseLease(leaseId, 'manual release');

    expect(result).toMatchObject({ success: false, physicalConfirmed: true });
    expect(result.reason).toContain('TX dial offset cleanup unconfirmed');
    expect(harness.coordinator.getSnapshot().phase).toBe('unknown');
    await expect(harness.coordinator.acquireLease({ source: 'manual', reason: 'unsafe retry' }))
      .rejects.toThrow('physical transmitter is busy');
  });

  it('returns to idle when PTT start rejects and an explicit stop succeeds', async () => {
    const pttStart = deferred<void>();
    const harness = createHarness({ pttStart: pttStart.promise });
    const acquiring = harness.coordinator.acquireLease({ source: 'digital', reason: 'slot' });
    await vi.waitFor(() => expect(harness.setPTT).toHaveBeenCalledWith(true));
    pttStart.reject(new Error('radio rejected PTT'));

    await expect(acquiring).rejects.toThrow('radio rejected PTT');
    expect(harness.setPTT).toHaveBeenCalledWith(false);
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('does not assert PTT when a required dial offset was not applied', async () => {
    const harness = createHarness({ txDialResult: false });

    await expect(harness.coordinator.acquireLease({
      source: 'digital',
      reason: 'shifted frame',
      txDialShiftHz: 681,
    })).rejects.toThrow('TX dial offset was not applied');

    expect(harness.setPTT).not.toHaveBeenCalledWith(true);
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('allows self-keyed leases without a CAT connection', async () => {
    const setPTT = vi.fn(async () => undefined);
    const coordinator = new PhysicalTxCoordinator({
      isRadioConnected: () => false,
      setPTT,
      playAudio: vi.fn(async () => undefined),
      stopCurrentPlayback: vi.fn(async () => 0),
    }, { idFactory: () => 'self-keyed-lease' });

    const leaseId = await coordinator.acquireLease({
      source: 'cw',
      reason: 'serial keyer owns RF',
      assertPtt: false,
    });
    expect(coordinator.getSnapshot()).toMatchObject({ leaseId, phase: 'active', pttConfirmed: false });
    await coordinator.releaseLease(leaseId, 'keyer complete');
    expect(setPTT).not.toHaveBeenCalled();
  });

  it('can retry a failed late dial-offset compensation', async () => {
    const dialStart = deferred<boolean>();
    const clearTxDialOffset = vi.fn()
      .mockRejectedValueOnce(new Error('late compensation failed'))
      .mockResolvedValue(undefined);
    const harness = createHarness({
      txDialStart: dialStart.promise,
      clearTxDialOffset,
      operationTimeoutMs: 50,
    });
    const acquiring = harness.coordinator.acquireLease({
      source: 'digital',
      reason: 'delayed dial setup',
      txDialShiftHz: 681,
    });
    await vi.waitFor(() => expect(harness.coordinator.getSnapshot().phase).toBe('starting'));
    const forced = harness.coordinator.forceInterrupt('shutdown during dial setup');
    dialStart.resolve(true);

    await expect(acquiring).rejects.toThrow('interrupted');
    await expect(forced).resolves.toMatchObject({ success: false });
    expect(harness.coordinator.getSnapshot().phase).toBe('unknown');

    const retryResult = await harness.coordinator.retryUnknownStop('retry dial cleanup');
    expect(retryResult).toMatchObject({ success: false });
    expect(clearTxDialOffset).toHaveBeenCalledTimes(2);
    expect(harness.coordinator.getSnapshot().phase).toBe('idle');
  });

  it('keeps the state unknown when PTT release cannot be confirmed', async () => {
    const pttStop = deferred<void>();
    const harness = createHarness({ pttStop: pttStop.promise });
    const leaseId = await harness.coordinator.acquireLease({
      source: 'manual',
      reason: 'manual PTT',
    });

    const result = await harness.coordinator.releaseLease(leaseId, 'manual release');
    expect(result.success).toBe(false);
    expect(result.error).toContain('PTT stop timed out');
    expect(harness.coordinator.getSnapshot()).toMatchObject({ phase: 'unknown', pttConfirmed: true });
  });

  it('does not let an old audio completion close a newer lease', async () => {
    const first = createHarness();
    const oldTransmission = first.coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-1',
      reason: 'old',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
    });
    await vi.waitFor(() => expect(first.playAudio).toHaveBeenCalledTimes(1));
    await first.coordinator.forceInterrupt('replace complete frame');
    await expect(oldTransmission).resolves.toMatchObject({ success: false });

    const secondLease = await first.coordinator.acquireLease({
      source: 'manual',
      reason: 'new lease',
    });
    expect(first.coordinator.getSnapshot()).toMatchObject({ leaseId: secondLease, phase: 'active' });
    await Promise.resolve();
    expect(first.coordinator.getSnapshot()).toMatchObject({ leaseId: secondLease, phase: 'active' });
    await first.coordinator.releaseLease(secondLease, 'done');
  });
});
