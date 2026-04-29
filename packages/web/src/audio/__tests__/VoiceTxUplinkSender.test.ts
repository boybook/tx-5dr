import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeRealtimeAudioFrame,
  decodeRealtimePcmAudioFrame,
  isRealtimeEncodedAudioFrame,
} from '@tx5dr/core';
import { resolveVoiceTxBufferPolicy } from '@tx5dr/contracts';
import { VoiceTxUplinkSender } from '../VoiceTxUplinkSender';

const originalAudioEncoder = (globalThis as unknown as { AudioEncoder?: unknown }).AudioEncoder;
const originalAudioData = (globalThis as unknown as { AudioData?: unknown }).AudioData;

class FakeAudioData {
  constructor(readonly init: Record<string, unknown>) {}

  close(): void {}
}

class FakeEncodedAudioChunk {
  readonly byteLength = 3;

  copyTo(destination: Uint8Array): void {
    destination.set([1, 2, 3]);
  }
}

class FakeAudioEncoder {
  constructor(private readonly init: { output: (chunk: unknown) => void }) {}

  configure(): void {}

  encode(): void {
    this.init.output(new FakeEncodedAudioChunk());
  }
}

function createFrame(samplesPerChannel = 160) {
  return {
    sampleRate: 16000,
    samplesPerChannel,
    buffer: new Int16Array(samplesPerChannel).buffer,
    capturedAtMs: 1000,
  };
}

describe('VoiceTxUplinkSender', () => {
  afterEach(() => {
    (globalThis as unknown as { AudioEncoder?: unknown }).AudioEncoder = originalAudioEncoder;
    (globalThis as unknown as { AudioData?: unknown }).AudioData = originalAudioData;
  });

  it('sends PCM frames with server-clock timestamps when clock sync is stable', () => {
    let sent: ArrayBuffer | null = null;
    const sender = new VoiceTxUplinkSender({
      transport: 'rtc-data-audio',
      sendBinary: (payload) => {
        sent = payload;
        return true;
      },
      getBufferedAmount: () => 0,
      estimateServerTimeMs: (clientTimeMs) => clientTimeMs + 50,
      getClockConfidence: () => 'high',
      txBufferPolicy: resolveVoiceTxBufferPolicy({ profile: 'balanced' }),
    });

    const result = sender.sendFrame(createFrame());
    expect(result.sent).toBe(true);
    expect(result.dropped).toBe(false);
    expect(sent).not.toBeNull();
    const decoded = decodeRealtimePcmAudioFrame(sent!);
    expect(decoded.timestampMs).toBe(1050);
    expect(decoded.samplesPerChannel).toBe(160);
    expect(decoded.sequence).toBe(0);
  });

  it('drops old frames when transport buffered audio exceeds the realtime budget', () => {
    let sent = 0;
    const sender = new VoiceTxUplinkSender({
      transport: 'ws-compat',
      sendBinary: () => {
        sent += 1;
        return true;
      },
      getBufferedAmount: () => 3000,
      estimateServerTimeMs: () => null,
      getClockConfidence: () => 'unknown',
      txBufferPolicy: resolveVoiceTxBufferPolicy({ profile: 'low-latency' }),
    });

    const result = sender.sendFrame(createFrame());
    expect(result.sent).toBe(false);
    expect(result.dropped).toBe(true);
    expect(result.bufferedAudioMs).toBeGreaterThan(80);
    expect(sent).toBe(0);
  });

  it('encodes Opus frames through WebCodecs when negotiated', () => {
    (globalThis as unknown as { AudioEncoder?: unknown }).AudioEncoder = FakeAudioEncoder;
    (globalThis as unknown as { AudioData?: unknown }).AudioData = FakeAudioData;

    const sent: ArrayBuffer[] = [];
    const sender = new VoiceTxUplinkSender({
      transport: 'rtc-data-audio',
      sendBinary: (payload) => {
        sent.push(payload);
        return true;
      },
      getBufferedAmount: () => 0,
      estimateServerTimeMs: (clientTimeMs) => clientTimeMs + 50,
      getClockConfidence: () => 'high',
      txBufferPolicy: resolveVoiceTxBufferPolicy({ profile: 'balanced' }),
      audioCodecPolicy: {
        preference: 'auto',
        resolvedCodec: 'opus',
        fallbackReason: null,
        codecSampleRate: null,
        bitrateBps: 24_000,
        frameDurationMs: 10,
      },
    });

    const result = sender.sendFrame(createFrame());

    expect(result.sent).toBe(true);
    expect(result.codec).toBe('opus');
    expect(sent).toHaveLength(1);
    const decoded = decodeRealtimeAudioFrame(sent[0]!);
    expect(isRealtimeEncodedAudioFrame(decoded)).toBe(true);
    if (isRealtimeEncodedAudioFrame(decoded)) {
      expect(decoded.sequence).toBe(0);
      expect(decoded.timestampMs).toBe(1050);
      expect(decoded.codecSampleRate).toBe(16_000);
      expect(decoded.samplesPerChannel).toBe(160);
      expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
    }
  });
});
