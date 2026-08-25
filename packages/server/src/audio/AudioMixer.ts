import { EventEmitter } from 'eventemitter3';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { createLogger } from '../utils/logger.js';
import {
  FrameAudioRepository,
  type FrameAudioIdentity,
  type FrameAudioSnapshot,
} from './FrameAudioRepository.js';
import { buildTrackId, normalizeStreamId } from '../transmission/TransmissionIntent.js';

const logger = createLogger('AudioMixer');

export interface MixedAudio {
  audioData: Float32Array;
  sampleRate: number;
  duration: number;
  /** Waveform time already removed from the front of this mix. */
  playbackOffsetMs?: number;
  operatorIds: string[];
  trackIds?: string[];
  tracks?: Array<{ operatorId: string; streamId: string; trackId: string; audioFrequencyHz: number }>;
  mixMetrics?: AudioMixMetrics;
  txDialShiftHz: number;
  frameId: string;
  frameRevision: number;
  slotId: string;
}

export interface AudioFrameMeta {
  frameId: string;
  frameRevision: number;
  slotId: string;
  streamId?: string;
  audioFrequencyHz?: number;
}

export interface AudioMixMetrics {
  trackCount: number;
  targetRms: number;
  actualRms: number;
  peak: number;
  crestFactor: number;
  peakBackoffApplied: boolean;
  finalLinearGain: number;
  perTrackGain: Record<string, number>;
  centerFrequenciesHz: number[];
  minimumSpacingHz?: number;
}

export interface AudioMixerOptions {
  mixingWindowMs?: number;
  multiSignalRmsBackoffDb?: number;
  multiSignalPeakCeiling?: number;
}

/** Mixes immutable, explicitly selected frame snapshots. */
export class AudioMixer extends EventEmitter {
  private readonly repository = new FrameAudioRepository();
  private mixingTimeout: NodeJS.Timeout | null = null;
  private scheduledPlaybackStartMs: number | null = null;
  private scheduledFrame: FrameAudioIdentity | null = null;

  private readonly mixingWindowMs: number;
  private readonly multiSignalRmsBackoffDb: number;
  private readonly multiSignalPeakCeiling: number;

  constructor(options: number | AudioMixerOptions = 100) {
    super();
    const resolved = typeof options === 'number' ? { mixingWindowMs: options } : options;
    this.mixingWindowMs = resolved.mixingWindowMs ?? 100;
    this.multiSignalRmsBackoffDb = resolved.multiSignalRmsBackoffDb ?? 6;
    this.multiSignalPeakCeiling = resolved.multiSignalPeakCeiling ?? 0.95;
  }

  addOperatorAudio(
    operatorId: string,
    audioData: Float32Array,
    sampleRate: number,
    slotStartMs: number,
    requestId: string | undefined,
    txDialShiftHz: number,
    frameMeta: AudioFrameMeta,
  ): void {
    const streamId = normalizeStreamId(frameMeta.streamId);
    const trackId = buildTrackId(operatorId, streamId);
    const added = this.repository.putTrack(
      {
        frameId: frameMeta.frameId,
        revision: frameMeta.frameRevision,
        slotId: frameMeta.slotId,
      },
      {
        operatorId,
        streamId,
        trackId,
        audioFrequencyHz: frameMeta.audioFrequencyHz ?? 0,
        audioData,
        sampleRate,
        slotStartMs,
        requestId,
        encodedAt: Date.now(),
      },
      txDialShiftHz,
    );
    if (!added) {
      logger.debug('Ignored duplicate encoded frame track', {
        operatorId,
        streamId,
        frameId: frameMeta.frameId,
        frameRevision: frameMeta.frameRevision,
        requestId,
      });
    }
  }

  getFrameSnapshot(frameId: string, frameRevision: number): FrameAudioSnapshot | null {
    return this.repository.getSnapshot({ frameId, revision: frameRevision });
  }

  retainFrame(frameId: string, frameRevision: number): void {
    this.repository.retain({ frameId, revision: frameRevision });
  }

  releaseFrame(frameId: string, frameRevision: number): void {
    this.repository.release({ frameId, revision: frameRevision });
  }

