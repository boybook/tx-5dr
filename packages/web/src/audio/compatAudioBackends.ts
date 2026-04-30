import {
  RealtimeJitterEstimator,
  type RealtimeJitterEstimatorSnapshot,
  type RealtimeTimingProbeMessage,
} from '@tx5dr/core';
import { createLogger } from '../utils/logger';
import { detectBrowserAudioRuntime, isAudioWorkletSupported } from './browserAudioRuntime';
import {
  DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE,
  resolveMonitorPlaybackBufferPolicy,
  type MonitorPlaybackBufferPreference,
  type ResolvedMonitorPlaybackBufferPolicy,
} from './monitorPlaybackBufferPreference';

const logger = createLogger('CompatAudioBackends');
const PLAYBACK_STATS_INTERVAL_MS = 250;
const PLAYBACK_BUFFER_SIZE = 1024;
const PLAYBACK_PLC_TAIL_MS = 8;
const PLAYBACK_PLC_RESTORE_CROSSFADE_MS = 3;
const PLAYBACK_JITTER_MAX_LOG_INTERVAL_MS = 2000;
const CAPTURE_BUFFER_SIZE = 1024;
const CAPTURE_FRAME_SAMPLES = 320;
const CAPTURE_TARGET_SAMPLE_RATE = 16000;

function stringifyJitterDebugPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export interface CompatPlaybackStats {
  latencyMs: number;
  bufferFillPercent: number;
  droppedSamples: number;
  queueDurationMs: number;
  targetBufferMs: number;
  outputSourceTimestampMs: number | null;
  nextOutputSourceTimestampMs: number | null;
  mainToWorkletMs: number | null;
  statsGeneratedAtMs: number;
  underrunCount: number;
  inputSampleRate?: number;
  jitterP95Ms?: number;
  jitterEwmaMs?: number;
}

export interface CompatPlaybackBackend {
  readonly backendType: 'audio-worklet' | 'script-processor';
  readonly outputNode: AudioNode;
  handleAudioData(data: {
    buffer: ArrayBuffer;
    sampleRate: number;
    clientTimestamp: number;
    clientReceivedAtMs?: number;
    sequence?: number;
    frameDurationMs?: number;
    serverSentAtMs?: number;
  }): void;
  setBufferPreference(preference: MonitorPlaybackBufferPreference, initialTargetMs?: number | null): void;
  recordTimingProbe?(probe: RealtimeTimingProbeMessage, receivedAtMs?: number): void;
  reset(): void;
  close(): void;
}

export interface CompatCaptureFrame {
  sampleRate: number;
  samplesPerChannel: number;
  buffer: ArrayBuffer;
  capturedAtMs?: number;
}

export interface CompatCaptureBackend {
  readonly backendType: 'audio-worklet' | 'script-processor';
  readonly inputNode: AudioNode;
  setFrameHandler(handler: ((frame: CompatCaptureFrame) => void) | null): void;
  reset(): void;
  close(): void;
}

