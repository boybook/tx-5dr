import type {
  RealtimeAudioCodecCapabilities,
  RealtimeAudioCodecPreference,
  RealtimeScope,
  RealtimeSessionDirection,
  ResolvedRealtimeAudioCodecPolicy,
} from '@tx5dr/contracts';
import {
  decodeRealtimeAudioFrame,
  encodeRealtimeEncodedAudioFrame,
  encodeRealtimePcmAudioFrame,
  float32ToInt16Pcm,
  int16ToFloat32Pcm,
  isRealtimeEncodedAudioFrame,
  type RealtimeEncodedAudioFrame,
  type RealtimePcmAudioFrame,
} from '@tx5dr/core';
import { createLogger } from '../utils/logger.js';
import type { RealtimeAudioFrame } from './RealtimeRxAudioSource.js';
import { RealtimeTransportAudioDecimator } from './RealtimeTransportAudioDecimator.js';
import { StreamingLinearResampler } from './StreamingAudioResampler.js';

const logger = createLogger('RealtimeAudioCodecPipeline');
const OPUS_STANDARD_SAMPLE_RATES = [48_000, 24_000, 16_000, 12_000, 8_000] as const;
const OPUS_NATIVE_RX_SAMPLE_RATES = [48_000, 24_000, 16_000, 12_000] as const;
const OPUS_TX_CAPTURE_SAMPLE_RATE = 16_000;
const REALTIME_AUDIO_FRAME_DURATION_MS = 20;
const REALTIME_OPUS_RX_BITRATE_BPS = 32_000;
const REALTIME_OPUS_TX_BITRATE_BPS = 24_000;
const MAX_OPUS_CHANNELS = 2;

type AudifyOpusEncoder = {
  bitrate: number;
  encode(buf: Buffer, frameSize: number): Buffer;
};

type AudifyOpusDecoder = {
  decode(buf: Buffer, frameSize: number): Buffer;
};

type AudifyOpusModule = {
  OpusEncoder: new (rate: number, channels: number, application: number) => AudifyOpusEncoder;
  OpusDecoder: new (rate: number, channels: number) => AudifyOpusDecoder;
  OpusApplication: {
    OPUS_APPLICATION_RESTRICTED_LOWDELAY: number;
  };
};

export interface RealtimeCodecPacket {
  payload: ArrayBuffer;
  codec: 'opus' | 'pcm-s16le';
  sequence: number;
  timestampMs: number;
  serverSentAtMs?: number;
  sourceSampleRate: number;
  codecSampleRate: number;
  channels: number;
  samplesPerChannel: number;
  frameDurationMs: number;
  wireBytes: number;
}

export interface DecodedRealtimeAudioPacket {
  codec: 'opus' | 'pcm-s16le';
  sequence: number;
  timestampMs: number;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  samples: Float32Array;
  concealment?: 'opus-plc';
}

export interface ResolveRealtimeCodecPolicyOptions {
  scope: RealtimeScope;
  direction: RealtimeSessionDirection;
  preference?: RealtimeAudioCodecPreference;
  capabilities?: RealtimeAudioCodecCapabilities;
  serverOpusAvailable: boolean;
}

export class RealtimeOpusCodecService {
  private static instance: RealtimeOpusCodecService | null = null;

  static getInstance(): RealtimeOpusCodecService {
    if (!RealtimeOpusCodecService.instance) {
      RealtimeOpusCodecService.instance = new RealtimeOpusCodecService();
    }
    return RealtimeOpusCodecService.instance;
  }

  private modulePromise: Promise<AudifyOpusModule | null> | null = null;
  private module: AudifyOpusModule | null = null;
  private unavailableReason: string | null = null;

  async isAvailable(): Promise<boolean> {
    const mod = await this.loadModule();
    return mod !== null;
  }

  isAvailableCached(): boolean {
    return this.module !== null;
  }

  getUnavailableReason(): string | null {
    return this.unavailableReason;
  }