  cloneFrameTracks(
    source: { frameId: string; frameRevision: number },
    target: AudioFrameMeta,
    retainedTrackIds: readonly string[],
  ): FrameAudioSnapshot | null {
    return this.repository.cloneFrame(
      { frameId: source.frameId, revision: source.frameRevision },
      { frameId: target.frameId, revision: target.frameRevision, slotId: target.slotId },
      retainedTrackIds,
    );
  }

  scheduleFrameMixing(
    frame: FrameAudioIdentity,
    targetPlaybackTime?: number,
    playbackStartTime?: number,
  ): void {
    if (this.mixingTimeout) clearTimeout(this.mixingTimeout);
    this.scheduledFrame = { ...frame };
    this.scheduledPlaybackStartMs = playbackStartTime ?? null;
    let delay = this.mixingWindowMs;
    if (targetPlaybackTime !== undefined) {
      const remaining = targetPlaybackTime - Date.now();
      delay = remaining > this.mixingWindowMs
        ? Math.max(0, remaining - 50)
        : Math.max(0, remaining);
    }
    if (delay === 0) {
      void this.triggerScheduledMix();
      return;
    }
    this.mixingTimeout = setTimeout(() => {
      this.mixingTimeout = null;
      void this.triggerScheduledMix();
    }, delay);
  }

  async mixFrame(snapshot: FrameAudioSnapshot, elapsedTimeMs = 0): Promise<MixedAudio | null> {
    const tracks = Array.from(snapshot.tracks.values());
    if (tracks.length === 0) return null;
    const targetSampleRate = Math.max(...tracks.map((track) => track.sampleRate));
    const skipSamples = Math.floor((elapsedTimeMs / 1_000) * targetSampleRate);
    const processed = await Promise.all(tracks.map(async (track) => {
      let samples = track.audioData;
      if (track.sampleRate !== targetSampleRate) {
        try {
          samples = await resampleAudioProfessional(samples, track.sampleRate, targetSampleRate, 1);
        } catch (error) {
          logger.warn('Professional resample failed; using linear fallback', {
            operatorId: track.operatorId,
            error: error instanceof Error ? error.message : String(error),
          });
          samples = this.linearResample(samples, track.sampleRate, targetSampleRate);
        }
      }
      return {
        operatorId: track.operatorId,
        streamId: track.streamId,
        trackId: track.trackId,
        audioFrequencyHz: track.audioFrequencyHz,
        samples: skipSamples < samples.length
          ? samples.subarray(skipSamples)
          : new Float32Array(0),
      };
    }));
    const audible = processed.filter((track) => track.samples.length > 0);
    if (audible.length === 0) return null;

    const maxLength = Math.max(...audible.map((track) => track.samples.length));
    let audioData: Float32Array;
    let targetRms = 0;
    let peakBackoffApplied = false;
    let finalLinearGain = 1;
    const perTrackGain: Record<string, number> = {};
    if (audible.length === 1) {
      audioData = audible[0].samples;
      targetRms = this.findRmsLevel(audioData);
      perTrackGain[audible[0].trackId] = 1;
    } else {
      audioData = new Float32Array(maxLength);
      const referenceRms = Math.max(...audible.map((track) => this.findRmsLevel(track.samples)));
      targetRms = referenceRms * 10 ** (-this.multiSignalRmsBackoffDb / 20);
      const perTrackTargetRms = targetRms / Math.sqrt(audible.length);
      for (const track of audible) {
        const trackRms = this.findRmsLevel(track.samples);
        const trackGain = trackRms > 0 ? perTrackTargetRms / trackRms : 0;
        perTrackGain[track.trackId] = trackGain;
        for (let index = 0; index < track.samples.length; index += 1) {
          audioData[index] += track.samples[index] * trackGain;
        }
      }

      const mixedRms = this.findRmsLevel(audioData);
      if (mixedRms > 0 && targetRms > 0) {
        const rmsCorrection = targetRms / mixedRms;
        finalLinearGain *= rmsCorrection;
        for (let index = 0; index < audioData.length; index += 1) audioData[index] *= rmsCorrection;
      }
      const preBackoffPeak = this.findPeakLevel(audioData);
      if (preBackoffPeak > this.multiSignalPeakCeiling) {
        const ratio = this.multiSignalPeakCeiling / preBackoffPeak;
        peakBackoffApplied = true;
        finalLinearGain *= ratio;
        for (let index = 0; index < audioData.length; index += 1) audioData[index] *= ratio;
      }
    }

    const actualRms = this.findRmsLevel(audioData);
    const peak = this.findPeakLevel(audioData);
    const centerFrequenciesHz = audible
      .map((track) => track.audioFrequencyHz)
      .filter((frequency) => Number.isFinite(frequency) && frequency > 0)
      .sort((left, right) => left - right);
    let minimumSpacingHz: number | undefined;
    for (let index = 1; index < centerFrequenciesHz.length; index += 1) {
      const spacing = centerFrequenciesHz[index] - centerFrequenciesHz[index - 1];
      minimumSpacingHz = minimumSpacingHz === undefined ? spacing : Math.min(minimumSpacingHz, spacing);
    }
    const mixMetrics: AudioMixMetrics = {
      trackCount: audible.length,
      targetRms,
      actualRms,
      peak,
      crestFactor: actualRms > 0 ? peak / actualRms : 0,
      peakBackoffApplied,
      finalLinearGain,
      perTrackGain,
      centerFrequenciesHz,
      minimumSpacingHz,
    };
    if (audible.length > 1) {
      logger.info('calibrated linear multi-signal mix', mixMetrics);
      this.emit('mixMetrics', mixMetrics);
    }

    return {
      audioData,
      sampleRate: targetSampleRate,
      duration: audioData.length / targetSampleRate,
      playbackOffsetMs: Math.max(0, elapsedTimeMs),
      operatorIds: Array.from(new Set(audible.map((track) => track.operatorId))),
      trackIds: audible.map((track) => track.trackId),
      tracks: audible.map((track) => ({
        operatorId: track.operatorId,
        streamId: track.streamId,
        trackId: track.trackId,
        audioFrequencyHz: track.audioFrequencyHz,
      })),
      mixMetrics,
      txDialShiftHz: snapshot.txDialShiftHz,
      frameId: snapshot.frameId,
      frameRevision: snapshot.revision,
      slotId: snapshot.slotId,
    };
  }

