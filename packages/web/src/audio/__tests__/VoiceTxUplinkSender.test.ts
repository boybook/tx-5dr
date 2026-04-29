import { describe, expect, it } from 'vitest';
import { decodeRealtimePcmAudioFrame } from '@tx5dr/core';
import { resolveVoiceTxBufferPolicy } from '@tx5dr/contracts';
import { VoiceTxUplinkSender } from '../VoiceTxUplinkSender';

function createFrame(samplesPerChannel = 160) {
  return {
    sampleRate: 16000,
    samplesPerChannel,
    buffer: new Int16Array(samplesPerChannel).buffer,
    capturedAtMs: 1000,
  };
}

describe('VoiceTxUplinkSender', () => {
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
});
