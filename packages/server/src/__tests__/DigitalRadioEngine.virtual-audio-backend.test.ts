import { describe, expect, it, vi } from 'vitest';
import type {
  AudioPlaybackReadiness,
  PlaybackKind,
  PlayAudioOptions,
  StopPlaybackOptions,
} from '../audio/AudioStreamManager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { VirtualRadioSession } from '../virtual-radio/VirtualRadioSession.js';

interface TestAudioBackend {
  playAudio(audioData: Float32Array, sampleRate: number, options?: PlayAudioOptions): Promise<void>;
  stopCurrentPlayback(options?: StopPlaybackOptions): Promise<number>;
  prepareAudioPlayback(kind: PlaybackKind): Promise<AudioPlaybackReadiness>;
  getAudioPlaybackReadiness(kind: PlaybackKind): AudioPlaybackReadiness;
  isPlaying(kind?: PlaybackKind): boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function audioBackend(): TestAudioBackend {
  return {
    playAudio: vi.fn(async () => undefined),
    stopCurrentPlayback: vi.fn(async () => 0),
    prepareAudioPlayback: vi.fn(async () => ({ ready: true, waitedForDrain: false })),
    getAudioPlaybackReadiness: vi.fn(() => ({ ready: true, waitedForDrain: false })),
    isPlaying: vi.fn(() => false),
  };
}

describe('DigitalRadioEngine virtual audio backend binding', () => {
  it('keeps late playback cleanup on the virtual backend until that session fully stops', async () => {
    const physical = audioBackend();
    const virtual = audioBackend();
    const stopGate = deferred();
    const stop = vi.fn(() => stopGate.promise);
    const virtualSession = { ...virtual, stop } as unknown as VirtualRadioSession;
    const engine = Object.assign(Object.create(DigitalRadioEngine.prototype), {
      audioStreamManager: physical,
      physicalTxAudioBackend: virtualSession,
      virtualRadioSession: virtualSession,
      virtualRadioSessionStopPromise: null,
    });
    const stopVirtualRadioSession = (DigitalRadioEngine.prototype as unknown as {
      stopVirtualRadioSession(reason: string): Promise<void>;
    }).stopVirtualRadioSession.bind(engine);

    const stopping = stopVirtualRadioSession('Profile changed');
    await Promise.resolve();

    const backendDuringStop = engine.physicalTxAudioBackend as TestAudioBackend;
    await backendDuringStop.stopCurrentPlayback({ kind: 'digital' });
    expect(virtual.stopCurrentPlayback).toHaveBeenCalledWith({ kind: 'digital' });
    expect(physical.stopCurrentPlayback).not.toHaveBeenCalled();

    const duplicateStop = stopVirtualRadioSession('duplicate stop');
    expect(stop).toHaveBeenCalledOnce();

    stopGate.resolve();
    await Promise.all([stopping, duplicateStop]);
    expect(engine.physicalTxAudioBackend).toBe(physical);
  });
});
