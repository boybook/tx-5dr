import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import { CWDecoderWorkerPool } from '../worker-pool/CWDecoderWorkerPool.js';
import { probeDeepCWRuntime } from '../worker-pool/CWDecoderWorkerCore.js';
import { resampleLinear } from './resampler.js';
import { StreamingCommitHelper } from './StreamingCommitHelper.js';
import {
  DEFAULT_CW_DECODER_CONFIG,
  type CWDecoderBackend,
  type CWDecoderBackendEvents,
  type CWDecoderConfig,
  type CWDecoderErrorEvent,
  type CWDecoderStatus,
  type CWDecoderWorkerTelemetrySnapshot,
} from './types.js';

const logger = createLogger('DeepCWDecoderBackend');
const MIN_STREAMING_PENDING_SECONDS = 2;
const MIN_STREAMING_CONFIRMED_SECONDS = 2;
const STREAMING_TAIL_GUARD_SECONDS = 1.25;

export interface DeepCWDecoderBackendOptions {
  poolFactory?: (config: CWDecoderConfig) => CWDecoderWorkerPool;
}

export class DeepCWDecoderBackend extends EventEmitter<CWDecoderBackendEvents> implements CWDecoderBackend {
  readonly id = 'deepcw-onnx' as const;
  private config: CWDecoderConfig = { ...DEFAULT_CW_DECODER_CONFIG };
  private pendingAudio = new Float32Array(0);
  private pool: CWDecoderWorkerPool | null = null;
  private decodeTimer: ReturnType<typeof setInterval> | null = null;
  private decodeInFlight = false;
  private lastDecodeSampleCursor = 0;
  private totalSamplesReceived = 0;
  private resetGeneration = 0;
  private commitHelper = new StreamingCommitHelper({
    backend: 'deepcw-onnx',
    sampleRate: DEFAULT_CW_DECODER_CONFIG.decodeSampleRate,
    minPendingSeconds: MIN_STREAMING_PENDING_SECONDS,
    minConfirmedSeconds: MIN_STREAMING_CONFIRMED_SECONDS,
    tailGuardSeconds: STREAMING_TAIL_GUARD_SECONDS,
    maxSegmentSeconds: DEFAULT_CW_DECODER_CONFIG.windowSeconds,
  });
  private status: CWDecoderStatus = this.makeStatus('stopped', false, null);
  private readonly poolFactory: (config: CWDecoderConfig) => CWDecoderWorkerPool;

  constructor(options: DeepCWDecoderBackendOptions = {}) {
    super();
    this.poolFactory = options.poolFactory ?? ((config) => new CWDecoderWorkerPool({
      workerCount: config.workerCount,
      modelPath: config.modelPath,
      runtimeBackend: config.runtimeBackend,
      modelSize: config.modelSize,
      language: config.language,
      targetFreqHz: config.targetFreqHz,
      filterWidthHz: config.filterWidthHz,
    }));
  }

  async start(config: CWDecoderConfig): Promise<void> {
    await this.stop('restart');
    this.config = this.normalizeConfig(config);
    this.configureBuffers();
    this.setStatus(this.makeStatus('starting', false, null));

    const pool = this.poolFactory(this.config);
    this.pool = pool;
    await pool.start();
    const telemetry = pool.getTelemetrySnapshot();
    if (telemetry.status !== 'running') {
      const error = telemetry.lastError ?? 'DeepCW decoder is unavailable';
      this.setStatus(this.makeStatus('unavailable', false, error));
      this.emitError(error, true);
      logger.warn('DeepCW backend unavailable', { error });
      return;
    }

    this.setStatus(this.makeStatus('running', true, null));
    this.decodeTimer = setInterval(() => {
      void this.runDecodeJob();
    }, this.config.decodeIntervalMs);
    logger.info('DeepCW backend started', { windowMs: this.config.windowSeconds * 1000, hopMs: this.config.decodeIntervalMs });
  }

  async stop(reason = 'manual'): Promise<void> {
    if (this.decodeTimer) {
      clearInterval(this.decodeTimer);
      this.decodeTimer = null;
    }
    const pool = this.pool;
    this.pool = null;
    if (pool) {
      await pool.stop().catch((error) => logger.warn('DeepCW worker pool stop failed', error));
    }
    this.decodeInFlight = false;
    this.resetStreamingState();
    this.status = { ...this.status, lastPendingText: '', lastCommittedText: '', lastDecodeAt: null, queuedSamples: 0 };
    this.setStatus(this.makeStatus('stopped', false, null));
    logger.debug('DeepCW backend stopped', { reason });
  }

