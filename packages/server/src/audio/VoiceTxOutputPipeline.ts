import { performance } from 'node:perf_hooks';
import { StreamingLinearResampler } from '../realtime/StreamingAudioResampler.js';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';
import type { VoiceTxOutputObserver } from './AudioStreamManager.js';

const TARGET_INITIAL_MS = 40;
const TARGET_MIN_MS = 30;
const TARGET_MAX_MS = 140;
const TARGET_HEADROOM_MS = 20;
const STALE_FRAME_MS = 200;
const TARGET_INCREASE_MS = 20;
const TARGET_DECREASE_MS = 10;
const TARGET_INCREASE_COOLDOWN_MS = 1000;
const TARGET_DECREASE_AFTER_MS = 5000;
const TARGET_DECREASE_COOLDOWN_MS = 3000;
const MAX_PLC_CHUNKS = 2;

export interface VoiceTxOutputSinkState {
  available: boolean;
  kind: 'rtaudio' | 'icom-wlan';
  outputSampleRate: number;
  outputBufferSize: number;
}

export interface VoiceTxOutputPipelineDeps {
  getSinkState: () => VoiceTxOutputSinkState;
  getObserver: () => VoiceTxOutputObserver | null;
  getVolumeGain: () => number;
  writeOutputChunk: (samples: Float32Array, sink: VoiceTxOutputSinkState) => Promise<boolean> | boolean;
}

interface VoiceTxQueuedSegment {
  samples: Float32Array;
  meta: VoiceTxFrameMeta;
  enqueuedAt: number;
  resampleMs: number;
  offset: number;
}

interface ConsumedVoiceChunk {
  samples: Float32Array;
  meta: VoiceTxFrameMeta | null;
  enqueuedAt: number | null;
  resampleMs: number;
}

export class VoiceTxOutputPipeline {
  private readonly queue: VoiceTxQueuedSegment[] = [];
  private resampler: StreamingLinearResampler | null = null;
  private resamplerInputRate = 0;
  private resamplerOutputRate = 0;
  private queuedSamples = 0;
  private outputTimer: NodeJS.Timeout | null = null;
  private outputLoopActive = false;
  private outputEnabled = true;
  private playoutStarted = false;
  private adaptiveTargetMs = TARGET_INITIAL_MS;
  private lastUnderrunAt = 0;
  private lastTargetChangeAt = 0;
  private lastOutputWriteAt: number | null = null;
  private lastOutputSample = 0;
  private consecutivePlcChunks = 0;
  private underrunCount = 0;
  private plcFrames = 0;
  private lastSequence: number | null = null;
  private generation = 0;

  constructor(private readonly deps: VoiceTxOutputPipelineDeps) {}

  ingest(pcmData: Float32Array, frameSampleRate: number, meta: VoiceTxFrameMeta): void {
    const sink = this.deps.getSinkState();
    if (!sink.available || sink.outputSampleRate <= 0 || sink.outputBufferSize <= 0) {
      this.dropFrame(meta, 'output-unavailable');
      return;
    }

    const now = Date.now();
    if (typeof meta.clientSentAtMs === 'number' && (now - meta.clientSentAtMs) > STALE_FRAME_MS) {
      this.dropFrame(meta, 'stale');
      return;
    }

    if (this.hasSequenceGap(meta.sequence)) {
      this.noteUnderrun(now);
    }

    const resampleStart = performance.now();
    const playbackFrame = this.resample(pcmData, frameSampleRate, sink.outputSampleRate);
    const resampleMs = performance.now() - resampleStart;
    if (playbackFrame.length === 0) {
      return;
    }

    this.queue.push({
      samples: playbackFrame,
      meta,
      enqueuedAt: now,
      resampleMs,
      offset: 0,
    });
    this.queuedSamples += playbackFrame.length;
    this.deps.getObserver()?.onFrameEnqueued?.({
      meta,
      queueDepthFrames: this.queue.length,
      queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
    });

    this.trimQueue(sink, meta);
    if (this.outputEnabled) {
      this.ensureOutputLoop();
    }
  }

  setOutputEnabled(enabled: boolean): void {
    this.outputEnabled = enabled;
    if (enabled && this.queue.length > 0) {
      this.ensureOutputLoop();
    }
  }

  clear(): void {
    this.generation += 1;
    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
    this.queue.length = 0;
    this.queuedSamples = 0;
    this.outputLoopActive = false;
    this.playoutStarted = false;
    this.resampler?.reset();
    this.resampler = null;
    this.resamplerInputRate = 0;
    this.resamplerOutputRate = 0;
    this.adaptiveTargetMs = TARGET_INITIAL_MS;
    this.lastUnderrunAt = 0;
    this.lastTargetChangeAt = 0;
    this.lastOutputWriteAt = null;
    this.lastOutputSample = 0;
    this.consecutivePlcChunks = 0;
    this.underrunCount = 0;
    this.plcFrames = 0;
    this.lastSequence = null;
  }

  getQueuedMs(outputSampleRate = this.deps.getSinkState().outputSampleRate): number {
    if (!outputSampleRate || outputSampleRate <= 0) {
      return 0;
    }
    return (this.queuedSamples / outputSampleRate) * 1000;
  }

