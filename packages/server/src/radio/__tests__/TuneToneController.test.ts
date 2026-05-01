import { describe, expect, it, vi } from 'vitest';
import { TuneToneController } from '../TuneToneController.js';
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

function createController(options: { busy?: boolean; connected?: boolean } = {}) {
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
  const setSoftwarePttActive = vi.fn();
  const controller = new TuneToneController({
    radioManager: radioManager as never,
    audioStreamManager: audioStreamManager as never,
    isTransmitBusy: () => options.busy ?? false,
    getOperatorToneHz: () => 1234,
    setSoftwarePttActive,
    emitStatus: (status) => statuses.push(status),
  });

  return { controller, radioManager, audioStreamManager, setSoftwarePttActive, statuses, playback };
}

describe('TuneToneController', () => {
  it('starts PTT, plays a generated tone, and emits active status', async () => {
    const { controller, radioManager, audioStreamManager, setSoftwarePttActive, statuses } = createController();

    await controller.start({ operatorId: 'op1' });

    expect(radioManager.setPTT).toHaveBeenCalledWith(true);
    expect(setSoftwarePttActive).toHaveBeenCalledWith(true);
    expect(audioStreamManager.playAudio).toHaveBeenCalledWith(
      expect.any(Float32Array),
      12000,
      expect.objectContaining({ injectIntoMonitor: true, playbackKind: 'tune-tone' }),
    );
    expect(statuses[0]).toMatchObject({ active: true, toneHz: 1234 });
  });

  it('stops playback and releases PTT idempotently', async () => {
    const { controller, radioManager, audioStreamManager, setSoftwarePttActive, statuses } = createController();

    await controller.start({ toneHz: 1600 });
    await controller.stop('manual');
    await controller.stop('manual');

    expect(audioStreamManager.stopCurrentPlayback).toHaveBeenCalledWith({ kind: 'tune-tone' });
    expect(radioManager.setPTT).toHaveBeenCalledWith(false);
    expect(setSoftwarePttActive).toHaveBeenLastCalledWith(false);
    expect(statuses[statuses.length - 1]).toMatchObject({ active: false, toneHz: null });
  });

  it('releases PTT if tune tone playback is interrupted externally', async () => {
    const { controller, radioManager, setSoftwarePttActive, statuses, playback } = createController();

    await controller.start({ toneHz: 1600 });
    playback.reject(new Error('playback interrupted'));

    await vi.waitFor(() => {
      expect(radioManager.setPTT).toHaveBeenCalledWith(false);
    });

    expect(setSoftwarePttActive).toHaveBeenLastCalledWith(false);
    expect(statuses[statuses.length - 1]).toMatchObject({ active: false, toneHz: null });
  });

  it('rejects start while another transmitter is active', async () => {
    const { controller, radioManager, audioStreamManager } = createController({ busy: true });

    await expect(controller.start()).rejects.toThrow('transmitter is busy');

    expect(radioManager.setPTT).not.toHaveBeenCalled();
    expect(audioStreamManager.playAudio).not.toHaveBeenCalled();
  });
});