  clearTranscript(): void {
    this.resetStreamingState();
    const timestamp = Date.now();
    this.status = {
      ...this.status,
      lastPendingText: '',
      lastCommittedText: '',
      lastDecodeAt: null,
      queuedSamples: 0,
    };
    this.emit('pending', {
      type: 'pending',
      backend: 'deepcw-onnx',
      text: '',
      confidence: 0,
      timestamp,
    });
    this.emit('status', this.getStatus());
  }

  async updateConfig(config: CWDecoderConfig): Promise<void> {
    const wasRunning = this.status.state === 'running' || this.status.state === 'unavailable' || this.status.state === 'error';
    if (!wasRunning) {
      this.config = this.normalizeConfig(config);
      this.configureBuffers();
      const probe = probeDeepCWRuntime(this.config.modelPath);
      this.setStatus(this.makeStatus('stopped', probe.available, probe.error));
      return;
    }
    await this.start(config);
  }

  pushAudio(chunk: Float32Array, sampleRate: number): void {
    if (chunk.length === 0) return;
    const decodeRateChunk = sampleRate === this.config.decodeSampleRate
      ? new Float32Array(chunk)
      : resampleLinear(chunk, sampleRate, this.config.decodeSampleRate);
    this.pendingAudio = appendAudioChunk(this.pendingAudio, decodeRateChunk);
    this.totalSamplesReceived += decodeRateChunk.length;
    this.status = { ...this.status, queuedSamples: this.pendingAudio.length };
  }

  getStatus(): CWDecoderStatus {
    return { ...this.status };
  }

  getTelemetrySnapshot(): CWDecoderWorkerTelemetrySnapshot {
    return this.pool?.getTelemetrySnapshot() ?? {
      status: 'stopped',
      workerCount: this.config.workerCount,
      jobsStarted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      inFlight: 0,
      pendingJobs: 0,
      lastError: null,
      workers: [],
    };
  }

  private async runDecodeJob(): Promise<void> {
    if (this.decodeInFlight || !this.pool || this.status.state !== 'running') {
      return;
    }
    const hopSamples = Math.max(1, Math.floor((this.config.decodeIntervalMs / 1000) * this.config.decodeSampleRate));
    if (this.totalSamplesReceived - this.lastDecodeSampleCursor < hopSamples) {
      return;
    }
    if (this.pendingAudio.length < this.commitHelper.minPendingSamples) {
      return;
    }

    this.decodeInFlight = true;
    const generation = this.resetGeneration;
    this.lastDecodeSampleCursor = this.totalSamplesReceived;
    try {
      const analysisLength = Math.min(this.pendingAudio.length, this.commitHelper.maxSegmentSamples);
      const analysisAudio = this.pendingAudio.slice(0, analysisLength);
      const result = await this.pool.decode(analysisAudio, this.config.decodeSampleRate);
      if (generation !== this.resetGeneration) {
        return;
      }
      const timestamp = Date.now();
      const pendingLane = this.commitHelper.normalizeResult(result);
      const pending = this.commitHelper.buildPendingEvent(pendingLane, timestamp);
      const splitPoint = this.commitHelper.getConfirmedSplitPoint(result.wordSpaceSpans ?? [], analysisLength)
        ?? this.commitHelper.getForcedSplitPoint(analysisLength, this.pendingAudio.length, result.wordSpaceSpans ?? []);
      this.status = {
        ...this.status,
        lastPendingText: pending.text,
        lastDecodeAt: timestamp,
        queuedSamples: this.pendingAudio.length,
      };
      this.emit('pending', pending);

      if (splitPoint) {
        const confirmedAudio = analysisAudio.slice(0, splitPoint.sample);
        const commitLane = splitPoint.forced
          ? this.commitHelper.normalizeResult(await this.pool.decode(confirmedAudio, this.config.decodeSampleRate))
          : this.commitHelper.trimLaneToFrame(result, splitPoint.endFrame);
        if (generation !== this.resetGeneration) {
          return;
        }
        const commit = this.commitHelper.buildCommitEvent(commitLane, timestamp);
        this.pendingAudio = dropLeadingSamples(this.pendingAudio, splitPoint.sample);
        this.status = {
          ...this.status,
          lastPendingText: '',
          lastCommittedText: this.commitHelper.getCommittedText(),
          queuedSamples: this.pendingAudio.length,
        };
        if (commit) {
          this.emit('commit', commit);
        }
        this.emit('pending', {
          type: 'pending',
          backend: 'deepcw-onnx',
          text: '',
          confidence: pending.confidence,
          timestamp,
        });
      }
      this.emit('status', this.getStatus());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(this.makeStatus('error', false, message));
      this.emitError(message, true);
      logger.warn('DeepCW decode job failed', { error: message });
    } finally {
      this.decodeInFlight = false;
    }
  }

