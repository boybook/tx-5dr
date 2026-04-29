import { encodeRealtimeEncodedAudioFrame, encodeRealtimePcmAudioFrame } from '@tx5dr/core';
import {
  resolveVoiceTxBufferPolicy,
  type RealtimeTransportKind,
  type ResolvedRealtimeAudioCodecPolicy,
  type ResolvedVoiceTxBufferPolicy,
} from '@tx5dr/contracts';
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
  codec: 'opus' | 'pcm-s16le';
  bitrateKbps: number | null;
}

export interface VoiceTxUplinkSenderOptions {
  transport: RealtimeTransportKind;
  sendBinary: (payload: ArrayBuffer) => boolean;
  getBufferedAmount: () => number | null;
  estimateServerTimeMs: (clientTimeMs: number) => number | null;
  getClockConfidence: () => RealtimeClockConfidence;
  txBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  audioCodecPolicy?: ResolvedRealtimeAudioCodecPolicy;
}

export class VoiceTxUplinkSender {
  private sequence = 0;
  private opusEncoder: unknown | null = null;
  private opusEncoderKey: string | null = null;
  private readonly pendingOpusFrames: Array<{
    sequence: number;
    timestampMs: number;
    sampleRate: number;
    channels: number;
    samplesPerChannel: number;
    frameDurationMs: number;
  }> = [];
  private readonly wireByteSamples: Array<{ at: number; bytes: number }> = [];

  constructor(private readonly options: VoiceTxUplinkSenderOptions) {}

  sendFrame(frame: CompatCaptureFrame): VoiceTxUplinkSendResult {
    const sendStartedAt = performance.now();
    const txBufferPolicy = this.options.txBufferPolicy ?? resolveVoiceTxBufferPolicy();
    const audioCodecPolicy = this.options.audioCodecPolicy;
    const codec = audioCodecPolicy?.resolvedCodec === 'opus' ? 'opus' : 'pcm-s16le';
    const bufferedAmountBytes = this.options.getBufferedAmount();
    const bufferedAudioMs = estimateBufferedAudioMs(bufferedAmountBytes, frame.sampleRate, 1, audioCodecPolicy);
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
        codec,
        bitrateKbps: this.getWireBitrateKbps(),
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
    if (codec === 'opus' && this.tryEncodeOpusFrame(frame, timestampMs, frameDurationMs)) {
      return {
        sent: true,
        dropped: false,
        degraded,
        samplesPerChannel: frame.samplesPerChannel,
        sendDurationMs: performance.now() - sendStartedAt,
        bufferedAmountBytes: this.options.getBufferedAmount(),
        bufferedAudioMs,
        codec,
        bitrateKbps: this.getWireBitrateKbps() ?? ((audioCodecPolicy?.bitrateBps ?? 24_000) / 1000),
      };
    }

    const payload = encodeRealtimePcmAudioFrame({
      sequence: this.sequence++,
      timestampMs,
      sampleRate: frame.sampleRate,
      channels: 1,
      samplesPerChannel: frame.samplesPerChannel,
      pcm: new Int16Array(frame.buffer),
    });
    const sent = this.options.sendBinary(payload);
    if (sent) {
      this.recordWireBytes(payload.byteLength);
    }

    return {
      sent,
      dropped: !sent,
      degraded,
      samplesPerChannel: frame.samplesPerChannel,
      sendDurationMs: performance.now() - sendStartedAt,
      bufferedAmountBytes: this.options.getBufferedAmount(),
      bufferedAudioMs,
      codec: 'pcm-s16le',
      bitrateKbps: this.getWireBitrateKbps(),
    };
  }

  reset(): void {
    this.sequence = 0;
    this.pendingOpusFrames.length = 0;
    this.wireByteSamples.length = 0;
    this.closeOpusEncoder();
  }

  get transport(): RealtimeTransportKind {
    return this.options.transport;
  }

  get clockConfidence(): RealtimeClockConfidence {
    return this.options.getClockConfidence();
  }

  private tryEncodeOpusFrame(
    frame: CompatCaptureFrame,
    timestampMs: number,
    frameDurationMs: number,
  ): boolean {
    const encoder = this.ensureOpusEncoder(frame.sampleRate, 1);
    if (!encoder) {
      return false;
    }
    const AudioDataCtor = (globalThis as unknown as { AudioData?: new (init: Record<string, unknown>) => { close?: () => void } }).AudioData;
    if (!AudioDataCtor) {
      return false;
    }
    let audioData: { close?: () => void } | null = null;
    let sequence: number | null = null;
    try {
      audioData = new AudioDataCtor({
        format: 's16',
        sampleRate: frame.sampleRate,
        numberOfFrames: frame.samplesPerChannel,
        numberOfChannels: 1,
        timestamp: timestampMs * 1000,
        data: new Int16Array(frame.buffer),
      });
      sequence = this.sequence++;
      this.pendingOpusFrames.push({
        sequence,
        timestampMs,
        sampleRate: frame.sampleRate,
        channels: 1,
        samplesPerChannel: frame.samplesPerChannel,
        frameDurationMs: Math.max(1, Math.round(frameDurationMs)),
      });
      (encoder as { encode: (data: unknown) => void }).encode(audioData);
      return true;
    } catch {
      if (sequence !== null) {
        const last = this.pendingOpusFrames[this.pendingOpusFrames.length - 1];
        if (last?.sequence === sequence) {
          this.pendingOpusFrames.pop();
        }
        this.sequence = Math.max(0, this.sequence - 1);
      }
      this.closeOpusEncoder();
      return false;
    } finally {
      audioData?.close?.();
    }
  }

