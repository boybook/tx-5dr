// Characterization tests for lesson TX-33 (docs/proposals/plugin-kernel/ft8-lessons.md):
// the PTT status broadcast follows the physical transmit snapshot, and radio
// polling, spectrum, squelch and physical PTT polling are paused while
// transmitting. DigitalRadioEngine is too heavy to construct here, so the real
// handler runs on a prototype-backed stand-in (same pattern as
// DigitalRadioEngine.mode-switch.test.ts) driven by a real PhysicalTxCoordinator.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { PhysicalTxCoordinator } from '../transmission/PhysicalTxCoordinator.js';
import type { PhysicalTxSnapshot } from '../transmission/TransmissionIntent.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function createEngineStandIn() {
  const emit = vi.fn();
  const engine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
    radioManager: { setPTTActive: vi.fn() },
    spectrumScheduler: { setPTTActive: vi.fn() },
    squelchStatusMonitor: { setPTTActive: vi.fn() },
    physicalPttMonitor: { setSoftwarePttActive: vi.fn() },
    voiceKeyerManager: { setManualPttActive: vi.fn() },
    voiceManualPttActive: false,
    voiceKeyerPttActive: false,
    physicalPttActive: false,
    unifiedVoicePttActive: false,
    _operatorManager: { updateActiveTransmissionOperators: vi.fn() },
    emit,
  });
  const handle = (snapshot: PhysicalTxSnapshot) => (
    (engine as any).handleCoordinatedPhysicalTxChanged(snapshot)
  );
  const pttStatuses = () => emit.mock.calls
    .filter(([event]) => event === 'pttStatusChanged')
    .map(([, payload]) => payload);
  const pausedState = () => ({
    radio: engine.radioManager.setPTTActive.mock.calls.at(-1)?.[0],
    spectrum: engine.spectrumScheduler.setPTTActive.mock.calls.at(-1)?.[0],
    squelch: engine.squelchStatusMonitor.setPTTActive.mock.calls.at(-1)?.[0],
    physicalPttPolling: engine.physicalPttMonitor.setSoftwarePttActive.mock.calls.at(-1)?.[0],
  });
  return { engine, handle, pttStatuses, pausedState };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DigitalRadioEngine coordinated PTT status (TX-33)', () => {
  it('broadcasts transmitting only from the confirmed physical snapshot and pauses pollers for its duration', async () => {
    const standIn = createEngineStandIn();
    const pttStart = deferred<void>();
    const audioDone = deferred<void>();
    const setPTT = vi.fn(async (active: boolean) => {
      if (active) await pttStart.promise;
    });
    let playing = false;
    const coordinator = new PhysicalTxCoordinator({
      isRadioConnected: () => true,
      setPTT,
      playAudio: vi.fn((_data: Float32Array, _rate: number, options?: { onPlaybackStarted?: () => void }) => {
        playing = true;
        options?.onPlaybackStarted?.();
        return audioDone.promise.finally(() => { playing = false; });
      }),
      stopCurrentPlayback: vi.fn(async () => 0),
      prepareAudioPlayback: vi.fn(async () => ({ ready: true, waitedForDrain: false })),
      isAudioPlaying: () => playing,
      now: () => 0,
      sleep: vi.fn(async () => undefined),
    }, { idFactory: () => 'lease-1' });
    coordinator.on('phaseChanged', standIn.handle);

    const transmission = coordinator.transmitAudio({
      source: 'digital',
      frameId: 'frame-1',
      operatorIds: ['operator-a', 'operator-b'],
      reason: 'digital slot frame',
      audioData: new Float32Array(12),
      sampleRate: 12_000,
      playbackKind: 'digital',
      deferActiveUntilAudio: true,
      tailHoldMs: 500,
    });

    // PTT requested but not confirmed: not transmitting, operators not listed,
    // CAT/spectrum/squelch keep running, physical PTT polling already yields.
    await vi.waitFor(() => expect(setPTT).toHaveBeenCalledWith(true));
    expect(standIn.pttStatuses().at(-1)).toMatchObject({
      isTransmitting: false,
      operatorIds: [],
      phase: 'starting',
    });
    expect(standIn.pausedState()).toEqual({
      radio: false,
      spectrum: false,
      squelch: false,
      physicalPttPolling: true,
    });

    pttStart.resolve();
    await vi.waitFor(() => expect(standIn.pttStatuses().at(-1)).toMatchObject({ phase: 'on_air' }));
    expect(standIn.pttStatuses().at(-1)).toEqual({
      isTransmitting: true,
      operatorIds: ['operator-a', 'operator-b'],
      phase: 'on_air',
      frameId: 'frame-1',
      source: 'digital',
    });
    expect(standIn.pausedState()).toEqual({
      radio: true,
      spectrum: true,
      squelch: true,
      physicalPttPolling: true,
    });
    expect(standIn.engine._operatorManager.updateActiveTransmissionOperators)
      .toHaveBeenLastCalledWith(['operator-a', 'operator-b']);

    audioDone.resolve();
    await expect(transmission).resolves.toMatchObject({ success: true });
    expect(standIn.pttStatuses().at(-1)).toMatchObject({
      isTransmitting: false,
      operatorIds: [],
      phase: 'idle',
    });
    expect(standIn.pausedState()).toEqual({
      radio: false,
      spectrum: false,
      squelch: false,
      physicalPttPolling: false,
    });
    expect(standIn.engine._operatorManager.updateActiveTransmissionOperators).toHaveBeenLastCalledWith([]);
    // Every broadcast that claimed transmission came from a PTT-confirmed snapshot.
    const transmittingPhases = standIn.pttStatuses()
      .filter((status) => status.isTransmitting)
      .map((status) => status.phase);
    expect(transmittingPhases.length).toBeGreaterThan(0);
    expect(transmittingPhases).not.toContain('idle');
  });

  it('treats an unknown physical phase as transmitting even without confirmation', () => {
    const standIn = createEngineStandIn();

    standIn.handle({
      leaseId: 'lease-1',
      frameId: 'frame-1',
      source: 'digital',
      operatorIds: ['operator-a'],
      phase: 'unknown',
      epoch: 1,
      playbackGeneration: 1,
      pttConfirmed: false,
    });

    expect(standIn.pttStatuses().at(-1)).toEqual({
      isTransmitting: true,
      operatorIds: ['operator-a'],
      phase: 'unknown',
      frameId: 'frame-1',
      source: 'digital',
    });
    expect(standIn.pausedState()).toEqual({
      radio: true,
      spectrum: true,
      squelch: true,
      physicalPttPolling: true,
    });
  });

  it('lists operators only for digital sources but still pauses pollers for a confirmed voice lease', () => {
    const standIn = createEngineStandIn();

    standIn.handle({
      leaseId: 'lease-voice',
      source: 'voice',
      operatorIds: ['operator-a'],
      phase: 'active',
      epoch: 1,
      playbackGeneration: 0,
      pttConfirmed: true,
    });

    expect(standIn.pttStatuses().at(-1)).toMatchObject({
      isTransmitting: true,
      operatorIds: [],
      phase: 'on_air',
      source: 'voice',
    });
    expect(standIn.pausedState()).toEqual({
      radio: true,
      spectrum: true,
      squelch: true,
      physicalPttPolling: true,
    });
  });
});