function mergeFloat32(left: Float32Array, right: Float32Array): Float32Array {
  const merged = new Float32Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

class ScriptProcessorPlaybackBackend implements CompatPlaybackBackend {
  readonly backendType = 'script-processor' as const;
  readonly outputNode: ScriptProcessorNode;

  private readonly outputSampleRate: number;
  private readonly ringBufferSize: number;
  private readonly ringBuffer: Float32Array;
  private readonly timestampBuffer: Float64Array;
  private readonly onStats: (stats: CompatPlaybackStats) => void;

  private writeIndex = 0;
  private readIndex = 0;
  private availableSamples = 0;
  private totalDroppedSamples = 0;
  private totalUnderrunCount = 0;
  private consecutiveUnderrunFrames = 0;
  private isPlaying = false;
  private isRecovering = false;
  private bufferPolicy: ResolvedMonitorPlaybackBufferPolicy;
  private adaptiveTargetMs: number;
  private jitterEstimator: RealtimeJitterEstimator | null = null;
  private jitterEstimatorSource: 'probe' | 'packet' | null = null;
  private lastJitterSnapshot: RealtimeJitterEstimatorSnapshot | null = null;
  private lastLoggedJitterTargetMs: number | null = null;
  private lastLoggedJitterMaxAtMs = 0;
  private lastUnderrunAt = 0;
  private lastTargetChangeAt = 0;
  private lastStatsAt = 0;
  private plcHistory = new Float32Array(0);
  private restoreCrossfadePending = false;
  private lastOutputSourceTimestampMs: number | null = null;
  private lastMainToWorkletMs: number | null = null;
  private lastInputSampleRate: number;
  private resampleInputBuffer = new Float32Array(0);
  private resampleSourcePosition = 0;
  private resampleInputRate: number;

  constructor(
    audioContext: AudioContext,
    onStats: (stats: CompatPlaybackStats) => void,
    bufferPreference?: MonitorPlaybackBufferPreference,
    initialTargetMs?: number | null,
  ) {
    this.outputSampleRate = audioContext.sampleRate;
    this.ringBufferSize = Math.max(Math.ceil(this.outputSampleRate * 2), 48000);
    this.ringBuffer = new Float32Array(this.ringBufferSize);
    this.timestampBuffer = new Float64Array(this.ringBufferSize);
    this.timestampBuffer.fill(Number.NaN);
    this.onStats = onStats;
    this.resampleInputRate = this.outputSampleRate;
    this.lastInputSampleRate = this.outputSampleRate;
    this.bufferPolicy = resolveMonitorPlaybackBufferPolicy(bufferPreference, { initialTargetMs });
    this.adaptiveTargetMs = this.bufferPolicy.initialTargetMs;
    this.recreateJitterEstimator(Date.now());
    const now = Date.now();
    this.lastUnderrunAt = now;
    this.lastTargetChangeAt = now;
    this.outputNode = audioContext.createScriptProcessor(PLAYBACK_BUFFER_SIZE, 0, 1);
    this.outputNode.onaudioprocess = (event) => {
      this.process(event);
    };
  }

  handleAudioData(data: {
    buffer: ArrayBuffer;
    sampleRate: number;
    clientTimestamp: number;
    clientReceivedAtMs?: number;
    sequence?: number;
    frameDurationMs?: number;
    serverSentAtMs?: number;
  }): void {
    const samples = new Float32Array(data.buffer);
    this.lastMainToWorkletMs = typeof data.clientReceivedAtMs === 'number'
      ? Math.max(0, Date.now() - data.clientReceivedAtMs)
      : 0;
    const inputRate = Number(data.sampleRate) > 0 ? Number(data.sampleRate) : this.outputSampleRate;
    this.lastInputSampleRate = inputRate;
    const resampled = this.resampleToOutputRate(samples, inputRate);
    this.notePacketJitter({
      sequence: data.sequence,
      arrivalTimeMs: typeof data.clientReceivedAtMs === 'number' ? data.clientReceivedAtMs : Date.now(),
      frameDurationMs: data.frameDurationMs,
    });
    this.enqueueSamples(resampled, Number(data.clientTimestamp));
  }

  setBufferPreference(preference: MonitorPlaybackBufferPreference, initialTargetMs?: number | null): void {
    this.bufferPolicy = resolveMonitorPlaybackBufferPolicy(preference, { initialTargetMs });
    this.reset();
  }

  recordTimingProbe(probe: RealtimeTimingProbeMessage, receivedAtMs = Date.now()): void {
    if (!this.bufferPolicy.adaptive || !this.jitterEstimator) {
      return;
    }
    if (this.jitterEstimatorSource === 'packet') {
      return;
    }
    this.jitterEstimatorSource = 'probe';
    this.lastJitterSnapshot = this.jitterEstimator.recordProbe({
      sequence: probe.sequence,
      sentAtMs: probe.sentAtMs,
      intervalMs: probe.intervalMs,
      arrivalTimeMs: receivedAtMs,
    });
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.logJitterSnapshot('probe');
  }

  reset(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableSamples = 0;
    this.totalDroppedSamples = 0;
    this.totalUnderrunCount = 0;
    this.consecutiveUnderrunFrames = 0;
    this.isPlaying = false;
    this.isRecovering = false;
    this.adaptiveTargetMs = this.bufferPolicy.initialTargetMs;
    const now = Date.now();
    this.recreateJitterEstimator(now);
    this.lastUnderrunAt = now;
    this.lastTargetChangeAt = now;
    this.lastStatsAt = 0;
    this.plcHistory = new Float32Array(0);
    this.restoreCrossfadePending = false;
    this.lastOutputSourceTimestampMs = null;
    this.lastMainToWorkletMs = null;
    this.timestampBuffer.fill(Number.NaN);
    this.resampleInputBuffer = new Float32Array(0);
    this.resampleSourcePosition = 0;
    this.resampleInputRate = this.outputSampleRate;
    this.lastInputSampleRate = this.outputSampleRate;
  }

  close(): void {
    this.outputNode.onaudioprocess = null;
    try {
      this.outputNode.disconnect();
    } catch {
      // ignore
    }
  }

  private enqueueSamples(samples: Float32Array, sourceTimestampMs: number): void {
    if (!samples || samples.length === 0) {
      return;
    }

    const freeSpace = this.ringBufferSize - this.availableSamples;
    if (samples.length > freeSpace) {
      const dropCount = samples.length - freeSpace;
      this.readIndex = (this.readIndex + dropCount) % this.ringBufferSize;
      this.availableSamples -= dropCount;
      this.totalDroppedSamples += dropCount;
    }

    for (let index = 0; index < samples.length; index += 1) {
      this.ringBuffer[this.writeIndex] = samples[index];
      this.timestampBuffer[this.writeIndex] = Number.isFinite(sourceTimestampMs)
        ? sourceTimestampMs + ((index / this.outputSampleRate) * 1000)
        : Number.NaN;
      this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize;
    }

    this.availableSamples = Math.min(this.availableSamples + samples.length, this.ringBufferSize);
    this.trimExcessQueue();
  }

  private trimExcessQueue(): void {
    const maxQueueSamples = Math.ceil(((this.adaptiveTargetMs + this.bufferPolicy.queueHeadroomMs) / 1000) * this.outputSampleRate);
    if (this.availableSamples <= maxQueueSamples) {
      return;
    }

    const trimToSamples = Math.ceil((this.adaptiveTargetMs / 1000) * this.outputSampleRate);
    const dropCount = Math.max(0, this.availableSamples - trimToSamples);
    if (dropCount <= 0) {
      return;
    }

    this.readIndex = (this.readIndex + dropCount) % this.ringBufferSize;
    this.availableSamples -= dropCount;
    this.totalDroppedSamples += dropCount;
  }

  private process(event: AudioProcessingEvent): void {
    const output = event.outputBuffer.getChannelData(0);
    const bufferMs = this.availableSamples / (this.outputSampleRate / 1000);

    if (!this.isPlaying || this.isRecovering) {
      output.fill(0);
      if (bufferMs >= this.adaptiveTargetMs) {
        this.isPlaying = true;
        this.isRecovering = false;
        this.consecutiveUnderrunFrames = 0;
      }
      this.maybeReportStats();
      return;
    }

    let hadUnderrun = false;
    let outputSourceTimestampMs: number | null = null;
    let realSamples = 0;
    while (realSamples < output.length && this.availableSamples > 0) {
      const sample = this.ringBuffer[this.readIndex];
      const sourceTimestampMs = this.timestampBuffer[this.readIndex];
      output[realSamples] = sample;
      outputSourceTimestampMs = Number.isFinite(sourceTimestampMs) ? sourceTimestampMs : null;
      this.readIndex = (this.readIndex + 1) % this.ringBufferSize;
      this.availableSamples -= 1;
      realSamples += 1;
    }
    if (realSamples > 0) {
      this.applyRestoreCrossfade(output, realSamples);
      this.recordRealOutput(output.subarray(0, realSamples));
    }
    if (realSamples < output.length) {
      output.fill(0, realSamples);
      this.fillTailPlc(output, realSamples);
      hadUnderrun = true;
    }

    if (hadUnderrun) {
      this.totalUnderrunCount += 1;
      this.consecutiveUnderrunFrames += 1;
      this.noteUnderrun(Date.now());
    } else {
      this.consecutiveUnderrunFrames = 0;
    }
    this.lastOutputSourceTimestampMs = outputSourceTimestampMs;

    this.maybeReportStats();
  }

  private maybeReportStats(): void {
    const now = Date.now();
    this.maybeReduceTarget(now);
    if ((now - this.lastStatsAt) < PLAYBACK_STATS_INTERVAL_MS) {
      return;
    }

    const queueDurationMs = this.availableSamples / (this.outputSampleRate / 1000);
    const nextOutputSourceTimestampMs = this.availableSamples > 0 && Number.isFinite(this.timestampBuffer[this.readIndex])
      ? this.timestampBuffer[this.readIndex]
      : null;
    this.onStats({
      latencyMs: queueDurationMs,
      queueDurationMs,
      targetBufferMs: this.adaptiveTargetMs,
      bufferFillPercent: Math.max(0, Math.min(100, (queueDurationMs / Math.max(this.adaptiveTargetMs, 1)) * 100)),
      droppedSamples: this.totalDroppedSamples,
      outputSourceTimestampMs: this.lastOutputSourceTimestampMs,
      nextOutputSourceTimestampMs,
      mainToWorkletMs: this.lastMainToWorkletMs,
      statsGeneratedAtMs: now,
      underrunCount: this.totalUnderrunCount,
      inputSampleRate: this.lastInputSampleRate,
      jitterP95Ms: this.lastJitterSnapshot?.relativeDelayP95Ms,
      jitterEwmaMs: this.lastJitterSnapshot?.jitterEwmaMs,
    });
    this.lastStatsAt = now;
  }

  private noteUnderrun(now: number): void {
    this.lastUnderrunAt = now;
    if (this.bufferPolicy.adaptive) {
      this.lastJitterSnapshot = this.jitterEstimator?.noteUnderrun(now) ?? null;
      this.adaptiveTargetMs = this.lastJitterSnapshot?.activeTargetMs ?? Math.min(
        this.bufferPolicy.maxTargetMs,
        this.adaptiveTargetMs + this.bufferPolicy.targetIncreaseMs,
      );
      this.logJitterSnapshot('underrun');
      this.lastTargetChangeAt = now;
    }
    if (this.consecutiveUnderrunFrames >= this.bufferPolicy.underrunRecoveryFrames) {
      this.isRecovering = true;
    }
  }

  private maybeReduceTarget(now: number): void {
    if (!this.bufferPolicy.adaptive || !this.jitterEstimator) {
      return;
    }
    this.lastJitterSnapshot = this.jitterEstimator.maybeUpdate(now);
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.logJitterSnapshot('timer');
  }

  private notePacketJitter(sample: {
    sequence?: number;
    mediaTimestampMs?: number;
    arrivalTimeMs: number;
    frameDurationMs?: number;
  }): void {
    if (!this.bufferPolicy.adaptive || !this.jitterEstimator) {
      return;
    }
    if (this.jitterEstimatorSource !== 'packet') {
      this.jitterEstimator.reset({
        initialTargetMs: this.adaptiveTargetMs,
        nowMs: sample.arrivalTimeMs,
      });
      this.jitterEstimatorSource = 'packet';
    }
    this.lastJitterSnapshot = this.jitterEstimator.recordPacket(sample);
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.logJitterSnapshot('packet');
  }

  private recreateJitterEstimator(now: number): void {
    if (!this.bufferPolicy.adaptive) {
      this.jitterEstimator = null;
      this.jitterEstimatorSource = null;
      this.lastJitterSnapshot = null;
      return;
    }
    this.jitterEstimator = new RealtimeJitterEstimator({
      minTargetMs: this.bufferPolicy.minTargetMs,
      initialTargetMs: this.bufferPolicy.initialTargetMs,
      softFloorMs: this.bufferPolicy.targetBufferMs,
      maxTargetMs: this.bufferPolicy.maxTargetMs,
      frameDurationMs: 20,
      basePreRollMs: 60,
      schedulingMarginMs: 10,
      decreaseAfterMs: this.bufferPolicy.adaptDecreaseAfterMs,
      decreaseStepMs: 20,
      underrunIncreaseMs: 20,
      nowMs: now,
    });
    this.jitterEstimatorSource = null;
    this.lastJitterSnapshot = this.jitterEstimator.getSnapshot(now);
    this.lastLoggedJitterTargetMs = null;
  }

  private logJitterSnapshot(reason: 'probe' | 'packet' | 'underrun' | 'timer'): void {
    if (!this.lastJitterSnapshot) {
      return;
    }
    const targetChanged = this.lastLoggedJitterTargetMs !== this.lastJitterSnapshot.activeTargetMs;
    const isAtMax = this.lastJitterSnapshot.activeTargetMs >= this.bufferPolicy.maxTargetMs;
    const now = Date.now();
    const shouldRepeatMaxLog = isAtMax && (now - this.lastLoggedJitterMaxAtMs) >= PLAYBACK_JITTER_MAX_LOG_INTERVAL_MS;
    if (!targetChanged && !shouldRepeatMaxLog) {
      return;
    }
    this.lastLoggedJitterTargetMs = this.lastJitterSnapshot.activeTargetMs;
    if (isAtMax) {
      this.lastLoggedJitterMaxAtMs = now;
    }
    const payload = {
      reason,
      backend: this.backendType,
      source: this.jitterEstimatorSource,
      targetMs: this.lastJitterSnapshot.activeTargetMs,
      recommendedMs: this.lastJitterSnapshot.recommendedTargetMs,
      p95Ms: this.lastJitterSnapshot.relativeDelayP95Ms,
      jitterEwmaMs: this.lastJitterSnapshot.jitterEwmaMs,
      sampleCount: this.lastJitterSnapshot.sampleCount,
      lastSample: this.lastJitterSnapshot.lastSample,
      queueMs: this.availableSamples / (this.outputSampleRate / 1000),
      underruns: this.totalUnderrunCount,
      policy: this.bufferPolicy,
      isAtMax,
    };
    if (isAtMax) {
      logger.warn(`Monitor jitter target reached max ${stringifyJitterDebugPayload(payload)}`);
    } else {
      logger.debug(`Monitor jitter target changed ${stringifyJitterDebugPayload(payload)}`);
    }
  }

  private fillTailPlc(output: Float32Array, offset: number): void {
    if (this.consecutiveUnderrunFrames > 0 || this.plcHistory.length === 0 || offset >= output.length) {
      return;
    }
    const maxPlcSamples = Math.ceil((PLAYBACK_PLC_TAIL_MS / 1000) * this.outputSampleRate);
    const plcSamples = Math.min(output.length - offset, maxPlcSamples, this.plcHistory.length);
    const sourceSamples = Math.min(this.plcHistory.length, maxPlcSamples);
    const sourceStart = this.plcHistory.length - sourceSamples;
    for (let index = 0; index < plcSamples; index += 1) {
      const phase = plcSamples <= 1 ? 1 : index / (plcSamples - 1);
      const fade = Math.cos((phase * Math.PI) / 2);
      output[offset + index] = this.plcHistory[sourceStart + (index % sourceSamples)]! * fade;
    }
    this.restoreCrossfadePending = true;
  }

  private applyRestoreCrossfade(output: Float32Array, realSamples: number): void {
    if (!this.restoreCrossfadePending || this.plcHistory.length === 0) {
      this.restoreCrossfadePending = false;
      return;
    }
    const crossfadeSamples = Math.min(
      realSamples,
      this.plcHistory.length,
      Math.ceil((PLAYBACK_PLC_RESTORE_CROSSFADE_MS / 1000) * this.outputSampleRate),
    );
    const historyStart = this.plcHistory.length - crossfadeSamples;
    for (let index = 0; index < crossfadeSamples; index += 1) {
      const wet = (index + 1) / (crossfadeSamples + 1);
      output[index] = (this.plcHistory[historyStart + index]! * (1 - wet)) + (output[index]! * wet);
    }
    this.restoreCrossfadePending = false;
  }

  private recordRealOutput(samples: Float32Array): void {
    if (samples.length === 0) {
      return;
    }
    const maxHistorySamples = Math.ceil((PLAYBACK_PLC_TAIL_MS / 1000) * this.outputSampleRate);
    if (samples.length >= maxHistorySamples) {
      this.plcHistory = new Float32Array(samples.subarray(samples.length - maxHistorySamples));
      return;
    }
    const merged = new Float32Array(Math.min(maxHistorySamples, this.plcHistory.length + samples.length));
    const keep = Math.max(0, merged.length - samples.length);
    if (keep > 0) {
      merged.set(this.plcHistory.subarray(this.plcHistory.length - keep), 0);
    }
    merged.set(samples, keep);
    this.plcHistory = merged;
  }

  private resampleToOutputRate(input: Float32Array, inputSampleRate: number): Float32Array {
    if (input.length === 0 || inputSampleRate === this.outputSampleRate) {
      return input;
    }

    if (this.resampleInputRate !== inputSampleRate) {
      this.resampleInputRate = inputSampleRate;
      this.resampleInputBuffer = new Float32Array(0);
      this.resampleSourcePosition = 0;
    }

    this.resampleInputBuffer = mergeFloat32(this.resampleInputBuffer, input);
    const ratio = inputSampleRate / this.outputSampleRate;
    let outputLength = 0;
    let probePosition = this.resampleSourcePosition;

    while (probePosition < this.resampleInputBuffer.length - 1) {
      outputLength += 1;
      probePosition += ratio;
    }

    if (outputLength === 0) {
      return new Float32Array(0);
    }

    const output = new Float32Array(outputLength);
    let sourcePosition = this.resampleSourcePosition;

    for (let index = 0; index < outputLength; index += 1) {
      const leftIndex = Math.floor(sourcePosition);
      const rightIndex = Math.min(leftIndex + 1, this.resampleInputBuffer.length - 1);
      const fraction = sourcePosition - leftIndex;
      const leftSample = this.resampleInputBuffer[leftIndex] ?? 0;
      const rightSample = this.resampleInputBuffer[rightIndex] ?? leftSample;
      output[index] = leftSample + ((rightSample - leftSample) * fraction);
      sourcePosition += ratio;
    }

    const consumedSamples = Math.floor(sourcePosition);
    this.resampleInputBuffer = this.resampleInputBuffer.slice(consumedSamples);
    this.resampleSourcePosition = sourcePosition - consumedSamples;
    return output;
  }
}

class WorkletPlaybackBackend implements CompatPlaybackBackend {
  readonly backendType = 'audio-worklet' as const;
  readonly outputNode: AudioWorkletNode;

  constructor(
    node: AudioWorkletNode,
    onStats: (stats: CompatPlaybackStats) => void,
    bufferPreference?: MonitorPlaybackBufferPreference,
  ) {
    this.outputNode = node;
    this.outputNode.port.onmessage = (event) => {
      if (event.data?.type === 'jitterDebug') {
        if (event.data.data?.isAtMax) {
          logger.warn(`Monitor jitter target reached max ${stringifyJitterDebugPayload(event.data.data)}`);
        } else {
          logger.debug(`Monitor jitter target changed ${stringifyJitterDebugPayload(event.data.data)}`);
        }
        return;
      }
      if (event.data?.type !== 'stats') {
        return;
      }

      onStats({
        latencyMs: event.data.data?.latencyMs,
        bufferFillPercent: event.data.data?.bufferFillPercent,
        droppedSamples: event.data.data?.droppedSamples,
        queueDurationMs: event.data.data?.queueDurationMs,
        targetBufferMs: event.data.data?.targetBufferMs,
        outputSourceTimestampMs: event.data.data?.outputSourceTimestampMs ?? null,
        nextOutputSourceTimestampMs: event.data.data?.nextOutputSourceTimestampMs ?? null,
        mainToWorkletMs: event.data.data?.mainToWorkletMs ?? null,
        statsGeneratedAtMs: event.data.data?.statsGeneratedAtMs ?? Date.now(),
        underrunCount: event.data.data?.underrunCount ?? 0,
        inputSampleRate: event.data.data?.inputSampleRate,
        jitterP95Ms: event.data.data?.jitterP95Ms,
        jitterEwmaMs: event.data.data?.jitterEwmaMs,
      });
    };
    this.setBufferPreference(bufferPreference ?? DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE);
  }

  handleAudioData(data: {
    buffer: ArrayBuffer;
    sampleRate: number;
    clientTimestamp: number;
    clientReceivedAtMs?: number;
    sequence?: number;
    frameDurationMs?: number;
    serverSentAtMs?: number;
  }): void {
    this.outputNode.port.postMessage({
      type: 'audioData',
      buffer: data.buffer,
      sampleRate: data.sampleRate,
      clientTimestamp: data.clientTimestamp,
      clientReceivedAtMs: data.clientReceivedAtMs,
      sequence: data.sequence,
      frameDurationMs: data.frameDurationMs,
      serverSentAtMs: data.serverSentAtMs,
    }, [data.buffer]);
  }

  setBufferPreference(preference: MonitorPlaybackBufferPreference, initialTargetMs?: number | null): void {
    this.outputNode.port.postMessage({
      type: 'setBufferPolicy',
      policy: resolveMonitorPlaybackBufferPolicy(preference, { initialTargetMs }),
    });
  }

  recordTimingProbe(probe: RealtimeTimingProbeMessage, receivedAtMs = Date.now()): void {
    this.outputNode.port.postMessage({ type: 'timingProbe', probe, receivedAtMs });
  }

  reset(): void {
    this.outputNode.port.postMessage({ type: 'reset' });
  }

  close(): void {
    this.outputNode.port.onmessage = null;
    try {
      this.outputNode.disconnect();
    } catch {
      // ignore
    }
  }
}

class ScriptProcessorCaptureBackend implements CompatCaptureBackend {
  readonly backendType = 'script-processor' as const;
  readonly inputNode: ScriptProcessorNode;

  private readonly muteGainNode: GainNode;
  private frameHandler: ((frame: CompatCaptureFrame) => void) | null = null;
  private sourceBuffer = new Float32Array(0);
  private sourceOffset = 0;

  constructor(audioContext: AudioContext) {
    this.inputNode = audioContext.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
    this.inputNode.onaudioprocess = (event) => {
      this.process(event);
    };
    this.muteGainNode = audioContext.createGain();
    this.muteGainNode.gain.value = 0;
    this.inputNode.connect(this.muteGainNode);
    this.muteGainNode.connect(audioContext.destination);
  }

  setFrameHandler(handler: ((frame: CompatCaptureFrame) => void) | null): void {
    this.frameHandler = handler;
  }

  reset(): void {
    this.sourceBuffer = new Float32Array(0);
    this.sourceOffset = 0;
  }

  close(): void {
    this.frameHandler = null;
    this.reset();
    this.inputNode.onaudioprocess = null;
    try {
      this.inputNode.disconnect();
    } catch {
      // ignore
    }
    try {
      this.muteGainNode.disconnect();
    } catch {
      // ignore
    }
  }

  private process(event: AudioProcessingEvent): void {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    output.fill(0);

    if (!input || input.length === 0) {
      return;
    }

    this.sourceBuffer = mergeFloat32(this.sourceBuffer, new Float32Array(input));
    this.emitFrames(event.inputBuffer.sampleRate);
  }

  private emitFrames(sourceSampleRate: number): void {
    const ratio = sourceSampleRate / CAPTURE_TARGET_SAMPLE_RATE;

    for (;;) {
      const requiredSamples = Math.ceil(this.sourceOffset + (CAPTURE_FRAME_SAMPLES * ratio)) + 1;
      if (this.sourceBuffer.length < requiredSamples) {
        return;
      }

      const output = new Int16Array(CAPTURE_FRAME_SAMPLES);
      for (let index = 0; index < CAPTURE_FRAME_SAMPLES; index += 1) {
        const sourceIndex = this.sourceOffset + (index * ratio);
        const leftIndex = Math.floor(sourceIndex);
        const rightIndex = Math.min(leftIndex + 1, this.sourceBuffer.length - 1);
        const fraction = sourceIndex - leftIndex;
        const leftSample = this.sourceBuffer[leftIndex] ?? 0;
        const rightSample = this.sourceBuffer[rightIndex] ?? leftSample;
        const sample = leftSample + ((rightSample - leftSample) * fraction);
        const clamped = Math.max(-1, Math.min(1, sample));
        output[index] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      }

      this.frameHandler?.({
        sampleRate: CAPTURE_TARGET_SAMPLE_RATE,
        samplesPerChannel: CAPTURE_FRAME_SAMPLES,
        buffer: output.buffer,
        capturedAtMs: Date.now() - ((CAPTURE_FRAME_SAMPLES / CAPTURE_TARGET_SAMPLE_RATE) * 1000),
      });

      const consumedSamples = Math.floor(this.sourceOffset + (CAPTURE_FRAME_SAMPLES * ratio));
      this.sourceBuffer = this.sourceBuffer.slice(consumedSamples);
      this.sourceOffset = (this.sourceOffset + (CAPTURE_FRAME_SAMPLES * ratio)) - consumedSamples;
    }
  }
}

class WorkletCaptureBackend implements CompatCaptureBackend {
  readonly backendType = 'audio-worklet' as const;
  readonly inputNode: AudioWorkletNode;
  private readonly muteGainNode: GainNode;
  private generation = 0;

  constructor(audioContext: AudioContext, node: AudioWorkletNode) {
    this.inputNode = node;
    this.muteGainNode = audioContext.createGain();
    this.muteGainNode.gain.value = 0;
    this.inputNode.connect(this.muteGainNode);
    this.muteGainNode.connect(audioContext.destination);
  }

  setFrameHandler(handler: ((frame: CompatCaptureFrame) => void) | null): void {
    this.inputNode.port.onmessage = (event) => {
      if (event.data?.type !== 'audioFrame' || !handler) {
        return;
      }
      if (Number(event.data.generation ?? 0) !== this.generation) {
        return;
      }

      const sampleRate = Number(event.data.sampleRate ?? CAPTURE_TARGET_SAMPLE_RATE);
      const samplesPerChannel = Number(event.data.samplesPerChannel ?? CAPTURE_FRAME_SAMPLES);
      handler({
        sampleRate,
        samplesPerChannel,
        buffer: event.data.buffer as ArrayBuffer,
        capturedAtMs: Date.now() - ((samplesPerChannel / sampleRate) * 1000),
      });
    };
  }

  reset(): void {
    this.generation += 1;
    this.inputNode.port.postMessage({ type: 'reset', generation: this.generation });
  }

  close(): void {
    this.inputNode.port.onmessage = null;
    this.reset();
    try {
      this.inputNode.disconnect();
    } catch {
      // ignore
    }
    try {
      this.muteGainNode.disconnect();
    } catch {
      // ignore
    }
  }
}

export async function createCompatPlaybackBackend(
  audioContext: AudioContext,
  onStats: (stats: CompatPlaybackStats) => void,
  bufferPreference?: MonitorPlaybackBufferPreference,
  initialTargetMs?: number | null,
): Promise<CompatPlaybackBackend> {
  if (isAudioWorkletSupported(audioContext)) {
    await audioContext.audioWorklet.addModule('/audio-monitor-worklet.js');
    const node = new AudioWorkletNode(audioContext, 'audio-monitor-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    logger.info('Realtime compatibility playback backend selected', {
      backendType: 'audio-worklet',
      browser: detectBrowserAudioRuntime().label,
    });
    const backend = new WorkletPlaybackBackend(node, onStats, bufferPreference);
    if (typeof initialTargetMs === 'number') {
      backend.setBufferPreference(bufferPreference ?? DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE, initialTargetMs);
    }
    return backend;
  }

  logger.warn('AudioWorklet is unavailable, using script processor playback fallback', {
    browser: detectBrowserAudioRuntime().label,
  });
  return new ScriptProcessorPlaybackBackend(audioContext, onStats, bufferPreference ?? DEFAULT_MONITOR_PLAYBACK_BUFFER_PREFERENCE, initialTargetMs ?? undefined);
}

export async function createCompatCaptureBackend(audioContext: AudioContext): Promise<CompatCaptureBackend> {
  if (isAudioWorkletSupported(audioContext)) {
    await audioContext.audioWorklet.addModule('/voice-capture-worklet.js');
    const node = new AudioWorkletNode(audioContext, 'voice-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    logger.info('Realtime compatibility capture backend selected', {
      backendType: 'audio-worklet',
      browser: detectBrowserAudioRuntime().label,
    });
    return new WorkletCaptureBackend(audioContext, node);
  }

  logger.warn('AudioWorklet is unavailable, using script processor capture fallback', {
    browser: detectBrowserAudioRuntime().label,
  });
  return new ScriptProcessorCaptureBackend(audioContext);
}