  private ensureOpusEncoder(sampleRate: number, channels: number): unknown | null {
    const policy = this.options.audioCodecPolicy;
    if (policy?.resolvedCodec !== 'opus') {
      return null;
    }
    const key = `${sampleRate}:${channels}:${policy.bitrateBps ?? 24_000}`;
    if (this.opusEncoder && this.opusEncoderKey === key) {
      return this.opusEncoder;
    }
    this.closeOpusEncoder();
    const AudioEncoderCtor = (globalThis as unknown as {
      AudioEncoder?: new (init: { output: (chunk: unknown) => void; error: (error: Error) => void }) => {
        configure: (config: Record<string, unknown>) => void;
        encode: (data: unknown) => void;
        close?: () => void;
      };
    }).AudioEncoder;
    if (!AudioEncoderCtor) {
      return null;
    }
    this.opusEncoder = new AudioEncoderCtor({
      output: (chunk) => this.handleOpusChunk(chunk),
      error: () => {
        this.closeOpusEncoder();
      },
    });
    const encoder = this.opusEncoder as { configure: (config: Record<string, unknown>) => void };
    try {
      try {
        encoder.configure({
          codec: 'opus',
          sampleRate,
          numberOfChannels: channels,
          bitrate: policy.bitrateBps ?? 24_000,
          opus: {
            frameDuration: 10_000,
            application: 'lowdelay',
          },
        });
      } catch {
        encoder.configure({
          codec: 'opus',
          sampleRate,
          numberOfChannels: channels,
          bitrate: policy.bitrateBps ?? 24_000,
        });
      }
    } catch {
      this.closeOpusEncoder();
      return null;
    }
    this.opusEncoderKey = key;
    return this.opusEncoder;
  }

  private closeOpusEncoder(): void {
    try {
      (this.opusEncoder as { close?: () => void } | null)?.close?.();
    } catch {
      // ignore
    }
    this.opusEncoder = null;
    this.opusEncoderKey = null;
    this.pendingOpusFrames.length = 0;
  }

  private handleOpusChunk(chunk: unknown): void {
    const meta = this.pendingOpusFrames.shift();
    if (!meta) {
      return;
    }
    const encodedChunk = chunk as {
      byteLength?: number;
      copyTo?: (destination: Uint8Array) => void;
    };
    const bytes = Math.max(0, Number(encodedChunk.byteLength ?? 0));
    if (bytes <= 0 || !encodedChunk.copyTo) {
      return;
    }
    const payloadBytes = new Uint8Array(bytes);
    encodedChunk.copyTo(payloadBytes);
    const payload = encodeRealtimeEncodedAudioFrame({
      codec: 'opus',
      sequence: meta.sequence,
      timestampMs: meta.timestampMs,
      sourceSampleRate: meta.sampleRate,
      codecSampleRate: meta.sampleRate,
      channels: meta.channels,
      samplesPerChannel: meta.samplesPerChannel,
      frameDurationMs: meta.frameDurationMs,
      payload: payloadBytes,
    });
    if (this.options.sendBinary(payload)) {
      this.recordWireBytes(payload.byteLength);
    }
  }

  private recordWireBytes(bytes: number): void {
    const now = Date.now();
    this.wireByteSamples.push({ at: now, bytes });
    while (this.wireByteSamples.length > 0 && (now - this.wireByteSamples[0]!.at) > 3000) {
      this.wireByteSamples.shift();
    }
  }

  private getWireBitrateKbps(): number | null {
    const now = Date.now();
    const samples = this.wireByteSamples.filter((entry) => (now - entry.at) <= 3000);
    if (samples.length === 0) {
      return null;
    }
    const elapsedMs = Math.max(1000, now - (samples[0]?.at ?? now));
    const bytes = samples.reduce((sum, entry) => sum + entry.bytes, 0);
    return (bytes * 8) / elapsedMs;
  }
}

function estimateBufferedAudioMs(
  bufferedAmountBytes: number | null,
  sampleRate: number,
  channels: number,
  audioCodecPolicy?: ResolvedRealtimeAudioCodecPolicy,
): number | null {
  if (bufferedAmountBytes === null || !Number.isFinite(bufferedAmountBytes) || bufferedAmountBytes <= 0) {
    return bufferedAmountBytes === 0 ? 0 : null;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }
  const bytesPerMs = audioCodecPolicy?.resolvedCodec === 'opus' && audioCodecPolicy.bitrateBps
    ? (audioCodecPolicy.bitrateBps / 8) / 1000
    : (sampleRate * Math.max(1, channels) * PCM_BYTES_PER_SAMPLE) / 1000;
  return bytesPerMs > 0 ? bufferedAmountBytes / bytesPerMs : null;
}