  createEncoder(sampleRate: number, channels: number, bitrateBps?: number): AudifyOpusEncoder | null {
    const mod = this.module;
    if (!mod) {
      return null;
    }
    try {
      const codec = new mod.OpusEncoder(
        sampleRate,
        channels,
        mod.OpusApplication.OPUS_APPLICATION_RESTRICTED_LOWDELAY,
      );
      if (bitrateBps) {
        codec.bitrate = bitrateBps;
      }
      return codec;
    } catch (error) {
      logger.warn('Failed to create Opus encoder', {
        sampleRate,
        channels,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  createDecoder(sampleRate: number, channels: number): AudifyOpusDecoder | null {
    const mod = this.module;
    if (!mod) {
      return null;
    }
    try {
      return new mod.OpusDecoder(sampleRate, channels);
    } catch (error) {
      logger.warn('Failed to create Opus decoder', {
        sampleRate,
        channels,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async loadModule(): Promise<AudifyOpusModule | null> {
    if (!this.modulePromise) {
      this.modulePromise = import('audify')
        .then((mod) => {
          const resolved = (mod.default ?? mod) as AudifyOpusModule;
          if (!resolved.OpusEncoder || !resolved.OpusDecoder || !resolved.OpusApplication) {
            throw new Error('audify Opus exports are missing');
          }
          this.module = resolved;
          this.unavailableReason = null;
          return resolved;
        })
        .catch((error) => {
          this.module = null;
          this.unavailableReason = error instanceof Error ? error.message : String(error);
          logger.warn('Opus native codec is unavailable; realtime audio will fall back to PCM', {
            error: this.unavailableReason,
          });
          return null;
        });
    }
    return this.modulePromise;
  }
}

export function resolveRealtimeAudioCodecPolicy(
  options: ResolveRealtimeCodecPolicyOptions,
): ResolvedRealtimeAudioCodecPolicy {
  const preference = options.preference ?? 'auto';
  const bitrateBps = options.direction === 'send'
    ? REALTIME_OPUS_TX_BITRATE_BPS
    : REALTIME_OPUS_RX_BITRATE_BPS;

  if (options.scope !== 'radio') {
    return buildPcmPolicy(preference, 'scope-not-supported');
  }

  if (preference === 'pcm') {
    return buildPcmPolicy(preference, 'client-forced-pcm');
  }

  const clientOpusAvailable = options.direction === 'send'
    ? Boolean(options.capabilities?.opus?.encode)
    : Boolean(options.capabilities?.opus?.decode);

  if (!clientOpusAvailable) {
    return buildPcmPolicy(preference, 'client-opus-unavailable');
  }

  if (!options.serverOpusAvailable) {
    return buildPcmPolicy(preference, 'server-opus-unavailable');
  }

  const supportedSampleRates = getClientOpusSampleRates(options.capabilities, options.direction);
  let codecSampleRate: number | null = null;
  if (options.direction === 'send') {
    if (supportedSampleRates.length > 0 && !supportedSampleRates.includes(OPUS_TX_CAPTURE_SAMPLE_RATE)) {
      return buildPcmPolicy(preference, 'client-opus-unavailable');
    }
  } else if (supportedSampleRates.length > 0) {
    const supportsNativeRates = OPUS_NATIVE_RX_SAMPLE_RATES.every((rate) => supportedSampleRates.includes(rate));
    if (!supportsNativeRates) {
      codecSampleRate = chooseClientOpusSampleRate(supportedSampleRates);
      if (!codecSampleRate) {
        return buildPcmPolicy(preference, 'client-opus-unavailable');
      }
    }
  }

  return {
    preference,
    resolvedCodec: 'opus',
    fallbackReason: null,
    codecSampleRate,
    bitrateBps,
    frameDurationMs: REALTIME_AUDIO_FRAME_DURATION_MS,
  };
}

export class RealtimeDownlinkAudioEncoder {
  private sequence = 0;
  private readonly pcmDecimator = new RealtimeTransportAudioDecimator();
  private opusCodec: AudifyOpusEncoder | null = null;
  private opusKey: string | null = null;
  private resampler: InterleavedStreamingResampler | null = null;
  private fixedFrameBuffer: TimedFixedFrameBuffer | null = null;
  private pcmKey: string | null = null;
  private pcmFixedFrameBuffer: TimedFixedFrameBuffer | null = null;

  constructor(private readonly policy: ResolvedRealtimeAudioCodecPolicy) {}

  encodeSourceFrame(frame: RealtimeAudioFrame): RealtimeCodecPacket[] {
    if (this.policy.resolvedCodec === 'opus') {
      return this.encodeOpusFrame(frame);
    }
    return this.encodePcmFrame(frame);
  }

  private encodePcmFrame(frame: RealtimeAudioFrame): RealtimeCodecPacket[] {
    const transportFrame = this.pcmDecimator.process(frame);
    if (
      transportFrame.samples.length === 0
      || !Number.isFinite(transportFrame.sampleRate)
      || transportFrame.sampleRate <= 0
    ) {
      return [];
    }

    const pcmKey = `${frame.sourceKind}:${frame.nativeSourceKind ?? ''}:${transportFrame.sampleRate}:${transportFrame.channels}`;
    if (this.pcmKey !== pcmKey) {
      this.pcmKey = pcmKey;
      this.pcmFixedFrameBuffer = new TimedFixedFrameBuffer(
        Math.round((transportFrame.sampleRate * REALTIME_AUDIO_FRAME_DURATION_MS) / 1000),
        transportFrame.channels,
        transportFrame.sampleRate,
      );
    }
    if (!this.pcmFixedFrameBuffer) {
      return [];
    }

    const pcmFrames = this.pcmFixedFrameBuffer.push(transportFrame.samples, transportFrame.timestamp);
    const packets: RealtimeCodecPacket[] = [];
    for (const pcmFrame of pcmFrames) {
      const serverSentAtMs = Date.now();
      const sequence = this.sequence++;
      const payload = encodeRealtimePcmAudioFrame({
        sequence,
        timestampMs: pcmFrame.timestampMs,
        serverSentAtMs,
        sampleRate: transportFrame.sampleRate,
        channels: transportFrame.channels,
        samplesPerChannel: pcmFrame.samplesPerChannel,
        pcm: float32ToInt16Pcm(pcmFrame.samples),
      });

      packets.push({
        payload,
        codec: 'pcm-s16le',
        sequence,
        timestampMs: pcmFrame.timestampMs,
        serverSentAtMs,
        sourceSampleRate: transportFrame.inputSampleRate,
        codecSampleRate: transportFrame.sampleRate,
        channels: transportFrame.channels,
        samplesPerChannel: pcmFrame.samplesPerChannel,
        frameDurationMs: REALTIME_AUDIO_FRAME_DURATION_MS,
        wireBytes: payload.byteLength,
      });
    }
    return packets;
  }

  private encodeOpusFrame(frame: RealtimeAudioFrame): RealtimeCodecPacket[] {
    const sourceSampleRate = normalizeSampleRate(frame.sampleRate);
    const sourceChannels = normalizeOpusChannels(frame.channels);
    const samplesPerChannel = Math.floor(frame.samples.length / Math.max(1, frame.channels));
    if (sourceSampleRate <= 0 || samplesPerChannel <= 0) {
      return [];
    }

    const codecSampleRate = resolveOpusCodecSampleRate(this.policy.codecSampleRate ?? sourceSampleRate);
    const sourceKey = `${frame.sourceKind}:${frame.nativeSourceKind ?? ''}:${sourceSampleRate}:${sourceChannels}:${codecSampleRate}`;
    if (this.opusKey !== sourceKey) {
      this.resetOpusState(sourceKey, sourceSampleRate, codecSampleRate, sourceChannels);
    }
    if (!this.opusCodec || !this.fixedFrameBuffer) {
      return [];
    }

    let samples = selectOpusChannels(frame.samples, frame.channels, sourceChannels);
    if (sourceSampleRate !== codecSampleRate) {
      samples = this.resampler?.process(samples) ?? new Float32Array(0);
    }
    if (samples.length === 0) {
      return [];
    }

    const opusFrames = this.fixedFrameBuffer.push(samples, normalizeTimestamp(frame.timestamp));
    const packets: RealtimeCodecPacket[] = [];
    for (const opusFrame of opusFrames) {
      const pcm = float32ToInt16Pcm(opusFrame.samples);
      const encoded = this.opusCodec.encode(bufferFromInt16(pcm), opusFrame.samplesPerChannel);
      const serverSentAtMs = Date.now();
      const sequence = this.sequence++;
      const payload = encodeRealtimeEncodedAudioFrame({
        codec: 'opus',
        sequence,
        timestampMs: opusFrame.timestampMs,
        serverSentAtMs,
        sourceSampleRate,
        codecSampleRate,
        channels: sourceChannels,
        samplesPerChannel: opusFrame.samplesPerChannel,
        frameDurationMs: REALTIME_AUDIO_FRAME_DURATION_MS,
        payload: new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength),
      });
      packets.push({
        payload,
        codec: 'opus',
        sequence,
        timestampMs: opusFrame.timestampMs,
        serverSentAtMs,
        sourceSampleRate,
        codecSampleRate,
        channels: sourceChannels,
        samplesPerChannel: opusFrame.samplesPerChannel,
        frameDurationMs: REALTIME_AUDIO_FRAME_DURATION_MS,
        wireBytes: payload.byteLength,
      });
    }
    return packets;
  }

  private resetOpusState(
    sourceKey: string,
    sourceSampleRate: number,
    codecSampleRate: number,
    channels: number,
  ): void {
    this.opusKey = sourceKey;
    this.opusCodec = RealtimeOpusCodecService.getInstance().createEncoder(
      codecSampleRate,
      channels,
      this.policy.bitrateBps ?? REALTIME_OPUS_RX_BITRATE_BPS,
    );
    this.resampler = sourceSampleRate === codecSampleRate
      ? null
      : new InterleavedStreamingResampler(sourceSampleRate, codecSampleRate, channels);
    this.fixedFrameBuffer = new TimedFixedFrameBuffer(
      Math.round((codecSampleRate * REALTIME_AUDIO_FRAME_DURATION_MS) / 1000),
      channels,
      codecSampleRate,
    );
  }
}

export class RealtimeUplinkAudioDecoder {
  private opusCodec: AudifyOpusDecoder | null = null;
  private opusKey: string | null = null;
  private lastOpusSequence: number | null = null;
  private lastOpusTimestampMs: number | null = null;
  private lastOpusFrameDurationMs = REALTIME_AUDIO_FRAME_DURATION_MS;
  private lastOpusSamplesPerChannel: number | null = null;

  decode(payload: ArrayBufferLike): DecodedRealtimeAudioPacket[] {
    const frame = decodeRealtimeAudioFrame(payload);
    if (isRealtimeEncodedAudioFrame(frame)) {
      return this.decodeOpus(frame);
    }
    return [decodePcm(frame)];
  }

  private decodeOpus(frame: RealtimeEncodedAudioFrame): DecodedRealtimeAudioPacket[] {
    const sampleRate = resolveOpusCodecSampleRate(frame.codecSampleRate);
    const channels = normalizeOpusChannels(frame.channels);
    const key = `${sampleRate}:${channels}`;
    if (this.opusKey !== key) {
      this.opusKey = key;
      this.opusCodec = RealtimeOpusCodecService.getInstance().createDecoder(sampleRate, channels);
      this.lastOpusSequence = null;
      this.lastOpusTimestampMs = null;
      this.lastOpusFrameDurationMs = frame.frameDurationMs || REALTIME_AUDIO_FRAME_DURATION_MS;
      this.lastOpusSamplesPerChannel = null;
    }
    if (!this.opusCodec) {
      return [];
    }

    const packets: DecodedRealtimeAudioPacket[] = [];
    const plcPacket = this.decodeOpusPlcForGap(frame, sampleRate, channels);
    if (plcPacket) {
      packets.push(plcPacket);
    }

    const realPacket = this.decodeOpusPayload(frame, sampleRate, channels);
    if (realPacket) {
      packets.push(realPacket);
      this.lastOpusSequence = frame.sequence;
      this.lastOpusTimestampMs = frame.timestampMs;
      this.lastOpusFrameDurationMs = frame.frameDurationMs || REALTIME_AUDIO_FRAME_DURATION_MS;
      this.lastOpusSamplesPerChannel = realPacket.samplesPerChannel;
    }

    return packets;
  }

  private decodeOpusPayload(
    frame: RealtimeEncodedAudioFrame,
    sampleRate: number,
    channels: number,
  ): DecodedRealtimeAudioPacket | null {
    if (!this.opusCodec) {
      return null;
    }
    const frameSize = normalizeOpusFrameSize(frame.samplesPerChannel);
    if (frameSize <= 0) {
      return null;
    }
    const decoded = this.opusCodec.decode(
      Buffer.from(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength),
      frameSize,
    );
    const samples = this.decodeOpusPcm(decoded, channels);
    return {
      codec: 'opus',
      sequence: frame.sequence,
      timestampMs: frame.timestampMs,
      sampleRate,
      channels,
      samplesPerChannel: Math.floor(samples.length / channels),
      samples,
    };
  }

  private decodeOpusPlcForGap(
    frame: RealtimeEncodedAudioFrame,
    sampleRate: number,
    channels: number,
  ): DecodedRealtimeAudioPacket | null {
    if (
      !this.opusCodec
      || this.lastOpusSequence === null
      || frame.sequence <= this.lastOpusSequence + 1
      || this.lastOpusSamplesPerChannel === null
    ) {
      return null;
    }

    try {
      const frameSize = normalizeOpusFrameSize(this.lastOpusSamplesPerChannel);
      if (frameSize <= 0) {
        return null;
      }
      const decoded = this.opusCodec.decode(Buffer.alloc(0), frameSize);
      const samples = this.decodeOpusPcm(decoded, channels);
      if (samples.length === 0) {
        return null;
      }
      const frameDurationMs = this.lastOpusFrameDurationMs || frame.frameDurationMs || REALTIME_AUDIO_FRAME_DURATION_MS;
      return {
        codec: 'opus',
        sequence: this.lastOpusSequence + 1,
        timestampMs: (this.lastOpusTimestampMs ?? frame.timestampMs - frameDurationMs) + frameDurationMs,
        sampleRate,
        channels,
        samplesPerChannel: Math.floor(samples.length / channels),
        samples,
        concealment: 'opus-plc',
      };
    } catch (error) {
      logger.debug('Opus PLC decode failed; continuing with the next real frame', error);
      return null;
    }
  }

  private decodeOpusPcm(decoded: Buffer, channels: number): Float32Array {
    const byteLength = decoded.byteLength - (decoded.byteLength % 2);
    const pcm = new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + byteLength));
    const alignedLength = Math.floor(pcm.length / channels) * channels;
    return int16ToFloat32Pcm(alignedLength === pcm.length ? pcm : pcm.slice(0, alignedLength));
  }
}

function buildPcmPolicy(
  preference: RealtimeAudioCodecPreference,
  fallbackReason: ResolvedRealtimeAudioCodecPolicy['fallbackReason'],
): ResolvedRealtimeAudioCodecPolicy {
  return {
    preference,
    resolvedCodec: 'pcm-s16le',
    fallbackReason,
    codecSampleRate: null,
    bitrateBps: null,
    frameDurationMs: null,
  };
}

function decodePcm(frame: RealtimePcmAudioFrame): DecodedRealtimeAudioPacket {
  return {
    codec: 'pcm-s16le',
    sequence: frame.sequence,
    timestampMs: frame.timestampMs,
    sampleRate: frame.sampleRate,
    channels: frame.channels,
    samplesPerChannel: frame.samplesPerChannel,
    samples: int16ToFloat32Pcm(frame.pcm),
  };
}

function resolveOpusCodecSampleRate(sourceRate: number): number {
  const normalized = normalizeSampleRate(sourceRate);
  if ((OPUS_STANDARD_SAMPLE_RATES as readonly number[]).includes(normalized)) {
    return normalized;
  }
  if (normalized <= 0) {
    return 48_000;
  }
  if (normalized <= 12_000) {
    return 12_000;
  }
  if (normalized <= 16_000) {
    return 16_000;
  }
  if (normalized <= 24_000) {
    return 24_000;
  }
  return 48_000;
}

function getClientOpusSampleRates(
  capabilities: RealtimeAudioCodecCapabilities,
  direction: RealtimeSessionDirection,
): number[] {
  const opus = capabilities?.opus;
  const rawRates = direction === 'send'
    ? (opus?.encodeSampleRates ?? opus?.sampleRates)
    : (opus?.decodeSampleRates ?? opus?.sampleRates);
  if (!rawRates || rawRates.length === 0) {
    return [];
  }
  const normalized = rawRates
    .map((rate) => normalizeSampleRate(rate))
    .filter((rate) => (OPUS_STANDARD_SAMPLE_RATES as readonly number[]).includes(rate));
  return Array.from(new Set(normalized));
}

function chooseClientOpusSampleRate(sampleRates: number[]): number | null {
  for (const rate of OPUS_STANDARD_SAMPLE_RATES) {
    if (sampleRates.includes(rate)) {
      return rate;
    }
  }
  return null;
}

function normalizeSampleRate(sampleRate: number): number {
  const rounded = Math.round(sampleRate);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
}

function normalizeTimestamp(timestamp: number): number {
  return Number.isFinite(timestamp) ? Math.round(timestamp) : Date.now();
}

function normalizeOpusFrameSize(samplesPerChannel: number): number {
  const normalized = Math.floor(samplesPerChannel);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function normalizeOpusChannels(channels: number): number {
  const normalized = Math.floor(channels);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 1;
  }
  return Math.min(MAX_OPUS_CHANNELS, normalized);
}

function selectOpusChannels(samples: Float32Array, sourceChannels: number, targetChannels: number): Float32Array {
  const normalizedSourceChannels = Math.max(1, Math.floor(sourceChannels));
  if (normalizedSourceChannels === targetChannels) {
    return samples;
  }
  const samplesPerChannel = Math.floor(samples.length / normalizedSourceChannels);
  const output = new Float32Array(samplesPerChannel * targetChannels);
  for (let frame = 0; frame < samplesPerChannel; frame += 1) {
    for (let channel = 0; channel < targetChannels; channel += 1) {
      output[(frame * targetChannels) + channel] = samples[(frame * normalizedSourceChannels) + channel] ?? 0;
    }
  }
  return output;
}

function bufferFromInt16(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

class TimedFixedFrameBuffer {
  private samples = new Float32Array(0);
  private startTimestampMs: number | null = null;

  constructor(
    private readonly frameSamplesPerChannel: number,
    private readonly channels: number,
    private readonly sampleRate: number,
  ) {}

  push(samples: Float32Array, timestampMs: number): Array<{
    samples: Float32Array;
    timestampMs: number;
    samplesPerChannel: number;
  }> {
    if (samples.length === 0) {
      return [];
    }
    if (this.samples.length === 0) {
      this.startTimestampMs = timestampMs;
    }
    this.samples = appendSamples(this.samples, samples);

    const output: Array<{ samples: Float32Array; timestampMs: number; samplesPerChannel: number }> = [];
    const frameSamples = this.frameSamplesPerChannel * this.channels;
    while (this.samples.length >= frameSamples) {
      const frameTimestamp = this.startTimestampMs ?? timestampMs;
      output.push({
        samples: this.samples.slice(0, frameSamples),
        timestampMs: Math.round(frameTimestamp),
        samplesPerChannel: this.frameSamplesPerChannel,
      });
      this.samples = this.samples.slice(frameSamples);
      this.startTimestampMs = frameTimestamp + ((this.frameSamplesPerChannel / this.sampleRate) * 1000);
    }
    if (this.samples.length === 0) {
      this.startTimestampMs = null;
    }
    return output;
  }
}

class InterleavedStreamingResampler {
  private readonly channels: StreamingLinearResampler[];

  constructor(inputRate: number, outputRate: number, channelCount: number) {
    this.channels = Array.from(
      { length: channelCount },
      () => new StreamingLinearResampler(inputRate, outputRate),
    );
  }

  process(samples: Float32Array): Float32Array {
    if (samples.length === 0) {
      return new Float32Array(0);
    }
    const channelCount = this.channels.length;
    const samplesPerChannel = Math.floor(samples.length / channelCount);
    const resampledChannels = this.channels.map((resampler, channel) => {
      const channelSamples = new Float32Array(samplesPerChannel);
      for (let index = 0; index < samplesPerChannel; index += 1) {
        channelSamples[index] = samples[(index * channelCount) + channel] ?? 0;
      }
      return resampler.process(channelSamples);
    });
    const outputFrames = Math.min(...resampledChannels.map((channel) => channel.length));
    const output = new Float32Array(outputFrames * channelCount);
    for (let index = 0; index < outputFrames; index += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        output[(index * channelCount) + channel] = resampledChannels[channel]?.[index] ?? 0;
      }
    }
    return output;
  }
}

function appendSamples(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) {
    return new Float32Array(right);
  }
  const merged = new Float32Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}
