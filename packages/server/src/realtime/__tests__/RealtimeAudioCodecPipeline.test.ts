import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRealtimeAudioFrame, isRealtimeEncodedAudioFrame } from '@tx5dr/core';
import type { ResolvedRealtimeAudioCodecPolicy } from '@tx5dr/contracts';
import {
  RealtimeDownlinkAudioEncoder,
  RealtimeOpusCodecService,
  resolveRealtimeAudioCodecPolicy,
} from '../RealtimeAudioCodecPipeline.js';
import type { RealtimeAudioFrame } from '../RealtimeRxAudioSource.js';

const opusCtlCalls = vi.hoisted(() => [] as Array<{ ctl: number; value: number }>);

vi.mock('@discordjs/opus', () => ({
  default: {
    OpusEncoder: class {
      constructor(
        public readonly rate: number,
        public readonly channels: number,
      ) {}

      setBitrate(): void {}

      applyEncoderCTL(ctl: number, value: number): void {
        opusCtlCalls.push({ ctl, value });
      }

      encode(buf: Buffer): Buffer {
        return Buffer.from([this.rate & 0xff, this.channels & 0xff, buf.length & 0xff]);
      }

      decode(): Buffer {
        return Buffer.alloc(0);
      }
    },
  },
  OpusEncoder: class {
    constructor(
      public readonly rate: number,
      public readonly channels: number,
    ) {}

    setBitrate(): void {}

    applyEncoderCTL(ctl: number, value: number): void {
      opusCtlCalls.push({ ctl, value });
    }

    encode(buf: Buffer): Buffer {
      return Buffer.from([this.rate & 0xff, this.channels & 0xff, buf.length & 0xff]);
    }

    decode(): Buffer {
      return Buffer.alloc(0);
    }
  },
}));

const OPUS_POLICY: ResolvedRealtimeAudioCodecPolicy = {
  preference: 'auto',
  resolvedCodec: 'opus',
  fallbackReason: null,
  codecSampleRate: null,
  bitrateBps: 32_000,
  frameDurationMs: 10,
};

const PCM_POLICY: ResolvedRealtimeAudioCodecPolicy = {
  preference: 'pcm',
  resolvedCodec: 'pcm-s16le',
  fallbackReason: 'client-forced-pcm',
  codecSampleRate: null,
  bitrateBps: null,
  frameDurationMs: null,
};

function makeFrame(overrides: Partial<RealtimeAudioFrame> = {}): RealtimeAudioFrame {
  return {
    samples: new Float32Array(480).fill(0.1),
    sampleRate: 48_000,
    channels: 1,
    timestamp: 1234,
    sequence: 0,
    sourceKind: 'native-radio',
    nativeSourceKind: 'audio-device',
    ...overrides,
  };
}

describe('RealtimeAudioCodecPipeline', () => {
  beforeEach(() => {
    opusCtlCalls.length = 0;
  });

  it('pins Opus downlink to a client-supported rate when native source rates are not all supported', () => {
    const policy = resolveRealtimeAudioCodecPolicy({
      scope: 'radio',
      direction: 'recv',
      preference: 'auto',
      serverOpusAvailable: true,
      capabilities: {
        opus: {
          decode: true,
          decodeSampleRates: [48_000],
        },
      },
    });

    expect(policy).toMatchObject({
      resolvedCodec: 'opus',
      codecSampleRate: 48_000,
    });
  });

  it('encodes Opus downlink frames at native 48k without PCM decimation', async () => {
    await expect(RealtimeOpusCodecService.getInstance().isAvailable()).resolves.toBe(true);

    const encoder = new RealtimeDownlinkAudioEncoder(OPUS_POLICY);
    const packets = encoder.encodeSourceFrame(makeFrame());

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      codec: 'opus',
      sourceSampleRate: 48_000,
      codecSampleRate: 48_000,
      samplesPerChannel: 480,
      frameDurationMs: 10,
    });
    expect(opusCtlCalls).toContainEqual({ ctl: 4000, value: 2051 });

    const decoded = decodeRealtimeAudioFrame(packets[0]!.payload);
    expect(isRealtimeEncodedAudioFrame(decoded)).toBe(true);
    if (isRealtimeEncodedAudioFrame(decoded)) {
      expect(decoded.sourceSampleRate).toBe(48_000);
      expect(decoded.codecSampleRate).toBe(48_000);
      expect(decoded.samplesPerChannel).toBe(480);
    }
  });

  it('preserves native ICOM 12k Opus downlink frames', async () => {
    await expect(RealtimeOpusCodecService.getInstance().isAvailable()).resolves.toBe(true);

    const encoder = new RealtimeDownlinkAudioEncoder(OPUS_POLICY);
    const packets = encoder.encodeSourceFrame(makeFrame({
      samples: new Float32Array(120).fill(0.2),
      sampleRate: 12_000,
      nativeSourceKind: 'icom-wlan',
    }));

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      codec: 'opus',
      sourceSampleRate: 12_000,
      codecSampleRate: 12_000,
      samplesPerChannel: 120,
      frameDurationMs: 10,
    });
  });

  it('keeps PCM fallback on the existing 48k to 24k transport decimator', () => {
    const encoder = new RealtimeDownlinkAudioEncoder(PCM_POLICY);
    const packets = encoder.encodeSourceFrame(makeFrame());

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      codec: 'pcm-s16le',
      sourceSampleRate: 48_000,
      codecSampleRate: 24_000,
      samplesPerChannel: 240,
    });
  });
});
