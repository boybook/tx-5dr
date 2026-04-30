import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeRealtimeAudioFrame, encodeRealtimeEncodedAudioFrame, isRealtimeEncodedAudioFrame } from '@tx5dr/core';
import type { ResolvedRealtimeAudioCodecPolicy } from '@tx5dr/contracts';
import {
  RealtimeDownlinkAudioEncoder,
  RealtimeOpusCodecService,
  RealtimeUplinkAudioDecoder,
  resolveRealtimeAudioCodecPolicy,
} from '../RealtimeAudioCodecPipeline.js';
import type { RealtimeAudioFrame } from '../RealtimeRxAudioSource.js';

const opusCtlCalls = vi.hoisted(() => [] as Array<{ ctl: number; value: number }>);
const opusDecodeCalls = vi.hoisted(() => [] as number[]);
const opusDecodeBehavior = vi.hoisted(() => ({ plcThrows: false, plcEmpty: false }));
const makeDecodedOpusPcm = vi.hoisted(() => (value: number): Buffer => {
  const pcm = new Int16Array(960);
  pcm.fill(value);
  return Buffer.from(pcm.buffer);
});

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

      decode(buffer: Buffer): Buffer {
        opusDecodeCalls.push(buffer.length);
        if (buffer.length === 0 && opusDecodeBehavior.plcThrows) {
          throw new Error('mock plc failure');
        }
        if (buffer.length === 0 && opusDecodeBehavior.plcEmpty) {
          return Buffer.alloc(0);
        }
        return makeDecodedOpusPcm(buffer.length === 0 ? 1000 : 2000);
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

    decode(buffer: Buffer): Buffer {
      opusDecodeCalls.push(buffer.length);
      if (buffer.length === 0 && opusDecodeBehavior.plcThrows) {
        throw new Error('mock plc failure');
      }
      if (buffer.length === 0 && opusDecodeBehavior.plcEmpty) {
        return Buffer.alloc(0);
      }
      return makeDecodedOpusPcm(buffer.length === 0 ? 1000 : 2000);
    }
  },
}));

const OPUS_POLICY: ResolvedRealtimeAudioCodecPolicy = {
  preference: 'auto',
  resolvedCodec: 'opus',
  fallbackReason: null,
  codecSampleRate: null,
  bitrateBps: 32_000,
  frameDurationMs: 20,
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
    samples: new Float32Array(960).fill(0.1),
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
    opusDecodeCalls.length = 0;
    opusDecodeBehavior.plcThrows = false;
    opusDecodeBehavior.plcEmpty = false;
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
      samplesPerChannel: 960,
      frameDurationMs: 20,
    });
    expect(opusCtlCalls).toContainEqual({ ctl: 4000, value: 2051 });

    const decoded = decodeRealtimeAudioFrame(packets[0]!.payload);
    expect(isRealtimeEncodedAudioFrame(decoded)).toBe(true);
    if (isRealtimeEncodedAudioFrame(decoded)) {
      expect(decoded.sourceSampleRate).toBe(48_000);
      expect(decoded.codecSampleRate).toBe(48_000);
      expect(decoded.samplesPerChannel).toBe(960);
    }
  });

  it('preserves native ICOM 12k Opus downlink frames', async () => {
    await expect(RealtimeOpusCodecService.getInstance().isAvailable()).resolves.toBe(true);

    const encoder = new RealtimeDownlinkAudioEncoder(OPUS_POLICY);
    const packets = encoder.encodeSourceFrame(makeFrame({
      samples: new Float32Array(240).fill(0.2),
      sampleRate: 12_000,
      nativeSourceKind: 'icom-wlan',
    }));

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      codec: 'opus',
      sourceSampleRate: 12_000,
      codecSampleRate: 12_000,
      samplesPerChannel: 240,
      frameDurationMs: 20,
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
      samplesPerChannel: 480,
      frameDurationMs: 20,
    });
  });

  it('coalesces 10ms PCM source frames into 20ms transport packets', () => {
    const encoder = new RealtimeDownlinkAudioEncoder(PCM_POLICY);
    expect(encoder.encodeSourceFrame(makeFrame({
      samples: new Float32Array(480).fill(0.1),
      timestamp: 2000,
    }))).toHaveLength(0);

    const packets = encoder.encodeSourceFrame(makeFrame({
      samples: new Float32Array(480).fill(0.1),
      timestamp: 2010,
    }));

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      codec: 'pcm-s16le',
      codecSampleRate: 24_000,
      samplesPerChannel: 480,
      frameDurationMs: 20,
      timestampMs: 2000,
    });
  });

  it('inserts one Opus PLC packet before the next real packet when an uplink sequence gap is detected', () => {
    const decoder = new RealtimeUplinkAudioDecoder();

    expect(decoder.decode(makeOpusPayload(1, 1000))).toHaveLength(1);
    const packets = decoder.decode(makeOpusPayload(3, 1040));

    expect(packets).toHaveLength(2);
    expect(packets[0]).toMatchObject({
      codec: 'opus',
      sequence: 2,
      timestampMs: 1020,
      sampleRate: 48_000,
      samplesPerChannel: 960,
      concealment: 'opus-plc',
    });
    expect(packets[1]).toMatchObject({
      codec: 'opus',
      sequence: 3,
      timestampMs: 1040,
    });
    expect(packets[1]?.concealment).toBeUndefined();
    expect(opusDecodeCalls).toEqual([1, 0, 1]);
  });

  it('does not insert Opus PLC when uplink sequences are continuous', () => {
    const decoder = new RealtimeUplinkAudioDecoder();

    decoder.decode(makeOpusPayload(1, 1000));
    const packets = decoder.decode(makeOpusPayload(2, 1020));

    expect(packets).toHaveLength(1);
    expect(packets[0]?.concealment).toBeUndefined();
    expect(opusDecodeCalls).toEqual([1, 1]);
  });

  it('caps Opus PLC insertion to one packet even when the sequence gap is larger', () => {
    const decoder = new RealtimeUplinkAudioDecoder();

    decoder.decode(makeOpusPayload(1, 1000));
    const packets = decoder.decode(makeOpusPayload(5, 1080));

    expect(packets.map((packet) => packet.sequence)).toEqual([2, 5]);
    expect(packets.filter((packet) => packet.concealment === 'opus-plc')).toHaveLength(1);
  });

  it('continues decoding the real Opus packet when native PLC returns no samples or throws', () => {
    const emptyPlcDecoder = new RealtimeUplinkAudioDecoder();
    emptyPlcDecoder.decode(makeOpusPayload(1, 1000));
    opusDecodeBehavior.plcEmpty = true;
    expect(emptyPlcDecoder.decode(makeOpusPayload(3, 1040))).toHaveLength(1);

    const throwingPlcDecoder = new RealtimeUplinkAudioDecoder();
    opusDecodeBehavior.plcEmpty = false;
    throwingPlcDecoder.decode(makeOpusPayload(1, 1000));
    opusDecodeBehavior.plcThrows = true;
    const packets = throwingPlcDecoder.decode(makeOpusPayload(3, 1040));

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ sequence: 3 });
    expect(packets[0]?.concealment).toBeUndefined();
  });
});

function makeOpusPayload(sequence: number, timestampMs: number): ArrayBuffer {
  return encodeRealtimeEncodedAudioFrame({
    codec: 'opus',
    sequence,
    timestampMs,
    serverSentAtMs: timestampMs + 1,
    sourceSampleRate: 48_000,
    codecSampleRate: 48_000,
    channels: 1,
    samplesPerChannel: 960,
    frameDurationMs: 20,
    payload: new Uint8Array([sequence & 0xff]),
  });
}
