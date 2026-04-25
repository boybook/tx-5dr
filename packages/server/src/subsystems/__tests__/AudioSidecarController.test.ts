import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { AudioSidecarStatus } from '@tx5dr/contracts';

vi.mock('../../audio/AudioMonitorService.js', () => ({
  AudioMonitorService: class {
    constructor(_provider: unknown) {}
    destroy = vi.fn();
    injectTxMonitorAudio = vi.fn();
  },
}));

import { AudioSidecarController } from '../AudioSidecarController.js';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import { ConfigManager } from '../../config/config-manager.js';

class FakeAudioStreamManager extends EventEmitter {
  startStream = vi.fn().mockResolvedValue(undefined);
  stopStream = vi.fn().mockResolvedValue(undefined);
  startOutput = vi.fn().mockResolvedValue(undefined);
  stopOutput = vi.fn().mockResolvedValue(undefined);
  getAudioProvider = vi.fn().mockReturnValue({
    getSampleRate: () => 12000,
    getAvailableMs: () => 0,
    readAudio: vi.fn().mockReturnValue(new Float32Array(0)),
    getInternalSampleRate: () => 12000,
    registerConsumer: vi.fn(),
    unregisterConsumer: vi.fn(),
  });
}

async function flushAsync(): Promise<void> {
  // Drain any fire-and-forget promises without advancing fake timers.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function makeDeps() {
  const engineEmitter = new EventEmitter();
  const audioStreamManager = new FakeAudioStreamManager();
  const audioVolumeController = {
    restoreGainForCurrentSlot: vi.fn(),
  };
  return { engineEmitter, audioStreamManager, audioVolumeController };
}

function temporaryDeviceNotFound(): RadioError {
  return new RadioError({
    code: RadioErrorCode.DEVICE_NOT_FOUND,
    message: 'Device not found: usb-codec',
    userMessage: 'Audio device not found',
    context: { temporaryUnavailable: true, recoverable: true },
  });
}

describe('AudioSidecarController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue({
      getAudioConfig: () => ({ inputDeviceName: 'usb-codec' }),
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('goes from idle → connecting → connected and emits status events', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const events: any[] = [];
    engineEmitter.on('audioSidecarStatusChanged', (payload: any) => events.push(payload.status));

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    // Allow the fire-and-forget attemptStart promise chain to flush.
    await flushAsync();

    expect(events[0]).toBe(AudioSidecarStatus.CONNECTING);
    expect(events[events.length - 1]).toBe(AudioSidecarStatus.CONNECTED);
    expect(sidecar.isConnected()).toBe(true);
    expect(audioStreamManager.startStream).toHaveBeenCalledTimes(1);
    expect(audioStreamManager.startOutput).toHaveBeenCalledTimes(1);
    expect(audioVolumeController.restoreGainForCurrentSlot).toHaveBeenCalled();
  });

  it('retries on temporary DEVICE_NOT_FOUND with exponential backoff until success', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const statuses: string[] = [];
    engineEmitter.on('audioSidecarStatusChanged', (payload: any) =>
      statuses.push(payload.status),
    );

    audioStreamManager.startStream
      .mockRejectedValueOnce(temporaryDeviceNotFound())
      .mockRejectedValueOnce(temporaryDeviceNotFound())
      .mockResolvedValueOnce(undefined);

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();

    // First attempt failed → retrying
    expect(statuses).toContain(AudioSidecarStatus.RETRYING);

    // Advance until all retries drain
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(audioStreamManager.startStream).toHaveBeenCalledTimes(3);
    expect(sidecar.isConnected()).toBe(true);
    expect(statuses[statuses.length - 1]).toBe(AudioSidecarStatus.CONNECTED);
  });

  it('enters disabled on unrecoverable errors (MISSING_CONFIG)', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();

    audioStreamManager.startStream.mockRejectedValueOnce(
      new RadioError({
        code: RadioErrorCode.MISSING_CONFIG,
        message: 'No audio device configured',
      }),
    );

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();

    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.DISABLED);
    expect(audioStreamManager.startStream).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels pending retries and transitions to idle', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    audioStreamManager.startStream.mockRejectedValue(temporaryDeviceNotFound());

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();

    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.RETRYING);

    await sidecar.stop('test');
    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.IDLE);

    const callsBeforeFlush = audioStreamManager.startStream.mock.calls.length;
    // Fast-forward — no further retries should happen after stop.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(audioStreamManager.startStream.mock.calls.length).toBe(callsBeforeFlush);
  });

  it('transitions connected → retrying when audioStreamManager emits runtime error', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const statuses: string[] = [];
    engineEmitter.on('audioSidecarStatusChanged', (payload: any) =>
      statuses.push(payload.status),
    );

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();
    expect(sidecar.isConnected()).toBe(true);

    audioStreamManager.startStream.mockRejectedValue(temporaryDeviceNotFound());
    audioStreamManager.emit('error', new Error('device disappeared'));
    await flushAsync();

    expect(statuses).toContain(AudioSidecarStatus.RETRYING);
    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.RETRYING);
  });

  it('keeps the same AudioMonitorService instance across runtime loss + recovery', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();
    const firstMonitor = sidecar.getAudioMonitorService();
    expect(firstMonitor).not.toBeNull();

    // Simulate runtime loss followed by automatic recovery.
    audioStreamManager.startStream.mockRejectedValueOnce(temporaryDeviceNotFound());
    audioStreamManager.emit('error', new Error('device disappeared'));
    await flushAsync();
    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.RETRYING);
    expect(sidecar.getAudioMonitorService()).toBe(firstMonitor);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    expect(sidecar.isConnected()).toBe(true);
    // Downstream consumers subscribed to firstMonitor must still be bound to
    // the live instance after recovery.
    expect(sidecar.getAudioMonitorService()).toBe(firstMonitor);
  });

  it('forwards TX monitor audio chunks to the monitor side path without replacing the monitor', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();

    const monitor = sidecar.getAudioMonitorService() as any;
    const samples = new Float32Array([0.1, -0.1, 0.2]);
    audioStreamManager.emit('txMonitorAudioData', { samples, sampleRate: 16000 });

    expect(monitor.injectTxMonitorAudio).toHaveBeenCalledWith(samples, 16000);
  });
});
