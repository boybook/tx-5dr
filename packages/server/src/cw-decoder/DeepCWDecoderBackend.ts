import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import { CWDecoderWorkerPool } from '../worker-pool/CWDecoderWorkerPool.js';
import { probeDeepCWRuntime } from '../worker-pool/CWDecoderWorkerCore.js';
import { analyzeDeepCWSignal } from '../worker-pool/DeepCWFeatureExtractor.js';
import { StreamingCommitHelper } from './StreamingCommitHelper.js';
import {
  DEFAULT_CW_DECODER_CONFIG,
  type CWDecoderBackend,
  type CWDecoderBackendEvents,
  type CWDecoderConfig,
  type CWDecoderErrorEvent,
  type CWDecoderStatus,
  type CWDecoderTranscriptResetEvent,
  type CWDecoderWorkerTelemetrySnapshot,
} from './types.js';

const logger = createLogger('DeepCWDecoderBackend');
const MIN_STREAMING_PENDING_SECONDS = 2;
const MIN_STREAMING_CONFIRMED_SECONDS = 2;
const STREAMING_TAIL_GUARD_SECONDS = 1.25;
const STREAMING_OVERLAP_RETENTION_SECONDS = 1.25;
const STREAMING_MAX_SEGMENT_SECONDS = 30;
const STREAMING_STABLE_MIN_NON_WHITESPACE_CHARS = 5;
const STREAMING_STABLE_REPEAT_COUNT = 3;
const SIGNAL_ANALYSIS_LOG_INTERVAL_MS = 10_000;

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
    maxSegmentSeconds: STREAMING_MAX_SEGMENT_SECONDS,
    overlapRetentionSeconds: STREAMING_OVERLAP_RETENTION_SECONDS,
    stableMinNonWhitespaceChars: STREAMING_STABLE_MIN_NON_WHITESPACE_CHARS,
    stableRepeatCount: STREAMING_STABLE_REPEAT_COUNT,
  });
  private status: CWDecoderStatus = this.makeStatus('stopped', false, null);
  private readonly poolFactory: (config: CWDecoderConfig) => CWDecoderWorkerPool;
  private sessionId = createTranscriptSessionId();
  private commitSequence = 0;
  private pendingVersion = 0;
  private lastSignalAnalysisLogAt = 0;

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
    this.lastSignalAnalysisLogAt = 0;
    this.configureBuffers();
    this.beginTranscriptSession();
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
    logger.info('DeepCW backend started', {
      streamingWindowMs: STREAMING_MAX_SEGMENT_SECONDS * 1000,
      displayWindowMs: this.config.windowSeconds * 1000,
      hopMs: this.config.decodeIntervalMs,
    });
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
    this.lastSignalAnalysisLogAt = 0;
    this.status = { ...this.status, lastPendingText: '', lastCommittedText: '', lastDecodeAt: null, queuedSamples: 0 };
    this.setStatus(this.makeStatus('stopped', false, null));
    logger.debug('DeepCW backend stopped', { reason });
  }

  clearTranscript(): void {
    const timestamp = Date.now();
    this.beginTranscriptSession(timestamp);
    this.status = {
      ...this.status,
      lastPendingText: '',
      lastCommittedText: '',
      lastDecodeAt: null,
      queuedSamples: 0,
    };
    this.emitPendingClear(timestamp, 0);
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

  updateTuning(tuning: Pick<CWDecoderConfig, 'targetFreqHz' | 'filterWidthHz'>): void {
    const nextConfig = this.normalizeConfig({
      ...this.config,
      targetFreqHz: tuning.targetFreqHz,
      filterWidthHz: tuning.filterWidthHz,
    });
    const changed = nextConfig.targetFreqHz !== this.config.targetFreqHz
      || nextConfig.filterWidthHz !== this.config.filterWidthHz;
    this.config = nextConfig;
    this.pool?.updateTuning({
      targetFreqHz: nextConfig.targetFreqHz,
      filterWidthHz: nextConfig.filterWidthHz,
    });
    if (!changed) {
      this.emit('status', this.getStatus());
      return;
    }

    const timestamp = Date.now();
    this.resetPendingAudioState();
    this.lastSignalAnalysisLogAt = 0;
    this.status = {
      ...this.status,
      lastPendingText: '',
      queuedSamples: 0,
    };
    this.emitPendingClear(timestamp);
    this.emit('status', this.getStatus());
  }

  pushAudio(chunk: Float32Array, sampleRate: number): void {
    if (chunk.length === 0) return;
    if (sampleRate !== this.config.decodeSampleRate) {
      this.handleInputSampleRateMismatch(sampleRate);
      return;
    }
    if (this.status.state === 'error' && this.isInputSampleRateMismatchError(this.status.backendError)) {
      this.setStatus(this.makeStatus('running', true, null));
    }
    this.appendDecodeRateAudio(new Float32Array(chunk));
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
    if (this.commitHelper.getUnconfirmedPendingSamples(this.pendingAudio.length) < this.commitHelper.minPendingSamples) {
      this.clearPendingPreviewIfNeeded();
      return;
    }

    this.decodeInFlight = true;
    const generation = this.resetGeneration;
    this.lastDecodeSampleCursor = this.totalSamplesReceived;
    try {
      const analysisLength = Math.min(this.pendingAudio.length, this.commitHelper.maxSegmentSamples);
      const analysisAudio = this.pendingAudio.slice(0, analysisLength);
      const timestamp = Date.now();
      this.logSignalAnalysis(analysisAudio, timestamp);
      if (!hasNonZeroSamples(analysisAudio)) {
        this.resetPendingAudioState();
        this.status = {
          ...this.status,
          lastPendingText: '',
          queuedSamples: 0,
        };
        this.emitPendingClear(Date.now());
        this.emit('status', this.getStatus());
        return;
      }
      const result = await this.pool.decode(analysisAudio, this.config.decodeSampleRate);
      if (generation !== this.resetGeneration) {
        return;
      }
      const evaluation = this.commitHelper.evaluateDecode(result, analysisLength, this.pendingAudio.length);
      const pending = this.commitHelper.buildPendingEvent(evaluation.pendingLane, timestamp, {
        sessionId: this.sessionId,
        version: this.nextPendingVersion(),
        targetFreqHz: this.config.targetFreqHz,
        filterWidthHz: this.config.filterWidthHz,
      });
      this.status = {
        ...this.status,
        lastPendingText: pending.text,
        lastDecodeAt: timestamp,
        queuedSamples: this.pendingAudio.length,
      };
      this.emit('pending', pending);

      if (evaluation.decision) {
        const sequence = this.commitSequence + 1;
        const commit = this.commitHelper.buildCommitEvent(evaluation.decision.lane, timestamp, {
          id: `${this.sessionId}-${sequence}`,
          sessionId: this.sessionId,
          sequence,
          prependSpace: evaluation.decision.prependSpace,
          targetFreqHz: this.config.targetFreqHz,
          filterWidthHz: this.config.filterWidthHz,
          startedAt: timestamp,
          endedAt: timestamp,
        });
        const retention = this.commitHelper.acceptCommit(evaluation.decision.commitSample);
        this.pendingAudio = dropLeadingSamples(this.pendingAudio, retention.dropSamples);
        this.status = {
          ...this.status,
          lastPendingText: '',
          lastCommittedText: this.commitHelper.getCommittedText(),
          queuedSamples: this.pendingAudio.length,
        };
        if (commit) {
          this.commitSequence = sequence;
          this.emit('commit', commit);
        }
        this.emitPendingClear(timestamp, pending.confidence);
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
      maxSegmentSeconds: STREAMING_MAX_SEGMENT_SECONDS,
      overlapRetentionSeconds: STREAMING_OVERLAP_RETENTION_SECONDS,
      stableMinNonWhitespaceChars: STREAMING_STABLE_MIN_NON_WHITESPACE_CHARS,
      stableRepeatCount: STREAMING_STABLE_REPEAT_COUNT,
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

  private resetPendingAudioState(): void {
    this.resetGeneration += 1;
    this.pendingAudio = new Float32Array(0);
    this.totalSamplesReceived = 0;
    this.lastDecodeSampleCursor = 0;
    this.commitHelper.resetPendingState();
  }

  private beginTranscriptSession(timestamp = Date.now()): void {
    this.sessionId = createTranscriptSessionId();
    this.commitSequence = 0;
    this.pendingVersion = 0;
    this.resetStreamingState();
    const event: CWDecoderTranscriptResetEvent = {
      type: 'transcript_reset',
      backend: 'deepcw-onnx',
      sessionId: this.sessionId,
      timestamp,
    };
    this.emit('reset', event);
  }

  private nextPendingVersion(): number {
    this.pendingVersion += 1;
    return this.pendingVersion;
  }

  private appendDecodeRateAudio(chunk: Float32Array): void {
    if (chunk.length === 0) return;
    this.pendingAudio = appendAudioChunk(this.pendingAudio, chunk);
    this.totalSamplesReceived += chunk.length;
    this.status = { ...this.status, queuedSamples: this.pendingAudio.length };
  }

  private handleInputSampleRateMismatch(sampleRate: number): void {
    const message = `DeepCW decoder expects ${this.config.decodeSampleRate} Hz audioData from the unified audio pipeline, received ${sampleRate} Hz`;
    if (this.status.backendError === message) {
      return;
    }
    this.setStatus(this.makeStatus('error', false, message));
    this.emitError(`${message}. Switch to CW mode or restart audio so the main RX buffer runs at 9600 Hz.`, true);
    logger.warn('DeepCW input sample rate mismatch', {
      inputSampleRate: sampleRate,
      expectedSampleRate: this.config.decodeSampleRate,
    });
  }

  private logSignalAnalysis(audio: Float32Array, updatedAt = Date.now()): void {
    if (updatedAt - this.lastSignalAnalysisLogAt < SIGNAL_ANALYSIS_LOG_INTERVAL_MS) {
      return;
    }
    this.lastSignalAnalysisLogAt = updatedAt;
    const analysis = analyzeDeepCWSignal(
      audio,
      this.config.decodeSampleRate,
      this.config.targetFreqHz,
      this.config.filterWidthHz,
      updatedAt,
    );
    logger.info('DeepCW input signal analysis', {
      classification: analysis.classification,
      targetFreqHz: Math.round(analysis.targetFreqHz),
      filterWidthHz: Math.round(analysis.filterWidthHz),
      effectiveBandHz: `${Math.round(analysis.effectiveBandMinHz)}-${Math.round(analysis.effectiveBandMaxHz)}`,
      peakFreqHz: Math.round(analysis.peakFreqHz),
      snrDb: roundMetric(analysis.snrDb, 1),
      rmsDbfs: roundMetric(analysis.rmsDbfs, 1),
      activeFrameRatio: roundMetric(analysis.activeFrameRatio, 2),
      durationMs: Math.round(analysis.durationMs),
    });
  }

  private isInputSampleRateMismatchError(error: string | null): boolean {
    return !!error && error.includes(`expects ${this.config.decodeSampleRate} Hz audioData`);
  }

  private clearPendingPreviewIfNeeded(): void {
    if (!this.status.lastPendingText) return;
    const timestamp = Date.now();
    this.status = { ...this.status, lastPendingText: '', queuedSamples: this.pendingAudio.length };
    this.commitHelper.resetStableState();
    this.emitPendingClear(timestamp);
    this.emit('status', this.getStatus());
  }

  private emitPendingClear(timestamp = Date.now(), confidence = 0): void {
    this.emit('pending', {
      type: 'pending',
      backend: 'deepcw-onnx',
      sessionId: this.sessionId,
      version: this.nextPendingVersion(),
      text: '',
      plainText: '',
      finalized: false,
      confidence,
      targetFreqHz: this.config.targetFreqHz,
      filterWidthHz: this.config.filterWidthHz,
      timestamp,
    });
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

function hasNonZeroSamples(samples: Float32Array): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index] ?? 0) > 1e-8) return true;
  }
  return false;
}

function roundMetric(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function createTranscriptSessionId(): string {
  return `cw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
