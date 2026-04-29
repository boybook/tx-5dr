import type {
  RealtimeAudioCodecCapabilities,
  RealtimeAudioCodecPreference,
  ResolvedRealtimeAudioCodecPolicy,
} from '@tx5dr/contracts';
import { decodeRealtimeEncodedAudioFrame, type RealtimeEncodedAudioFrame } from '@tx5dr/core';
import { createLogger } from '../utils/logger';

const logger = createLogger('RealtimeAudioCodec');
const STORAGE_KEY = 'tx5dr.realtimeAudio.codecPreference';
const DEFAULT_CODEC_PREFERENCE: RealtimeAudioCodecPreference = 'auto';
const WEB_OPUS_SAMPLE_RATES = [48_000, 24_000, 16_000, 12_000] as const;
let capabilityProbePromise: Promise<RealtimeAudioCodecCapabilities> | null = null;

type AudioDecoderConstructor = new (init: {
  output: (output: unknown) => void;
  error: (error: Error) => void;
}) => {
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  close(): void;
};

type AudioEncoderConstructor = {
  isConfigSupported?: (config: Record<string, unknown>) => Promise<{ supported?: boolean }>;
};

export function loadRealtimeAudioCodecPreference(): RealtimeAudioCodecPreference {
  if (typeof window === 'undefined') {
    return DEFAULT_CODEC_PREFERENCE;
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === 'opus' || raw === 'pcm' || raw === 'auto' ? raw : DEFAULT_CODEC_PREFERENCE;
}

export function saveRealtimeAudioCodecPreference(preference: RealtimeAudioCodecPreference): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, preference);
}

export async function getRealtimeAudioCodecCapabilities(): Promise<RealtimeAudioCodecCapabilities> {
  if (capabilityProbePromise) {
    return capabilityProbePromise;
  }
  capabilityProbePromise = probeRealtimeAudioCodecCapabilities();
  return capabilityProbePromise;
}

async function probeRealtimeAudioCodecCapabilities(): Promise<RealtimeAudioCodecCapabilities> {
  const opus = await probeWebCodecsOpus();
  return {
    pcmS16le: true,
    opus: {
      encode: opus.encode,
      decode: opus.decode,
      sampleRates: Array.from(new Set([...opus.encodeSampleRates, ...opus.decodeSampleRates])),
      encodeSampleRates: opus.encodeSampleRates,
      decodeSampleRates: opus.decodeSampleRates,
    },
  };
}

export function isOpusPolicy(policy?: ResolvedRealtimeAudioCodecPolicy | null): boolean {
  return policy?.resolvedCodec === 'opus';
}

export class BrowserOpusDecoder {
  private decoder: InstanceType<AudioDecoderConstructor> | null = null;
  private decoderKey: string | null = null;
  private readonly pendingFrames: Array<{ frame: RealtimeEncodedAudioFrame; receivedAtClientMs: number }> = [];

  constructor(private readonly onDecoded: (frame: {
    samples: Float32Array;
    sampleRate: number;
    sourceTimestampMs: number;
    serverSentAtMs?: number;
    receivedAtClientMs: number;
    inputSampleRate: number;
  }) => void) {}

  decode(payload: ArrayBuffer, receivedAtClientMs: number): void {
    const frame = decodeRealtimeEncodedAudioFrame(payload);
    this.ensureDecoder(frame);
    if (!this.decoder) {
      return;
    }

    const EncodedAudioChunkCtor = (globalThis as unknown as { EncodedAudioChunk?: new (init: Record<string, unknown>) => unknown }).EncodedAudioChunk;
    if (!EncodedAudioChunkCtor) {
      throw new Error('EncodedAudioChunk is unavailable');
    }
    const chunk = new EncodedAudioChunkCtor({
      type: 'key',
      timestamp: frame.timestampMs * 1000,
      duration: frame.frameDurationMs * 1000,
      data: frame.payload,
    });
    this.pendingFrames.push({ frame, receivedAtClientMs });
    this.decoder.decode(chunk);
  }

  close(): void {
    try {
      this.decoder?.close();
    } catch {
      // ignore
    }
    this.decoder = null;
    this.decoderKey = null;
    this.pendingFrames.length = 0;
  }

