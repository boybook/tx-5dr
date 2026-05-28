import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'eventemitter3';
import { AudioSidecarStatus } from '@tx5dr/contracts';

import { AudioSidecarController } from '../AudioSidecarController.js';
import { AudioRuntimeIssueError, type RtAudioRuntimeIssue } from '../../audio/AudioStreamManager.js';
import { RadioError, RadioErrorCode } from '../../utils/errors/RadioError.js';
import { ConfigManager } from '../../config/config-manager.js';

const mockAudioDeviceManager = vi.hoisted(() => ({
  getOutputDeviceByName: vi.fn(),
}));

const mockProfileManager = vi.hoisted(() => ({
  updateActiveProfileAudioConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../audio/audio-device-manager.js', () => ({
  AudioDeviceManager: {
    getInstance: () => mockAudioDeviceManager,
  },
}));

vi.mock('../../config/ProfileManager.js', () => ({
  ProfileManager: {
    getInstance: () => mockProfileManager,
  },
}));

class FakeAudioStreamManager extends EventEmitter {
  startStream = vi.fn().mockResolvedValue(undefined);
  stopStream = vi.fn().mockResolvedValue(undefined);
  startOutput = vi.fn().mockResolvedValue(undefined);
  stopOutput = vi.fn().mockResolvedValue(undefined);
  applyRuntimeAudioSampleRateOverride = vi.fn();
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

function coreAudioRuntimeLoss(sampleRate = 48000, type = 1): AudioRuntimeIssueError {
  const issue: RtAudioRuntimeIssue = {
    phase: 'runtime',
    direction: 'output',
    deviceName: 'C-Media Electronics Inc.: USB Audio Device',
    backend: 'CoreAudio',
    message: `RtAudio output runtime error (${type}): RtApiCore: the stream device was disconnected (and closed)!`,
    sampleRate,
    bufferSize: 1024,
    elapsedSinceOpenMs: 1500,
    framesConsumed: 0,
    fatal: true,
    runtimeLoss: true,
    type,
    typeName: type === 1 ? 'DEBUG_WARNING' : `UNKNOWN_${type}`,
    at: Date.now(),
  };
  return new AudioRuntimeIssueError(issue);
}

let configManagerMock: any;

describe('AudioSidecarController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    configManagerMock = {
      getAudioConfig: vi.fn(() => ({
        inputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
        outputDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
        inputSampleRate: 48000,
        outputSampleRate: 48000,
      })),
      getRadioConfig: vi.fn(() => ({ type: 'serial', serial: { rigModel: 1049 } })),
      getActiveProfileId: vi.fn(() => 'profile-ft710'),
      updateAudioConfig: vi.fn().mockResolvedValue(undefined),
    };
    mockAudioDeviceManager.getOutputDeviceByName.mockResolvedValue({
      name: 'C-Media Electronics Inc.: USB Audio Device',
      availability: 'available',
    });
    mockProfileManager.updateActiveProfileAudioConfig.mockResolvedValue(undefined);
    vi.spyOn(ConfigManager, 'getInstance').mockReturnValue(configManagerMock);
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

  it('deduplicates repeated runtime errors while tearing down audio', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();
    expect(sidecar.isConnected()).toBe(true);

    audioStreamManager.emit('error', new Error('first device loss'));
    audioStreamManager.emit('error', new Error('duplicate device loss'));
    await flushAsync();

    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.RETRYING);
    expect(audioStreamManager.stopOutput).toHaveBeenCalledTimes(1);
    expect(audioStreamManager.stopStream).toHaveBeenCalledTimes(1);
  });

  it('recovers runtime loss without creating a buffered monitor side path', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();
    expect(audioStreamManager.getAudioProvider).not.toHaveBeenCalled();

    // Simulate runtime loss followed by automatic recovery.
    audioStreamManager.startStream.mockRejectedValueOnce(temporaryDeviceNotFound());
    audioStreamManager.emit('error', new Error('device disappeared'));
    await flushAsync();
    expect(sidecar.getStatus()).toBe(AudioSidecarStatus.RETRYING);

    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    expect(sidecar.isConnected()).toBe(true);
    expect(audioStreamManager.getAudioProvider).not.toHaveBeenCalled();
  });

  it('applies 44.1 kHz runtime fallback for early FT-710/CoreAudio 48 kHz loss and persists after stable reconnect', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const payloads: any[] = [];
    engineEmitter.on('audioSidecarStatusChanged', (payload: any) => payloads.push(payload));

    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();
    expect(sidecar.isConnected()).toBe(true);

    audioStreamManager.emit('error', coreAudioRuntimeLoss(48000, 5));
    await flushAsync();

    expect(audioStreamManager.applyRuntimeAudioSampleRateOverride).toHaveBeenCalledWith({
      inputSampleRate: 44100,
      outputSampleRate: 44100,
      reason: 'early-rtaudio-runtime-loss',
    });
    expect(sidecar.buildStatusPayload()).toMatchObject({
      status: AudioSidecarStatus.RETRYING,
      classification: 'sample-rate-fallback',
      sampleRate: 44100,
      fallback: {
        active: true,
        fromSampleRate: 48000,
        toSampleRate: 44100,
        persisted: false,
      },
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await flushAsync();
    expect(sidecar.isConnected()).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushAsync();

    expect(mockProfileManager.updateActiveProfileAudioConfig).toHaveBeenCalledWith({
      inputSampleRate: 44100,
      outputSampleRate: 44100,
    });
    expect(payloads.at(-1)?.fallback?.persisted).toBe(true);
  });

  it('does not reset retry attempt during reconnect storms before stable connection', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();

    audioStreamManager.emit('error', coreAudioRuntimeLoss(48000));
    await flushAsync();
    expect(sidecar.buildStatusPayload().retryAttempt).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await flushAsync();
    expect(sidecar.isConnected()).toBe(true);

    audioStreamManager.emit('error', coreAudioRuntimeLoss(44100));
    await flushAsync();
    expect(sidecar.buildStatusPayload()).toMatchObject({
      status: AudioSidecarStatus.RETRYING,
      retryAttempt: 2,
      classification: 'sample-rate-fallback-failed',
    });
  });

  it('does not apply sample-rate fallback for runtime loss after a stable connection', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    await sidecar.start();
    await flushAsync();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushAsync();

    audioStreamManager.emit('error', coreAudioRuntimeLoss(48000));
    await flushAsync();

    expect(audioStreamManager.applyRuntimeAudioSampleRateOverride).not.toHaveBeenCalled();
    expect(sidecar.buildStatusPayload()).toMatchObject({
      status: AudioSidecarStatus.RETRYING,
      retryAttempt: 1,
      classification: 'runtime-loss',
    });
  });

  it('keeps failure history when manual retry is requested', async () => {
    const { engineEmitter, audioStreamManager, audioVolumeController } = makeDeps();
    const sidecar = new AudioSidecarController({
      engineEmitter: engineEmitter as any,
      audioStreamManager: audioStreamManager as any,
      audioVolumeController: audioVolumeController as any,
    });

    audioStreamManager.startStream.mockRejectedValueOnce(temporaryDeviceNotFound());
    await sidecar.start();
    await flushAsync();
    expect(sidecar.buildStatusPayload().retryAttempt).toBe(1);

    await sidecar.retryNow();
    await flushAsync();

    expect(audioStreamManager.startStream).toHaveBeenCalledTimes(2);
    expect(sidecar.buildStatusPayload().retryAttempt).toBe(1);
  });
});
