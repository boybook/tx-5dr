import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { TuneToneController } from '../TuneToneController.js';
import type { RadioTunePort } from '../TuneCarriers.js';
import { PhysicalTxCoordinator } from '../../transmission/PhysicalTxCoordinator.js';
import type { IRadioConnectionEvents } from '../connections/IRadioConnection.js';
import type { TuneToneStatus } from '@tx5dr/contracts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake radio-owned tune function that confirms writes the way TCI state notifications do. */
class FakeRadioTune extends EventEmitter<IRadioConnectionEvents> implements RadioTunePort {
  active = false;
  readonly setRadioTune = vi.fn(async (enabled: boolean) => {
    this.report(enabled);
  });

  report(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.emit('radioTuneChanged', active);
  }
}

function createController(options: { busy?: boolean; connected?: boolean; radioTune?: FakeRadioTune } = {}) {
  const playback = deferred<void>();
  const statuses: TuneToneStatus[] = [];
  const radioManager = {
    isConnected: vi.fn(() => options.connected ?? true),
    setPTT: vi.fn().mockResolvedValue(undefined),
  };
  const audioStreamManager = {
    isPlaying: vi.fn(() => true),
    playAudio: vi.fn(() => playback.promise),
    stopCurrentPlayback: vi.fn().mockResolvedValue(0),
  };
  const physicalTxCoordinator = new PhysicalTxCoordinator({
    isRadioConnected: radioManager.isConnected,
    setPTT: radioManager.setPTT,
    playAudio: audioStreamManager.playAudio,
    stopCurrentPlayback: audioStreamManager.stopCurrentPlayback,
    isAudioPlaying: audioStreamManager.isPlaying,
    sleep: async () => undefined,
  });
  const controller = new TuneToneController({
    radioManager: radioManager as never,
    physicalTxCoordinator,
    isTransmitBusy: () => options.busy ?? false,
    getOperatorToneHz: () => 1234,
    getRadioTune: () => options.radioTune ?? null,
    emitStatus: (status) => statuses.push(status),
  });

  return { controller, radioManager, audioStreamManager, physicalTxCoordinator, statuses, playback };
}

describe('TuneToneController', () => {
  it('starts PTT, plays a generated tone, and emits active status', async () => {
    const { controller, radioManager, audioStreamManager, statuses } = createController();

    await controller.start({ operatorId: 'op1' });

    expect(radioManager.setPTT).toHaveBeenCalledWith(true);
    await vi.waitFor(() => {
      expect(audioStreamManager.playAudio).toHaveBeenCalledWith(
        expect.any(Float32Array),
        12000,
        expect.objectContaining({ injectIntoMonitor: true, playbackKind: 'tune-tone' }),
      );
    });
    expect(statuses[0]).toMatchObject({ active: true, method: 'audio-tone', toneHz: 1234 });
  });

  it('generates the tone at full scale so shared volume gain matches FT8 drive', async () => {
    const { controller, audioStreamManager } = createController();

    await controller.start({ toneHz: 1500 });
    await vi.waitFor(() => {
      expect(audioStreamManager.playAudio).toHaveBeenCalled();
    });

    const [audio, sampleRate] = audioStreamManager.playAudio.mock.calls[0] as unknown as [Float32Array, number];
    expect(sampleRate).toBe(12000);

    let peak = 0;
    let sumSquares = 0;
    for (const sample of audio) {
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
    }
    // WSJT-X encodes FT8 at full scale (peak 1.0, RMS ~0.707). A lower tone
    // source amplitude would sit ~9 dB below the same user volume gain.
    expect(peak).toBeCloseTo(1, 6);
    const rms = Math.sqrt(sumSquares / audio.length);
    // The 20 ms fades trim a few ten-thousandths off the ideal 0.7071; the
    // lower bound still rejects the previous 0.35-peak (~0.247 RMS) source.
    expect(rms).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rms).toBeGreaterThan(0.7);
  });

  it('stops playback and releases PTT idempotently', async () => {
    const { controller, radioManager, audioStreamManager, statuses } = createController();

    await controller.start({ toneHz: 1600 });
    await controller.stop('manual');
    await controller.stop('manual');

    expect(audioStreamManager.stopCurrentPlayback).toHaveBeenCalledWith({ kind: 'tune-tone' });
    expect(radioManager.setPTT).toHaveBeenCalledWith(false);
    expect(statuses[statuses.length - 1]).toMatchObject({ active: false, toneHz: null });
  });

  it('keeps an uncertain PTT release retryable and visible', async () => {
    const { controller, radioManager, statuses } = createController();

    await controller.start({ toneHz: 1600 });
    radioManager.setPTT.mockRejectedValueOnce(new Error('USB write failed'));
    await controller.stop('manual');

    expect(statuses[statuses.length - 1]).toMatchObject({
      active: false,
      error: 'PTT release unconfirmed',
    });

    await controller.stop('manual retry');
    expect(radioManager.setPTT).toHaveBeenLastCalledWith(false);
    expect(statuses[statuses.length - 1]).toMatchObject({ active: false, toneHz: null });
    expect(statuses[statuses.length - 1].error).toBeUndefined();
  });

  it('releases PTT if tune tone playback is interrupted externally', async () => {
    const { controller, radioManager, statuses, playback } = createController();

    await controller.start({ toneHz: 1600 });
    playback.reject(new Error('playback interrupted'));

    await vi.waitFor(() => {
      expect(radioManager.setPTT).toHaveBeenCalledWith(false);
    });

    expect(statuses[statuses.length - 1]).toMatchObject({ active: false, toneHz: null });
  });

  it('rejects start while another transmitter is active', async () => {
    const { controller, radioManager, audioStreamManager } = createController({ busy: true });

    await expect(controller.start()).rejects.toThrow('transmitter is busy');

    expect(radioManager.setPTT).not.toHaveBeenCalled();
    expect(audioStreamManager.playAudio).not.toHaveBeenCalled();
  });
});