  private ensureDecoder(frame: RealtimeEncodedAudioFrame): void {
    const key = `${frame.codec}:${frame.codecSampleRate}:${frame.channels}`;
    if (this.decoder && this.decoderKey === key) {
      return;
    }
    this.close();
    const AudioDecoderCtor = (globalThis as unknown as { AudioDecoder?: AudioDecoderConstructor }).AudioDecoder;
    if (!AudioDecoderCtor) {
      throw new Error('AudioDecoder is unavailable');
    }
    this.decoder = new AudioDecoderCtor({
      output: (audioData) => {
        const current = this.pendingFrames.shift();
        try {
          const samples = copyAudioDataToFloat32(audioData);
          this.onDecoded({
            samples,
            sampleRate: Number((audioData as { sampleRate?: number }).sampleRate ?? current?.frame.codecSampleRate ?? frame.codecSampleRate),
            sourceTimestampMs: current?.frame.timestampMs ?? frame.timestampMs,
            serverSentAtMs: current?.frame.serverSentAtMs,
            receivedAtClientMs: current?.receivedAtClientMs ?? Date.now(),
            inputSampleRate: current?.frame.codecSampleRate ?? frame.codecSampleRate,
          });
        } finally {
          try {
            (audioData as { close?: () => void }).close?.();
          } catch {
            // ignore
          }
        }
      },
      error: (error) => {
        logger.warn('Opus decoder error', error);
      },
    });
    this.decoder.configure({
      codec: 'opus',
      sampleRate: frame.codecSampleRate,
      numberOfChannels: frame.channels,
    });
    this.decoderKey = key;
  }
}

async function probeWebCodecsOpus(): Promise<{
  encode: boolean;
  decode: boolean;
  encodeSampleRates: number[];
  decodeSampleRates: number[];
}> {
  const g = globalThis as unknown as {
    AudioEncoder?: AudioEncoderConstructor;
    AudioDecoder?: AudioEncoderConstructor;
  };
  const encodeSampleRates: number[] = [];
  const decodeSampleRates: number[] = [];

  for (const sampleRate of WEB_OPUS_SAMPLE_RATES) {
    const encodeConfig = {
      codec: 'opus',
      sampleRate,
      numberOfChannels: 1,
      bitrate: sampleRate >= 24_000 ? 32_000 : 24_000,
      opus: {
        frameDuration: 10_000,
        application: 'lowdelay',
      },
    };
    const encode = await probeCodecSupport(g.AudioEncoder, encodeConfig)
      || await probeCodecSupport(g.AudioEncoder, {
        codec: 'opus',
        sampleRate,
        numberOfChannels: 1,
        bitrate: sampleRate >= 24_000 ? 32_000 : 24_000,
      });
    if (encode) {
      encodeSampleRates.push(sampleRate);
    }

    const decode = await probeCodecSupport(g.AudioDecoder, {
      codec: 'opus',
      sampleRate,
      numberOfChannels: 1,
    });
    if (decode) {
      decodeSampleRates.push(sampleRate);
    }
  }

  return {
    encode: encodeSampleRates.length > 0,
    decode: decodeSampleRates.length > 0,
    encodeSampleRates,
    decodeSampleRates,
  };
}

async function probeCodecSupport(
  ctor: AudioEncoderConstructor | undefined,
  config: Record<string, unknown>,
): Promise<boolean> {
  if (!ctor?.isConfigSupported) {
    return false;
  }
  try {
    const result = await ctor.isConfigSupported(config);
    return result.supported === true;
  } catch {
    return false;
  }
}

function copyAudioDataToFloat32(audioData: unknown): Float32Array {
  const data = audioData as {
    allocationSize?: (options: Record<string, unknown>) => number;
    copyTo: (destination: ArrayBufferView, options: Record<string, unknown>) => void;
    numberOfFrames?: number;
    numberOfChannels?: number;
    format?: string;
  };
  const frames = Number(data.numberOfFrames ?? 0);
  if (!Number.isFinite(frames) || frames <= 0) {
    return new Float32Array(0);
  }
  const format = data.format ?? 'f32';
  if (format.startsWith('s16')) {
    const pcm = new Int16Array(data.allocationSize?.({ planeIndex: 0 }) ? Math.floor(data.allocationSize({ planeIndex: 0 }) / 2) : frames);
    data.copyTo(pcm, { planeIndex: 0 });
    const output = new Float32Array(Math.min(frames, pcm.length));
    for (let index = 0; index < output.length; index += 1) {
      output[index] = (pcm[index] ?? 0) / 32768;
    }
    return output;
  }

  const samples = new Float32Array(data.allocationSize?.({ planeIndex: 0 }) ? Math.floor(data.allocationSize({ planeIndex: 0 }) / 4) : frames);
  data.copyTo(samples, { planeIndex: 0 });
  return samples.length === frames ? samples : samples.slice(0, frames);
}
