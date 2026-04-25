import { afterEach, describe, expect, it } from 'vitest';
import { RingBufferAudioProvider } from '../AudioBufferProvider.js';
import { AudioMonitorService } from '../AudioMonitorService.js';

const services: AudioMonitorService[] = [];

afterEach(() => {
  while (services.length > 0) {
    services.pop()?.destroy();
  }
});

describe('AudioMonitorService TX monitor injection', () => {
  it('broadcasts injected TX audio without requiring RX ring-buffer data', () => {
    const provider = new RingBufferAudioProvider(12000, 1000);
    const service = new AudioMonitorService(provider);
    services.push(service);
    const frames: Array<{ audioData: ArrayBuffer; sampleRate: number; samples: number }> = [];

    service.on('audioData', frame => frames.push(frame));
    service.injectTxMonitorAudio(new Float32Array(320).fill(0.25), 16000);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.sampleRate).toBe(16000);
    expect(frames[0]?.samples).toBe(320);
    expect(new Float32Array(frames[0]?.audioData ?? new ArrayBuffer(0))[0]).toBeCloseTo(0.25);
    expect(provider.getAvailableMs()).toBe(0);
  });
});
