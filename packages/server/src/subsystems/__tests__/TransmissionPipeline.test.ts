import { EventEmitter } from 'eventemitter3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TransmissionPipeline } from '../TransmissionPipeline.js';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPipeline(configType: 'icom-wlan' | 'hamlib') {
  const engineEmitter = new EventEmitter();
  const audioDone = createDeferred<void>();
  const setPTT = vi.fn<[boolean], Promise<void>>(async () => undefined);

  const deps = {
    engineEmitter,
    audioMixer: {
      markPlaybackStart: vi.fn(),
      markPlaybackStop: vi.fn(),
      clearSlotCache: vi.fn(),
    },
    audioStreamManager: {
      playAudio: vi.fn(() => audioDone.promise),
      isPlaying: vi.fn(() => false),
      getCurrentPlaybackKind: vi.fn<[], 'digital' | 'voice-keyer' | 'tune-tone' | null>(() => null),
      stopCurrentPlayback: vi.fn(),
    },
    radioManager: {
      isConnected: vi.fn(() => true),
      setPTT,
      setPTTActive: vi.fn(),
      getConfig: vi.fn(() => ({ type: configType })),
    },
    spectrumScheduler: {
      setPTTActive: vi.fn(),
    },
    transmissionTracker: {
      recordMixedAudioReady: vi.fn(),
      recordPTTStart: vi.fn(),
      recordAudioPlaybackStart: vi.fn(),
    },
    encodeQueue: new EventEmitter(),
    operatorManager: {
      updateActiveTransmissionOperators: vi.fn(),
    },
    clockSource: {
      now: vi.fn(() => Date.now()),
    },
    getCurrentMode: vi.fn(() => ({ name: 'FT8', slotMs: 15000, transmitTiming: 500 })),
    getCompensationMs: vi.fn(() => 0),
    onBeforeStartPTT: vi.fn().mockResolvedValue(undefined),
  };

  const pipeline = new TransmissionPipeline(deps as never);
  const mixedAudio = {
    operatorIds: ['operator-a'],
    audioData: new Float32Array(12000),
    sampleRate: 12000,
    duration: 1,
  };

  return { pipeline, deps, audioDone, mixedAudio };
}

describe('TransmissionPipeline PTT release timing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops ICOM WLAN PTT as soon as the paced audio write resolves', async () => {
    vi.useFakeTimers();
    const { pipeline, deps, audioDone, mixedAudio } = createPipeline('icom-wlan');

    const handling = (pipeline as unknown as {
      handleMixedAudioReady: (mixedAudio: unknown) => Promise<void>;
    }).handleMixedAudioReady(mixedAudio);

    await vi.waitFor(() => {
      expect(deps.radioManager.setPTT).toHaveBeenCalledWith(true);
    });

    audioDone.resolve();
    await handling;

    expect(deps.radioManager.setPTT.mock.calls.map(([active]) => active)).toEqual([true, false]);
  });

  it('keeps Hamlib on the existing post-audio hold path', async () => {
    vi.useFakeTimers();
    const { pipeline, deps, audioDone, mixedAudio } = createPipeline('hamlib');

    const handling = (pipeline as unknown as {
      handleMixedAudioReady: (mixedAudio: unknown) => Promise<void>;
    }).handleMixedAudioReady(mixedAudio);

    await vi.waitFor(() => {
      expect(deps.radioManager.setPTT).toHaveBeenCalledWith(true);
    });

    audioDone.resolve();
    await handling;

    expect(deps.radioManager.setPTT.mock.calls.map(([active]) => active)).toEqual([true]);

    await pipeline.forceStopPTT();
  });

  it('does not stop tune tone playback at slot boundaries', async () => {
    const { pipeline, deps } = createPipeline('hamlib');
    deps.audioStreamManager.isPlaying.mockReturnValue(true);
    deps.audioStreamManager.getCurrentPlaybackKind.mockReturnValue('tune-tone');

    await pipeline.onSlotStart();

    expect(deps.audioStreamManager.stopCurrentPlayback).not.toHaveBeenCalled();
    expect(deps.audioMixer.clearSlotCache).toHaveBeenCalled();
  });

  it('stops tune tone before starting digital PTT and playback', async () => {
    const { pipeline, deps, audioDone, mixedAudio } = createPipeline('hamlib');
    const cleanup = createDeferred<void>();
    deps.onBeforeStartPTT.mockReturnValueOnce(cleanup.promise);

    const handling = (pipeline as unknown as {
      handleMixedAudioReady: (mixedAudio: unknown) => Promise<void>;
    }).handleMixedAudioReady(mixedAudio);

    await vi.waitFor(() => {
      expect(deps.onBeforeStartPTT).toHaveBeenCalled();
    });
    expect(deps.radioManager.setPTT).not.toHaveBeenCalled();
    expect(deps.audioStreamManager.playAudio).not.toHaveBeenCalled();

    cleanup.resolve();
    await vi.waitFor(() => {
      expect(deps.radioManager.setPTT).toHaveBeenCalledWith(true);
      expect(deps.audioStreamManager.playAudio).toHaveBeenCalled();
    });

    audioDone.resolve();
    await handling;
    await pipeline.forceStopPTT();
  });
});
