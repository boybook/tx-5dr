import { EventEmitter } from 'eventemitter3';
import { createLogger } from '../utils/logger.js';
import { DeepCWDecoderBackend } from './DeepCWDecoderBackend.js';
import { probeDeepCWRuntime } from '../worker-pool/CWDecoderWorkerCore.js';
import {
  DEFAULT_CW_DECODER_CONFIG,
  type CWDecoderAudioStream,
  type CWDecoderBackend,
  type CWDecoderBackendId,
  type CWDecoderCommitEvent,
  type CWDecoderConfig,
  type CWDecoderErrorEvent,
  type CWDecoderPendingEvent,
  type CWDecoderStatus,
  type CWDecoderWorkerTelemetrySnapshot,
} from './types.js';

const logger = createLogger('CWDecoderManager');

export interface CWDecoderManagerEvents {
  cwDecoderStatusChanged: (status: CWDecoderStatus) => void;
  cwDecoderConfigChanged: (config: CWDecoderConfig) => void;
  cwDecoderPending: (event: CWDecoderPendingEvent) => void;
  cwDecoderCommit: (event: CWDecoderCommitEvent) => void;
  cwDecoderError: (event: CWDecoderErrorEvent) => void;
}

export interface CWDecoderManagerOptions {
  initialConfig?: Partial<CWDecoderConfig>;
  backends?: Partial<Record<CWDecoderBackendId, CWDecoderBackend>>;
}

interface AttachedAudioStream {
  stream: CWDecoderAudioStream;
  listener: (...args: unknown[]) => void;
  unsubscribe?: () => void;
}

export class CWDecoderManager extends EventEmitter<CWDecoderManagerEvents> {
  private readonly backends: Record<CWDecoderBackendId, CWDecoderBackend>;
  private config: CWDecoderConfig;
  private status: CWDecoderStatus;
  private started = false;
  private attachedAudio: AttachedAudioStream | null = null;
  private transmitMuted = false;

  private readonly backendStatusListener = (status: CWDecoderStatus) => this.setStatus(status);
  private readonly backendPendingListener = (event: CWDecoderPendingEvent) => this.emit('cwDecoderPending', event);
  private readonly backendCommitListener = (event: CWDecoderCommitEvent) => this.emit('cwDecoderCommit', event);
  private readonly backendErrorListener = (event: CWDecoderErrorEvent) => {
    this.emit('cwDecoderError', event);
    this.setStatus({ ...this.status, state: 'error', backendAvailable: false, backendError: event.error });
  };

  constructor(options: CWDecoderManagerOptions = {}) {
    super();
    this.backends = {
      'deepcw-onnx': options.backends?.['deepcw-onnx'] ?? new DeepCWDecoderBackend(),
    };
    this.config = this.normalizeConfig({ ...DEFAULT_CW_DECODER_CONFIG, ...options.initialConfig });
    this.status = this.disabledStatus();
    this.bindBackend(this.getBackend());
  }

  getBackends(): Array<{ id: CWDecoderBackendId; available: boolean; error: string | null }> {
    return Object.values(this.backends).map((backend) => {
      const status = backend.getStatus();
      if (!this.started && backend.id === 'deepcw-onnx') {
        // Availability is a lightweight dependency/file check only. Do not call
        // backend.updateConfig/start here, because those paths may load model
        // state for future backend implementations.
        const probe = probeDeepCWRuntime(this.config.modelPath);
        return { id: backend.id, available: probe.available, error: probe.error };
      }
      return { id: backend.id, available: status.backendAvailable, error: status.backendError };
    });
  }

  getConfig(): CWDecoderConfig {
    return { ...this.config };
  }

  getStatus(): CWDecoderStatus {
    return { ...this.status };
  }

  getWorkerPoolTelemetrySnapshot(): CWDecoderWorkerTelemetrySnapshot {
    return this.getBackend().getTelemetrySnapshot();
  }

  setTransmitMuted(muted: boolean): void {
    if (this.transmitMuted === muted) return;
    this.transmitMuted = muted;
    this.setStatus({
      ...this.status,
      state: muted && this.started && this.config.enabled ? 'running' : this.getBackend().getStatus().state,
      muted,
    });
  }

  async start(configUpdate: Partial<CWDecoderConfig> = {}): Promise<void> {
    this.config = this.normalizeConfig({ ...this.config, ...configUpdate });
    this.started = true;
    this.emit('cwDecoderConfigChanged', this.getConfig());

    if (!this.config.enabled) {
      await this.getBackend().stop('disabled');
      this.setStatus(this.disabledStatus());
      return;
    }

    await this.getBackend().start(this.config);
    this.setStatus(this.getBackend().getStatus());
  }

  async stop(reason = 'manual'): Promise<void> {
    this.started = false;
    await this.getBackend().stop(reason);
    this.setStatus(this.disabledStatus('stopped'));
  }

  clearTranscript(): CWDecoderStatus {
    this.getBackend().clearTranscript?.();
    const backendStatus = this.getBackend().getStatus();
    this.setStatus({
      ...backendStatus,
      lastPendingText: '',
      lastCommittedText: '',
      queuedSamples: 0,
    });
    return this.getStatus();
  }

