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
    },
    audioStreamManager: {
      playAudio: vi.fn(() => audioDone.promise),
      isPlaying: vi.fn(() => false),
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
});