  async mixFrameById(
    frameId: string,
    frameRevision: number,
    elapsedTimeMs = 0,
  ): Promise<MixedAudio | null> {
    const snapshot = this.getFrameSnapshot(frameId, frameRevision);
    return snapshot ? this.mixFrame(snapshot, elapsedTimeMs) : null;
  }

  clearFrame(frameId: string, frameRevision: number): number {
    return this.repository.removeFrame({ frameId, revision: frameRevision });
  }

  clearSlotCache(): void {
    this.cancelScheduledMix();
    this.repository.clearUnretained();
  }

  private async triggerScheduledMix(): Promise<void> {
    const frame = this.scheduledFrame;
    const playbackStart = this.scheduledPlaybackStartMs;
    this.scheduledFrame = null;
    this.scheduledPlaybackStartMs = null;
    if (!frame) return;
    const elapsedTimeMs = playbackStart === null ? 0 : Math.max(0, Date.now() - playbackStart);
    const mixed = await this.mixFrameById(frame.frameId, frame.revision, elapsedTimeMs);
    if (mixed) this.emit('mixedAudioReady', mixed);
  }

  private cancelScheduledMix(): void {
    if (this.mixingTimeout) clearTimeout(this.mixingTimeout);
    this.mixingTimeout = null;
    this.scheduledFrame = null;
    this.scheduledPlaybackStartMs = null;
  }

  private linearResample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = toRate / fromRate;
    const output = new Float32Array(Math.floor(samples.length * ratio));
    for (let index = 0; index < output.length; index += 1) {
      const sourceIndex = index / ratio;
      const base = Math.floor(sourceIndex);
      const fraction = sourceIndex - base;
      output[index] = base + 1 < samples.length
        ? samples[base] * (1 - fraction) + samples[base + 1] * fraction
        : samples[base] ?? 0;
    }
    return output;
  }

  private findPeakLevel(samples: Float32Array): number {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return peak;
  }

  private findRmsLevel(samples: Float32Array): number {
    if (samples.length === 0) return 0;
    let sumSquares = 0;
    for (const sample of samples) sumSquares += sample * sample;
    return Math.sqrt(sumSquares / samples.length);
  }
}