  async updateConfig(update: Partial<CWDecoderConfig>): Promise<void> {
    const previousBackend = this.config.backend;
    const next = this.normalizeConfig({ ...this.config, ...update });
    this.config = next;
    this.emit('cwDecoderConfigChanged', this.getConfig());

    if (previousBackend !== next.backend) {
      this.unbindBackend(this.backends[previousBackend]);
      this.bindBackend(this.getBackend());
    }

    if (!this.started) {
      this.setStatus(this.config.enabled ? this.status : this.disabledStatus());
      return;
    }

    if (!this.config.enabled) {
      await this.getBackend().stop('disabled');
      this.setStatus(this.disabledStatus());
      return;
    }

    await this.getBackend().updateConfig(this.config);
    this.setStatus(this.getBackend().getStatus());
  }

  attachAudioStream(stream: CWDecoderAudioStream): void {
    this.detachAudioStream();
    const listener = (...args: unknown[]) => this.handleAudioChunk(...args);
    const subscription = stream.subscribe?.(listener);
    let unsubscribe: (() => void) | undefined;
    if (typeof subscription === 'function') {
      unsubscribe = subscription;
    } else if (subscription?.unsubscribe) {
      unsubscribe = () => subscription.unsubscribe?.();
    } else if (stream.on) {
      stream.on('audioData', listener);
      stream.on('audio', listener);
      stream.on('data', listener);
      unsubscribe = () => {
        if (stream.off) {
          stream.off('audioData', listener);
          stream.off('audio', listener);
          stream.off('data', listener);
        } else {
          stream.removeListener?.('audioData', listener);
          stream.removeListener?.('audio', listener);
          stream.removeListener?.('data', listener);
        }
      };
    }
    this.attachedAudio = { stream, listener, unsubscribe };
  }

  detachAudioStream(): void {
    this.attachedAudio?.unsubscribe?.();
    this.attachedAudio = null;
  }

  pushAudio(chunk: Float32Array, sampleRate = this.config.inputSampleRate, timestamp?: number): void {
    if (!this.started || !this.config.enabled) {
      return;
    }
    if (this.transmitMuted && this.config.muteWhileTransmitting) {
      return;
    }
    this.getBackend().pushAudio(chunk, sampleRate, timestamp);
  }

  private handleAudioChunk(...args: unknown[]): void {
    const first = args[0];
    if (first instanceof Float32Array) {
      this.pushAudio(first, typeof args[1] === 'number' ? args[1] : this.config.inputSampleRate);
      return;
    }
    if (first && typeof first === 'object') {
      const candidate = first as { samples?: unknown; audio?: unknown; audioData?: unknown; sampleRate?: unknown; timestamp?: unknown };
      const samples = candidate.samples instanceof Float32Array ? candidate.samples : candidate.audio instanceof Float32Array ? candidate.audio : null;
      const audioData = samples ?? (candidate.audioData instanceof ArrayBuffer ? new Float32Array(candidate.audioData) : null);
      if (audioData) {
        this.pushAudio(
          audioData,
          typeof candidate.sampleRate === 'number' ? candidate.sampleRate : this.config.inputSampleRate,
          typeof candidate.timestamp === 'number' ? candidate.timestamp : undefined,
        );
      }
    }
  }

  private getBackend(): CWDecoderBackend {
    return this.backends[this.config.backend];
  }

  private bindBackend(backend: CWDecoderBackend): void {
    backend.on('status', this.backendStatusListener);
    backend.on('pending', this.backendPendingListener);
    backend.on('commit', this.backendCommitListener);
    backend.on('error', this.backendErrorListener);
  }

  private unbindBackend(backend: CWDecoderBackend): void {
    backend.off('status', this.backendStatusListener);
    backend.off('pending', this.backendPendingListener);
    backend.off('commit', this.backendCommitListener);
    backend.off('error', this.backendErrorListener);
  }

  private normalizeConfig(config: Partial<CWDecoderConfig>): CWDecoderConfig {
    return {
      ...DEFAULT_CW_DECODER_CONFIG,
      ...config,
      backend: config.backend ?? DEFAULT_CW_DECODER_CONFIG.backend,
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

  private disabledStatus(state: CWDecoderStatus['state'] = 'stopped'): CWDecoderStatus {
    return {
      enabled: this.config.enabled,
      backend: this.config.backend,
      state,
      backendAvailable: false,
      backendError: null,
      lastPendingText: '',
      lastCommittedText: '',
      lastDecodeAt: null,
      queuedSamples: 0,
      muted: this.transmitMuted,
    };
  }

  private setStatus(status: CWDecoderStatus): void {
    this.status = { ...status, enabled: this.config.enabled, backend: this.config.backend, muted: this.transmitMuted };
    this.emit('cwDecoderStatusChanged', this.getStatus());
    logger.debug('CW decoder status changed', this.status);
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value as number) : fallback;
}