  getQueueDepthFrames(): number {
    return this.queue.length;
  }

  private ensureOutputLoop(): void {
    if (this.outputTimer || this.outputLoopActive) {
      return;
    }
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    this.outputTimer = setTimeout(() => {
      this.outputTimer = null;
      void this.outputTick();
    }, Math.max(1, delayMs));
  }

  private async outputTick(): Promise<void> {
    if (this.outputLoopActive) {
      return;
    }
    this.outputLoopActive = true;
    const startedAt = performance.now();
    const generation = this.generation;

    try {
      const sink = this.deps.getSinkState();
      if (!this.outputEnabled) {
        return;
      }
      if (!sink.available || sink.outputSampleRate <= 0 || sink.outputBufferSize <= 0) {
        this.clear();
        return;
      }

      this.maybeReduceTarget(Date.now());
      const queueMs = this.getQueuedMs(sink.outputSampleRate);
      const chunkMs = (sink.outputBufferSize / sink.outputSampleRate) * 1000;
      if (!this.playoutStarted && queueMs < this.adaptiveTargetMs && this.queue.length > 0) {
        this.scheduleNextTick(Math.min(chunkMs / 2, 5));
        return;
      }

      if (this.queue.length === 0 && this.consecutivePlcChunks >= MAX_PLC_CHUNKS) {
        this.playoutStarted = false;
        return;
      }

      if (this.queue.length > 0) {
        this.playoutStarted = true;
      }

      const consumed = this.queue.length > 0
        ? this.consumeChunk(sink.outputBufferSize)
        : this.createPlcChunk(sink.outputBufferSize);
      if (consumed.samples.length < sink.outputBufferSize) {
        this.noteUnderrun(Date.now());
        consumed.samples = this.padChunk(consumed.samples, sink.outputBufferSize);
      }

      const processed = this.applyGain(consumed.samples);
      const writeStart = performance.now();
      const writeOk = await this.deps.writeOutputChunk(processed, sink);
      const writeMs = performance.now() - writeStart;
      if (generation !== this.generation) {
        return;
      }
      const writeAt = Date.now();
      const outputWriteIntervalMs = this.lastOutputWriteAt === null
        ? null
        : Math.max(0, writeAt - this.lastOutputWriteAt);
      this.lastOutputWriteAt = writeAt;

      if (!writeOk) {
        this.deps.getObserver()?.onWriteFailure?.({
          meta: consumed.meta ?? this.fallbackMeta(),
          queueDepthFrames: this.queue.length,
          queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
        });
      } else if (consumed.meta) {
        const outputBufferedMs = this.getQueuedMs(sink.outputSampleRate) + chunkMs;
        const queueWaitMs = consumed.enqueuedAt === null ? 0 : Math.max(0, writeAt - consumed.enqueuedAt);
        const serverPipelineMs = Math.max(0, writeAt - consumed.meta.serverReceivedAtMs);
        const endToEndMs = typeof consumed.meta.clientSentAtMs === 'number'
          ? Math.max(0, writeAt - consumed.meta.clientSentAtMs)
          : null;
        this.deps.getObserver()?.onFrameProcessed?.({
          meta: consumed.meta,
          queueDepthFrames: this.queue.length,
          queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
          resampleMs: consumed.resampleMs,
          queueWaitMs,
          writeMs,
          serverPipelineMs,
          endToEndMs,
          outputBufferedMs,
          outputSampleRate: sink.outputSampleRate,
          outputBufferSize: sink.outputBufferSize,
          outputWriteIntervalMs,
          jitterTargetMs: this.adaptiveTargetMs,
          underrunCount: this.underrunCount,
          plcFrames: this.plcFrames,
        });
      }

      if (this.queue.length > 0 || this.consecutivePlcChunks < MAX_PLC_CHUNKS) {
        const elapsedMs = performance.now() - startedAt;
        this.scheduleNextTick(Math.max(1, chunkMs - elapsedMs));
      }
    } finally {
      this.outputLoopActive = false;
    }
  }

  private consumeChunk(sampleCount: number): ConsumedVoiceChunk {
    const out = new Float32Array(sampleCount);
    let outOffset = 0;
    let firstMeta: VoiceTxFrameMeta | null = null;
    let firstEnqueuedAt: number | null = null;
    let resampleMs = 0;

    while (outOffset < sampleCount && this.queue.length > 0) {
      const segment = this.queue[0]!;
      if (!firstMeta) {
        firstMeta = segment.meta;
        firstEnqueuedAt = segment.enqueuedAt;
        resampleMs = segment.resampleMs;
      }

      const available = segment.samples.length - segment.offset;
      const take = Math.min(sampleCount - outOffset, available);
      out.set(segment.samples.subarray(segment.offset, segment.offset + take), outOffset);
      outOffset += take;
      segment.offset += take;
      this.queuedSamples = Math.max(0, this.queuedSamples - take);

      if (segment.offset >= segment.samples.length) {
        this.queue.shift();
      }
    }

    if (outOffset > 0) {
      this.lastOutputSample = out[outOffset - 1] ?? this.lastOutputSample;
      this.consecutivePlcChunks = 0;
    }

    return {
      samples: outOffset === sampleCount ? out : out.subarray(0, outOffset),
      meta: firstMeta,
      enqueuedAt: firstEnqueuedAt,
      resampleMs,
    };
  }

