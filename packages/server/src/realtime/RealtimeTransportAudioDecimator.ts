import type { RealtimeAudioFrame } from './RealtimeRxAudioSource.js';

export const REALTIME_TRANSPORT_MAX_SAMPLE_RATE = 24_000;
const MAX_REALTIME_TRANSPORT_CHANNELS = 8;

export interface RealtimeTransportAudioFrame {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  timestamp: number;
  downsampleFactor: number;
  inputSampleRate: number;
}

export function resolveRealtimeTransportDownsampleFactor(
  sampleRate: number,
): number {
  const sourceRate = normalizeSampleRate(sampleRate);
  if (sourceRate <= 0 || sourceRate <= REALTIME_TRANSPORT_MAX_SAMPLE_RATE) {
    return 1;
  }

  return Math.max(2, Math.ceil(sourceRate / REALTIME_TRANSPORT_MAX_SAMPLE_RATE));
}

export class RealtimeTransportAudioDecimator {
  private phase = 0;
  private sourceKey: string | null = null;

  process(frame: RealtimeAudioFrame): RealtimeTransportAudioFrame {
    const channels = normalizeChannelCount(frame.channels);
    const sourceRate = normalizeSampleRate(frame.sampleRate);
    const factor = resolveRealtimeTransportDownsampleFactor(sourceRate);
    const sourceKey = `${frame.sourceKind}:${frame.nativeSourceKind ?? ''}:${sourceRate}:${channels}:${factor}`;
    const timestamp = normalizeTimestamp(frame.timestamp);

    if (this.sourceKey !== sourceKey) {
      this.sourceKey = sourceKey;
      this.phase = 0;
    }

    const inputSamplesPerChannel = Math.floor(frame.samples.length / channels);
    if (sourceRate <= 0 || inputSamplesPerChannel <= 0) {
      return this.emptyFrame(sourceRate, channels, factor, timestamp);
    }

    if (factor <= 1) {
      return {
        samples: frame.samples,
        sampleRate: sourceRate,
        channels,
        samplesPerChannel: inputSamplesPerChannel,
        timestamp,
        downsampleFactor: 1,
        inputSampleRate: sourceRate,
      };
    }

    const firstOutputSourceIndex = (factor - this.phase) % factor;
    const outputSamplesPerChannel = firstOutputSourceIndex >= inputSamplesPerChannel
      ? 0
      : 1 + Math.floor((inputSamplesPerChannel - 1 - firstOutputSourceIndex) / factor);
    if (outputSamplesPerChannel <= 0) {
      this.phase = (this.phase + inputSamplesPerChannel) % factor;
      return this.emptyFrame(sourceRate, channels, factor, timestamp);
    }

    const output = new Float32Array(outputSamplesPerChannel * channels);
    const firstOutputTimestamp = Math.round(timestamp + ((firstOutputSourceIndex / sourceRate) * 1000));

    for (
      let sourceIndex = firstOutputSourceIndex, outputFrameIndex = 0;
      sourceIndex < inputSamplesPerChannel;
      sourceIndex += factor, outputFrameIndex += 1
    ) {
      const outputBase = outputFrameIndex * channels;
      const inputBase = sourceIndex * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        output[outputBase + channel] = frame.samples[inputBase + channel] ?? 0;
      }
    }
    this.phase = (this.phase + inputSamplesPerChannel) % factor;

    return {
      samples: output,
      sampleRate: resolveOutputSampleRate(sourceRate, factor),
      channels,
      samplesPerChannel: outputSamplesPerChannel,
      timestamp: firstOutputTimestamp,
      downsampleFactor: factor,
      inputSampleRate: sourceRate,
    };
  }

  private emptyFrame(
    sourceRate: number,
    channels: number,
    factor: number,
    timestamp: number,
  ): RealtimeTransportAudioFrame {
    return {
      samples: new Float32Array(0),
      sampleRate: resolveOutputSampleRate(sourceRate, factor),
      channels,
      samplesPerChannel: 0,
      timestamp,
      downsampleFactor: factor > 1 ? factor : 1,
      inputSampleRate: sourceRate,
    };
  }
}

function normalizeSampleRate(sampleRate: number): number {
  const rounded = Math.round(sampleRate);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
}

function normalizeChannelCount(channels: number): number {
  const normalized = Math.floor(channels);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 1;
  }
  return Math.min(normalized, MAX_REALTIME_TRANSPORT_CHANNELS);
}

function resolveOutputSampleRate(sourceRate: number, factor: number): number {
  return sourceRate > 0 && factor > 1
    ? Math.round(sourceRate / factor)
    : sourceRate;
}

function normalizeTimestamp(timestamp: number): number {
  return Number.isFinite(timestamp) ? Math.round(timestamp) : Date.now();
}
