import { encodeRealtimePcmAudioFrame } from '@tx5dr/core';
import { resolveVoiceTxBufferPolicy, type RealtimeTransportKind, type ResolvedVoiceTxBufferPolicy } from '@tx5dr/contracts';
import type { RealtimeClockConfidence } from '../realtime/RealtimeClockSync';
import type { CompatCaptureFrame } from './compatAudioBackends';

const PCM_BYTES_PER_SAMPLE = 2;

export interface VoiceTxUplinkSendResult {
  sent: boolean;
  dropped: boolean;
  degraded: boolean;
  samplesPerChannel: number;
  sendDurationMs: number;
  bufferedAmountBytes: number | null;
  bufferedAudioMs: number | null;
}

export interface VoiceTxUplinkSenderOptions {
  transport: RealtimeTransportKind;
  sendBinary: (payload: ArrayBuffer) => boolean;
  getBufferedAmount: () => number | null;
  estimateServerTimeMs: (clientTimeMs: number) => number | null;
  getClockConfidence: () => RealtimeClockConfidence;
  txBufferPolicy?: ResolvedVoiceTxBufferPolicy;
}

export class VoiceTxUplinkSender {
  private sequence = 0;

  constructor(private readonly options: VoiceTxUplinkSenderOptions) {}

  sendFrame(frame: CompatCaptureFrame): VoiceTxUplinkSendResult {
    const sendStartedAt = performance.now();
    const txBufferPolicy = this.options.txBufferPolicy ?? resolveVoiceTxBufferPolicy();
    const bufferedAmountBytes = this.options.getBufferedAmount();
    const bufferedAudioMs = estimateBufferedAudioMs(bufferedAmountBytes, frame.sampleRate, 1);
    const degraded = (bufferedAudioMs ?? 0) > txBufferPolicy.uplinkDegradedBufferedAudioMs;

    if ((bufferedAudioMs ?? 0) > txBufferPolicy.uplinkMaxBufferedAudioMs) {
      return {
        sent: false,
        dropped: true,
        degraded,
        samplesPerChannel: frame.samplesPerChannel,
        sendDurationMs: performance.now() - sendStartedAt,
        bufferedAmountBytes,
        bufferedAudioMs,
      };
    }

    const frameDurationMs = frame.sampleRate > 0
      ? (frame.samplesPerChannel / frame.sampleRate) * 1000
      : 0;
    const clientFrameStartAtMs = typeof frame.capturedAtMs === 'number'
      ? frame.capturedAtMs
      : Date.now() - frameDurationMs;
    const serverFrameStartAtMs = this.options.estimateServerTimeMs(clientFrameStartAtMs);
    const timestampMs = serverFrameStartAtMs === null ? 0 : serverFrameStartAtMs;
    const payload = encodeRealtimePcmAudioFrame({
      sequence: this.sequence++,
      timestampMs,
      sampleRate: frame.sampleRate,
      channels: 1,
      samplesPerChannel: frame.samplesPerChannel,
      pcm: new Int16Array(frame.buffer),
    });
    const sent = this.options.sendBinary(payload);

    return {
      sent,
      dropped: !sent,
      degraded,
      samplesPerChannel: frame.samplesPerChannel,
      sendDurationMs: performance.now() - sendStartedAt,
      bufferedAmountBytes: this.options.getBufferedAmount(),
      bufferedAudioMs,
    };
  }

  reset(): void {
    this.sequence = 0;
  }

  get transport(): RealtimeTransportKind {
    return this.options.transport;
  }

  get clockConfidence(): RealtimeClockConfidence {
    return this.options.getClockConfidence();
  }
}

function estimateBufferedAudioMs(
  bufferedAmountBytes: number | null,
  sampleRate: number,
  channels: number,
): number | null {
  if (bufferedAmountBytes === null || !Number.isFinite(bufferedAmountBytes) || bufferedAmountBytes <= 0) {
    return bufferedAmountBytes === 0 ? 0 : null;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }
  const bytesPerMs = (sampleRate * Math.max(1, channels) * PCM_BYTES_PER_SAMPLE) / 1000;
  return bytesPerMs > 0 ? bufferedAmountBytes / bytesPerMs : null;
}