  private createPlcChunk(sampleCount: number): ConsumedVoiceChunk {
    this.noteUnderrun(Date.now());
    this.plcFrames += 1;
    this.consecutivePlcChunks += 1;
    const out = new Float32Array(sampleCount);
    let value = this.lastOutputSample;
    for (let index = 0; index < out.length; index += 1) {
      value *= 0.92;
      out[index] = value;
    }
    this.lastOutputSample = value;
    return {
      samples: out,
      meta: null,
      enqueuedAt: null,
      resampleMs: 0,
    };
  }

  private padChunk(samples: Float32Array, sampleCount: number): Float32Array {
    const out = new Float32Array(sampleCount);
    out.set(samples.subarray(0, Math.min(samples.length, sampleCount)));
    let value = samples.length > 0 ? samples[samples.length - 1]! : this.lastOutputSample;
    for (let index = samples.length; index < sampleCount; index += 1) {
      value *= 0.92;
      out[index] = value;
    }
    this.lastOutputSample = value;
    return out;
  }

  private trimQueue(sink: VoiceTxOutputSinkState, meta: VoiceTxFrameMeta): void {
    const maxQueueMs = this.adaptiveTargetMs + TARGET_HEADROOM_MS;
    if (this.getQueuedMs(sink.outputSampleRate) <= maxQueueMs) {
      return;
    }

    const trimToSamples = Math.ceil((this.adaptiveTargetMs / 1000) * sink.outputSampleRate);
    while (this.queue.length > 0 && this.queuedSamples > trimToSamples) {
      const segment = this.queue[0]!;
      const overSamples = this.queuedSamples - trimToSamples;
      const available = segment.samples.length - segment.offset;
      const drop = Math.min(overSamples, available);
      segment.offset += drop;
      this.queuedSamples = Math.max(0, this.queuedSamples - drop);
      if (segment.offset >= segment.samples.length) {
        this.queue.shift();
      }
      if (drop > 0) {
        this.deps.getObserver()?.onFrameDropped?.({
          meta,
          queueDepthFrames: this.queue.length,
          queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
          reason: 'jitter-trim',
        });
      }
    }
  }

  private resample(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) {
      return new Float32Array(samples);
    }
    if (
      !this.resampler
      || this.resamplerInputRate !== inputRate
      || this.resamplerOutputRate !== outputRate
    ) {
      this.resampler = new StreamingLinearResampler(inputRate, outputRate);
      this.resamplerInputRate = inputRate;
      this.resamplerOutputRate = outputRate;
    }
    return this.resampler.process(samples);
  }

  private applyGain(samples: Float32Array): Float32Array {
    const gain = this.deps.getVolumeGain();
    const out = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]! * gain;
      out[index] = sample > 1 ? 1 : (sample < -1 ? -1 : sample);
    }
    return out;
  }

  private dropFrame(meta: VoiceTxFrameMeta, reason: 'backpressure' | 'output-unavailable' | 'stale' | 'jitter-trim'): void {
    this.deps.getObserver()?.onFrameDropped?.({
      meta,
      queueDepthFrames: this.queue.length,
      queuedAudioMs: this.getQueuedMs(),
      reason,
    });
  }

  private hasSequenceGap(sequence?: number | null): boolean {
    if (typeof sequence !== 'number') {
      return false;
    }
    const hasGap = this.lastSequence !== null && sequence > this.lastSequence + 1;
    this.lastSequence = sequence;
    return hasGap;
  }

  private noteUnderrun(now: number): void {
    this.underrunCount += 1;
    this.lastUnderrunAt = now;
    if ((now - this.lastTargetChangeAt) >= TARGET_INCREASE_COOLDOWN_MS) {
      this.adaptiveTargetMs = Math.min(TARGET_MAX_MS, this.adaptiveTargetMs + TARGET_INCREASE_MS);
      this.lastTargetChangeAt = now;
    }
  }

  private maybeReduceTarget(now: number): void {
    if (this.adaptiveTargetMs <= TARGET_MIN_MS) {
      return;
    }
    if ((now - this.lastUnderrunAt) < TARGET_DECREASE_AFTER_MS) {
      return;
    }
    if ((now - this.lastTargetChangeAt) < TARGET_DECREASE_COOLDOWN_MS) {
      return;
    }
    this.adaptiveTargetMs = Math.max(TARGET_MIN_MS, this.adaptiveTargetMs - TARGET_DECREASE_MS);
    this.lastTargetChangeAt = now;
  }

  private fallbackMeta(): VoiceTxFrameMeta {
    const now = Date.now();
    return {
      transport: 'ws-compat',
      participantIdentity: 'unknown',
      sequence: null,
      clientSentAtMs: null,
      serverReceivedAtMs: now,
      sampleRate: 0,
      samplesPerChannel: 0,
    };
  }
}
