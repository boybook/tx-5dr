import { describe, expect, it } from 'vitest';
import {
  AudioSidecarStatus,
  AudioSidecarStatusPayloadSchema,
} from '../audio-sidecar.schema.js';

describe('AudioSidecarStatusPayloadSchema', () => {
  it('accepts legacy status payloads without diagnostics fields', () => {
    const parsed = AudioSidecarStatusPayloadSchema.parse({
      status: AudioSidecarStatus.RETRYING,
      isConnected: false,
      retryAttempt: 2,
      nextRetryMs: 4000,
      longRunning: false,
      lastError: { message: 'device unavailable' },
      deviceName: 'USB Audio CODEC',
    });

    expect(parsed.classification).toBeUndefined();
  });

  it('accepts runtime diagnostics and fallback details', () => {
    const parsed = AudioSidecarStatusPayloadSchema.parse({
      status: AudioSidecarStatus.RETRYING,
      isConnected: false,
      retryAttempt: 1,
      nextRetryMs: 2000,
      longRunning: false,
      lastError: { message: 'RtApiCore: the stream device was disconnected (and closed)!' },
      deviceName: 'C-Media Electronics Inc.: USB Audio Device',
      phase: 'runtime',
      classification: 'sample-rate-fallback',
      affectedDeviceName: 'C-Media Electronics Inc.: USB Audio Device',
      sampleRate: 44100,
      fallback: {
        active: true,
        fromSampleRate: 48000,
        toSampleRate: 44100,
        persisted: false,
        reason: 'early-rtaudio-runtime-loss',
      },
      retryReason: 'retrying at 44.1 kHz',
    });

    expect(parsed.fallback?.toSampleRate).toBe(44100);
    expect(parsed.classification).toBe('sample-rate-fallback');
  });
});
