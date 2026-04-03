import { createLogger } from '../utils/logger';
import { detectBrowserAudioRuntime, isAudioWorkletSupported } from './browserAudioRuntime';

const logger = createLogger('CompatAudioBackends');
const PLAYBACK_PREFILL_MS = 80;
const PLAYBACK_STATS_INTERVAL_MS = 1000;
const PLAYBACK_BUFFER_SIZE = 1024;
const CAPTURE_BUFFER_SIZE = 1024;
const CAPTURE_FRAME_SAMPLES = 320;
const CAPTURE_TARGET_SAMPLE_RATE = 16000;

export interface CompatPlaybackStats {
  latencyMs: number;
  bufferFillPercent: number;
  droppedSamples: number;
  queueDurationMs: number;
  targetBufferMs: number;
}

export interface CompatPlaybackBackend {
  readonly backendType: 'audio-worklet' | 'script-processor';
  readonly outputNode: AudioNode;
  handleAudioData(data: {
    buffer: ArrayBuffer;
    sampleRate: number;
    clientTimestamp: number;
  }): void;
  reset(): void;
  close(): void;
}

export interface CompatCaptureFrame {
  sampleRate: number;
  samplesPerChannel: number;
  buffer: ArrayBuffer;
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
  private readonly onStats: (stats: CompatPlaybackStats) => void;

  private writeIndex = 0;
  private readIndex = 0;
  private availableSamples = 0;
  private totalDroppedSamples = 0;
  private consecutiveUnderrunFrames = 0;
  private isPlaying = false;
  private lastStatsAt = 0;
  private lastValidSample = 0;
  private resampleInputBuffer = new Float32Array(0);
  private resampleSourcePosition = 0;
  private resampleInputRate: number;

  constructor(audioContext: AudioContext, onStats: (stats: CompatPlaybackStats) => void) {
    this.outputSampleRate = audioContext.sampleRate;
    this.ringBufferSize = Math.max(Math.ceil(this.outputSampleRate * 2), 48000);
    this.ringBuffer = new Float32Array(this.ringBufferSize);
    this.onStats = onStats;
    this.resampleInputRate = this.outputSampleRate;
    this.outputNode = audioContext.createScriptProcessor(PLAYBACK_BUFFER_SIZE, 0, 1);
    this.outputNode.onaudioprocess = (event) => {
      this.process(event);
    };
  }

  handleAudioData(data: { buffer: ArrayBuffer; sampleRate: number; clientTimestamp: number }): void {
    const samples = new Float32Array(data.buffer);
    const inputRate = Number(data.sampleRate) > 0 ? Number(data.sampleRate) : this.outputSampleRate;
    const resampled = this.resampleToOutputRate(samples, inputRate);
    this.enqueueSamples(resampled);
  }

  reset(): void {
    this.writeIndex = 0;
    this.readIndex = 0;
    this.availableSamples = 0;
    this.totalDroppedSamples = 0;
    this.consecutiveUnderrunFrames = 0;
    this.isPlaying = false;
    this.lastStatsAt = 0;
    this.lastValidSample = 0;
    this.resampleInputBuffer = new Float32Array(0);
    this.resampleSourcePosition = 0;
    this.resampleInputRate = this.outputSampleRate;
  }

  close(): void {
    this.outputNode.onaudioprocess = null;
    try {
      this.outputNode.disconnect();
    } catch {
      // ignore
    }
  }

  private enqueueSamples(samples: Float32Array): void {
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
      this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize;
    }

    this.availableSamples = Math.min(this.availableSamples + samples.length, this.ringBufferSize);
  }

  private process(event: AudioProcessingEvent): void {
    const output = event.outputBuffer.getChannelData(0);
    const bufferMs = this.availableSamples / (this.outputSampleRate / 1000);

    if (!this.isPlaying) {
      output.fill(0);
      if (bufferMs >= PLAYBACK_PREFILL_MS) {
        this.isPlaying = true;
        this.consecutiveUnderrunFrames = 0;
      }
      this.maybeReportStats();
      return;
    }

    let hadUnderrun = false;
    for (let index = 0; index < output.length; index += 1) {
      if (this.availableSamples > 0) {
        const sample = this.ringBuffer[this.readIndex];
        output[index] = sample;
        this.lastValidSample = sample;
        this.readIndex = (this.readIndex + 1) % this.ringBufferSize;
        this.availableSamples -= 1;
      } else {
        this.lastValidSample *= 0.9;
        output[index] = this.lastValidSample;
        hadUnderrun = true;
      }
    }

    if (hadUnderrun) {
      this.consecutiveUnderrunFrames += 1;
      if (this.consecutiveUnderrunFrames > 10) {
        this.isPlaying = false;
        this.consecutiveUnderrunFrames = 0;
      }
    } else {
      this.consecutiveUnderrunFrames = 0;
    }

    this.maybeReportStats();
  }

  private maybeReportStats(): void {
    const now = Date.now();
    if ((now - this.lastStatsAt) < PLAYBACK_STATS_INTERVAL_MS) {
      return;
    }

    const queueDurationMs = this.availableSamples / (this.outputSampleRate / 1000);
    this.onStats({
      latencyMs: queueDurationMs,
      queueDurationMs,
      targetBufferMs: PLAYBACK_PREFILL_MS,
      bufferFillPercent: Math.max(0, Math.min(100, (queueDurationMs / PLAYBACK_PREFILL_MS) * 100)),
      droppedSamples: this.totalDroppedSamples,
    });
    this.lastStatsAt = now;
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
      });
    };
  }

  handleAudioData(data: { buffer: ArrayBuffer; sampleRate: number; clientTimestamp: number }): void {
    this.outputNode.port.postMessage({
      type: 'audioData',
      buffer: data.buffer,
      sampleRate: data.sampleRate,
      clientTimestamp: data.clientTimestamp,
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

      handler({
        sampleRate: Number(event.data.sampleRate ?? CAPTURE_TARGET_SAMPLE_RATE),
        samplesPerChannel: Number(event.data.samplesPerChannel ?? CAPTURE_FRAME_SAMPLES),
        buffer: event.data.buffer as ArrayBuffer,
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
