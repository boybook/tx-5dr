import { createLogger } from '../utils/logger';
import { detectBrowserAudioRuntime, isAudioWorkletSupported } from './browserAudioRuntime';

const logger = createLogger('CompatAudioBackends');
const PLAYBACK_INITIAL_TARGET_MS = 70;
const PLAYBACK_MIN_TARGET_MS = 40;
const PLAYBACK_MAX_TARGET_MS = 220;
const PLAYBACK_QUEUE_HEADROOM_MS = 20;
const PLAYBACK_STATS_INTERVAL_MS = 250;
const PLAYBACK_TARGET_INCREASE_MS = 25;
const PLAYBACK_TARGET_DECREASE_MS = 10;
const PLAYBACK_UNDERRUN_RECOVERY_FRAMES = 3;
const PLAYBACK_ADAPT_INCREASE_COOLDOWN_MS = 1500;
const PLAYBACK_ADAPT_DECREASE_AFTER_MS = 8000;
const PLAYBACK_ADAPT_DECREASE_COOLDOWN_MS = 5000;
const PLAYBACK_BUFFER_SIZE = 1024;
const CAPTURE_BUFFER_SIZE = 1024;
const CAPTURE_FRAME_SAMPLES = 160;
const CAPTURE_TARGET_SAMPLE_RATE = 16000;

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
}

export interface CompatPlaybackBackend {
  readonly backendType: 'audio-worklet' | 'script-processor';
  readonly outputNode: AudioNode;
  handleAudioData(data: {
    buffer: ArrayBuffer;
    sampleRate: number;
    clientTimestamp: number;
    clientReceivedAtMs?: number;
  }): void;
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
  private adaptiveTargetMs = PLAYBACK_INITIAL_TARGET_MS;
  private lastUnderrunAt = 0;
  private lastTargetChangeAt = 0;
  private lastStatsAt = 0;
  private lastValidSample = 0;
  private lastOutputSourceTimestampMs: number | null = null;
  private lastMainToWorkletMs: number | null = null;
  private lastInputSampleRate: number;
  private resampleInputBuffer = new Float32Array(0);
  private resampleSourcePosition = 0;
  private resampleInputRate: number;

  constructor(audioContext: AudioContext, onStats: (stats: CompatPlaybackStats) => void) {
    this.outputSampleRate = audioContext.sampleRate;
    this.ringBufferSize = Math.max(Math.ceil(this.outputSampleRate * 2), 48000);
    this.ringBuffer = new Float32Array(this.ringBufferSize);
    this.timestampBuffer = new Float64Array(this.ringBufferSize);
    this.timestampBuffer.fill(Number.NaN);
    this.onStats = onStats;
    this.resampleInputRate = this.outputSampleRate;
    this.lastInputSampleRate = this.outputSampleRate;
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
  }): void {
    const samples = new Float32Array(data.buffer);
    this.lastMainToWorkletMs = typeof data.clientReceivedAtMs === 'number'
      ? Math.max(0, Date.now() - data.clientReceivedAtMs)
      : 0;
    const inputRate = Number(data.sampleRate) > 0 ? Number(data.sampleRate) : this.outputSampleRate;
    this.lastInputSampleRate = inputRate;
    const resampled = this.resampleToOutputRate(samples, inputRate);
    this.enqueueSamples(resampled, Number(data.clientTimestamp));
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
    this.adaptiveTargetMs = PLAYBACK_INITIAL_TARGET_MS;
    const now = Date.now();
    this.lastUnderrunAt = now;
    this.lastTargetChangeAt = now;
    this.lastStatsAt = 0;
    this.lastValidSample = 0;
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
    const maxQueueSamples = Math.ceil(((this.adaptiveTargetMs + PLAYBACK_QUEUE_HEADROOM_MS) / 1000) * this.outputSampleRate);
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
    for (let index = 0; index < output.length; index += 1) {
      if (this.availableSamples > 0) {
        const sample = this.ringBuffer[this.readIndex];
        const sourceTimestampMs = this.timestampBuffer[this.readIndex];
        output[index] = sample;
        this.lastValidSample = sample;
        outputSourceTimestampMs = Number.isFinite(sourceTimestampMs) ? sourceTimestampMs : null;
        this.readIndex = (this.readIndex + 1) % this.ringBufferSize;
        this.availableSamples -= 1;
      } else {
        this.lastValidSample *= 0.9;
        output[index] = this.lastValidSample;
        hadUnderrun = true;
      }
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
    });
    this.lastStatsAt = now;
  }

  private noteUnderrun(now: number): void {
    this.lastUnderrunAt = now;
    if ((now - this.lastTargetChangeAt) >= PLAYBACK_ADAPT_INCREASE_COOLDOWN_MS) {
      this.adaptiveTargetMs = Math.min(
        PLAYBACK_MAX_TARGET_MS,
        this.adaptiveTargetMs + PLAYBACK_TARGET_INCREASE_MS,
      );
      this.lastTargetChangeAt = now;
    }
    if (this.consecutiveUnderrunFrames >= PLAYBACK_UNDERRUN_RECOVERY_FRAMES) {
      this.isRecovering = true;
    }
  }

  private maybeReduceTarget(now: number): void {
    if (this.adaptiveTargetMs <= PLAYBACK_MIN_TARGET_MS) {
      return;
    }
    if ((now - this.lastUnderrunAt) < PLAYBACK_ADAPT_DECREASE_AFTER_MS) {
      return;
    }
    if ((now - this.lastTargetChangeAt) < PLAYBACK_ADAPT_DECREASE_COOLDOWN_MS) {
      return;
    }
    this.adaptiveTargetMs = Math.max(
      PLAYBACK_MIN_TARGET_MS,
      this.adaptiveTargetMs - PLAYBACK_TARGET_DECREASE_MS,
    );
    this.lastTargetChangeAt = now;
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

  constructor(node: AudioWorkletNode, onStats: (stats: CompatPlaybackStats) => void) {
    this.outputNode = node;
    this.outputNode.port.onmessage = (event) => {
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
      });
    };
  }

  handleAudioData(data: {
    buffer: ArrayBuffer;
    sampleRate: number;
    clientTimestamp: number;
    clientReceivedAtMs?: number;
  }): void {
    this.outputNode.port.postMessage({
      type: 'audioData',
      buffer: data.buffer,
      sampleRate: data.sampleRate,
      clientTimestamp: data.clientTimestamp,
      clientReceivedAtMs: data.clientReceivedAtMs,
    }, [data.buffer]);
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

  close(): void {
    this.frameHandler = null;
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

  close(): void {
    this.inputNode.port.onmessage = null;
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
    return new WorkletPlaybackBackend(node, onStats);
  }

  logger.warn('AudioWorklet is unavailable, using script processor playback fallback', {
    browser: detectBrowserAudioRuntime().label,
  });
  return new ScriptProcessorPlaybackBackend(audioContext, onStats);
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
