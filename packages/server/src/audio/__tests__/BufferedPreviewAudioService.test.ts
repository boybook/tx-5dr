import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingBufferAudioProvider } from '../AudioBufferProvider.js';
import { BufferedPreviewAudioService } from '../BufferedPreviewAudioService.js';

const services: BufferedPreviewAudioService[] = [];

afterEach(() => {
  vi.useRealTimers();
  while (services.length > 0) {
    services.pop()?.destroy();
  }
});

describe('BufferedPreviewAudioService', () => {
  it('broadcasts buffered preview audio as fixed 16k frames', async () => {
    vi.useFakeTimers();
    const provider = new RingBufferAudioProvider(12000, 1000);
    const service = new BufferedPreviewAudioService(provider);
    services.push(service);
    const frames: Array<{ audioData: ArrayBuffer; sampleRate: number; samples: number }> = [];

    service.on('audioData', frame => frames.push(frame));
    provider.writeAudio(new Float32Array(240).fill(0.25));

    await vi.advanceTimersByTimeAsync(10);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.sampleRate).toBe(16000);
    expect(frames[0]?.samples).toBe(320);
    expect(new Float32Array(frames[0]?.audioData ?? new ArrayBuffer(0))[0]).toBeCloseTo(0.25);
    expect(service.getLatestStats()?.sampleRate).toBe(16000);
  });
});