describe('TuneToneController with a radio-owned tune function', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the radio tune as the next method while idle', () => {
    const { controller } = createController({ radioTune: new FakeRadioTune() });

    expect(controller.getStatus()).toMatchObject({ active: false, method: 'radio-tune', toneHz: null });
  });

  it('keys the radio tune under a self-keyed lease without PTT or audio', async () => {
    const radioTune = new FakeRadioTune();
    const { controller, radioManager, audioStreamManager, physicalTxCoordinator, statuses } = createController({ radioTune });

    await controller.start({ toneHz: 1600 });

    expect(radioTune.setRadioTune).toHaveBeenCalledWith(true);
    expect(radioManager.setPTT).not.toHaveBeenCalled();
    expect(audioStreamManager.playAudio).not.toHaveBeenCalled();
    expect(physicalTxCoordinator.getSnapshot()).toMatchObject({ source: 'tune-tone', phase: 'active', pttConfirmed: true });
    expect(statuses[0]).toMatchObject({ active: true, method: 'radio-tune', toneHz: null });
  });

  it('switches the radio tune off through the lease interrupt on stop', async () => {
    const radioTune = new FakeRadioTune();
    const { controller, physicalTxCoordinator, statuses } = createController({ radioTune });

    await controller.start();
    await controller.stop('manual');

    expect(radioTune.setRadioTune).toHaveBeenLastCalledWith(false);
    expect(radioTune.active).toBe(false);
    expect(physicalTxCoordinator.getSnapshot().phase).toBe('idle');
    expect(statuses.at(-1)).toMatchObject({ active: false, method: 'radio-tune' });
    expect(statuses.at(-1)?.error).toBeUndefined();
  });

  it('ends the session when the radio switches its tune off', async () => {
    const radioTune = new FakeRadioTune();
    const { controller, physicalTxCoordinator, statuses } = createController({ radioTune });

    await controller.start();
    radioTune.report(false);

    await vi.waitFor(() => {
      expect(physicalTxCoordinator.getSnapshot().phase).toBe('idle');
    });
    expect(statuses.at(-1)).toMatchObject({ active: false });
    expect(radioTune.active).toBe(false);
  });

  it('switches the radio tune off when the maximum duration elapses', async () => {
    vi.useFakeTimers();
    const radioTune = new FakeRadioTune();
    const { controller, physicalTxCoordinator, statuses } = createController({ radioTune });

    await controller.start();
    await vi.advanceTimersByTimeAsync(controller.getStatus().maxDurationMs);

    expect(radioTune.setRadioTune).toHaveBeenLastCalledWith(false);
    expect(radioTune.active).toBe(false);
    expect(physicalTxCoordinator.getSnapshot().phase).toBe('idle');
    expect(statuses.at(-1)).toMatchObject({ active: false });
  });

  it('compensates an unconfirmed radio tune start with an OFF', async () => {
    const radioTune = new FakeRadioTune();
    radioTune.setRadioTune.mockRejectedValueOnce(new Error('TUNE not confirmed'));
    const { controller, physicalTxCoordinator, statuses } = createController({ radioTune });

    await expect(controller.start()).rejects.toThrow('TUNE not confirmed');

    expect(radioTune.setRadioTune).toHaveBeenLastCalledWith(false);
    expect(physicalTxCoordinator.getSnapshot().phase).toBe('idle');
    expect(statuses.at(-1)).toMatchObject({ active: false, error: 'TUNE not confirmed' });
  });

  it('surfaces an unconfirmed radio tune release', async () => {
    const radioTune = new FakeRadioTune();
    const { controller, statuses } = createController({ radioTune });

    await controller.start();
    radioTune.setRadioTune.mockRejectedValueOnce(new Error('TUNE OFF not confirmed'));
    await controller.stop('manual');

    expect(statuses.at(-1)).toMatchObject({ active: false, error: 'TUNE OFF not confirmed' });
  });
});