  private configureBuffers(): void {
    this.resetStreamingState();
    this.commitHelper.updateOptions({
      backend: 'deepcw-onnx',
      sampleRate: this.config.decodeSampleRate,
      minPendingSeconds: MIN_STREAMING_PENDING_SECONDS,
      minConfirmedSeconds: MIN_STREAMING_CONFIRMED_SECONDS,
      tailGuardSeconds: STREAMING_TAIL_GUARD_SECONDS,
      maxSegmentSeconds: this.config.windowSeconds,
    });
    this.status = { ...this.status, lastPendingText: '', lastCommittedText: '', lastDecodeAt: null, queuedSamples: 0 };
  }

  private resetStreamingState(): void {
    this.resetGeneration += 1;
    this.pendingAudio = new Float32Array(0);
    this.totalSamplesReceived = 0;
    this.lastDecodeSampleCursor = 0;
    this.commitHelper.reset();
  }

  private normalizeConfig(config: CWDecoderConfig): CWDecoderConfig {
    return {
      ...DEFAULT_CW_DECODER_CONFIG,
      ...config,
      backend: 'deepcw-onnx',
      inputSampleRate: positiveInteger(config.inputSampleRate, DEFAULT_CW_DECODER_CONFIG.inputSampleRate),
      decodeSampleRate: positiveInteger(config.decodeSampleRate, DEFAULT_CW_DECODER_CONFIG.decodeSampleRate),
      windowSeconds: positiveInteger(config.windowSeconds, DEFAULT_CW_DECODER_CONFIG.windowSeconds),
      decodeIntervalMs: positiveInteger(config.decodeIntervalMs, DEFAULT_CW_DECODER_CONFIG.decodeIntervalMs),
      minCommitChars: positiveInteger(config.minCommitChars, DEFAULT_CW_DECODER_CONFIG.minCommitChars),
      commitStability: positiveInteger(config.commitStability, DEFAULT_CW_DECODER_CONFIG.commitStability),
      maxPendingAgeMs: positiveInteger(config.maxPendingAgeMs, DEFAULT_CW_DECODER_CONFIG.maxPendingAgeMs),
      workerCount: positiveInteger(config.workerCount, DEFAULT_CW_DECODER_CONFIG.workerCount),
    };
  }

  private makeStatus(state: CWDecoderStatus['state'], available: boolean, error: string | null): CWDecoderStatus {
    return {
      enabled: this.config.enabled,
      backend: 'deepcw-onnx',
      state,
      backendAvailable: available,
      backendError: error,
      lastPendingText: this.status?.lastPendingText ?? '',
      lastCommittedText: this.status?.lastCommittedText ?? '',
      lastDecodeAt: this.status?.lastDecodeAt ?? null,
      queuedSamples: this.pendingAudio.length,
      muted: this.status?.muted ?? false,
    };
  }

  private setStatus(status: CWDecoderStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }

  private emitError(error: string, recoverable: boolean): void {
    const event: CWDecoderErrorEvent = {
      type: 'error',
      backend: 'deepcw-onnx',
      error,
      recoverable,
      timestamp: Date.now(),
    };
    this.emit('error', event);
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function appendAudioChunk(currentSamples: Float32Array, nextChunk: Float32Array): Float32Array {
  const nextSamples = new Float32Array(currentSamples.length + nextChunk.length);
  nextSamples.set(currentSamples);
  nextSamples.set(nextChunk, currentSamples.length);
  return nextSamples;
}

function dropLeadingSamples(currentSamples: Float32Array, sampleCount: number): Float32Array {
  if (sampleCount <= 0) return currentSamples;
  if (sampleCount >= currentSamples.length) return new Float32Array(0);
  return currentSamples.slice(sampleCount);
}
