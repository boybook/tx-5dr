import type { DecodeWorkerTelemetryWorker } from '@tx5dr/contracts';
import type { EventEmitter } from 'eventemitter3';

export type CWDecoderBackendId = 'deepcw-onnx';
export type CWDecoderLifecycleState = 'stopped' | 'starting' | 'running' | 'stopping' | 'unavailable' | 'error';

export interface CWDecoderConfig {
  enabled: boolean;
  backend: CWDecoderBackendId;
  windowSeconds: number;
  decodeIntervalMs: number;
  targetFreqHz: number;
  filterWidthHz: number;
  runtimeBackend: 'cpu' | 'cuda' | 'coreml' | 'directml' | 'wasm' | 'webgpu';
  modelSize: 'tiny' | 'small';
  language: string;
  mode: 'streaming';
  muteWhileTransmitting: boolean;
  inputSampleRate: number;
  decodeSampleRate: number;
  minCommitChars: number;
  commitStability: number;
  maxPendingAgeMs: number;
  workerCount: number;
  modelPath?: string | null;
}

export interface CWDecoderStatus {
  enabled: boolean;
  backend: CWDecoderBackendId;
  state: CWDecoderLifecycleState;
  backendAvailable: boolean;
  backendError: string | null;
  lastPendingText: string;
  lastCommittedText: string;
  lastDecodeAt: number | null;
  queuedSamples: number;
  muted: boolean;
}

export interface CWDecoderPendingEvent {
  type: 'pending';
  backend: CWDecoderBackendId;
  sessionId?: string;
  version?: number;
  text: string;
  plainText?: string;
  finalized?: false;
  confidence: number;
  targetFreqHz?: number;
  filterWidthHz?: number;
  characterSpans?: CWDecoderCharacterSpan[];
  wordSpaceSpans?: CWDecoderWordSpaceSpan[];
  timestamp: number;
}

export interface CWDecoderCommitEvent {
  type: 'commit';
  id: string;
  backend: CWDecoderBackendId;
  sessionId?: string;
  sequence?: number;
  text: string;
  plainText?: string;
  finalized?: true;
  prependSpace?: boolean;
  confidence: number;
  timestamp: number;
  targetFreqHz?: number;
  filterWidthHz?: number;
  characterSpans?: CWDecoderCharacterSpan[];
  wordSpaceSpans?: CWDecoderWordSpaceSpan[];
  startedAt?: number;
  endedAt?: number;
  updatedAt?: number;
}

export interface CWDecoderTranscriptResetEvent {
  type: 'transcript_reset';
  backend: CWDecoderBackendId;
  sessionId: string;
  timestamp: number;
}

export interface CWDecoderErrorEvent {
  type: 'error';
  backend: CWDecoderBackendId;
  error: string;
  recoverable: boolean;
  timestamp: number;
}

export interface CWDecoderWorkerTelemetrySnapshot {
  status: 'stopped' | 'running' | 'unavailable' | 'error';
  workerCount: number;
  jobsStarted: number;
  jobsCompleted: number;
  jobsFailed: number;
  inFlight: number;
  pendingJobs?: number;
  lastError: string | null;
  workers?: DecodeWorkerTelemetryWorker[];
}

export interface CWDecoderBackendEvents {
  status: (status: CWDecoderStatus) => void;
  reset: (event: CWDecoderTranscriptResetEvent) => void;
  pending: (event: CWDecoderPendingEvent) => void;
  commit: (event: CWDecoderCommitEvent) => void;
  error: (event: CWDecoderErrorEvent) => void;
}

export interface CWDecoderBackend extends EventEmitter<CWDecoderBackendEvents> {
  readonly id: CWDecoderBackendId;
  start(config: CWDecoderConfig): Promise<void>;
  stop(reason?: string): Promise<void>;
  updateConfig(config: CWDecoderConfig): Promise<void>;
  updateTuning?(tuning: Pick<CWDecoderConfig, 'targetFreqHz' | 'filterWidthHz'>): Promise<void> | void;
  clearTranscript?(): void;
  pushAudio(chunk: Float32Array, sampleRate: number, timestamp?: number): void;
  getStatus(): CWDecoderStatus;
  getTelemetrySnapshot(): CWDecoderWorkerTelemetrySnapshot;
}

export interface CWDecoderAudioStream {
  on?(event: 'audioData' | 'audio' | 'data' | string, listener: (...args: unknown[]) => void): unknown;
  off?(event: 'audioData' | 'audio' | 'data' | string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: 'audioData' | 'audio' | 'data' | string, listener: (...args: unknown[]) => void): unknown;
  subscribe?(listener: (...args: unknown[]) => void): (() => void) | { unsubscribe?: () => void } | void;
}

export interface CWDecoderWordSpaceSpan {
  startFrame: number;
  endFrame: number;
}

export interface CWDecoderCharacterSpan {
  char: string;
  startFrame: number;
  endFrame: number;
}

export const DEFAULT_CW_DECODER_CONFIG: CWDecoderConfig = {
  enabled: false,
  backend: 'deepcw-onnx',
  inputSampleRate: 9_600,
  decodeSampleRate: 9_600,
  runtimeBackend: 'cpu',
  modelSize: 'tiny',
  language: 'en',
  mode: 'streaming',
  targetFreqHz: 800,
  filterWidthHz: 800,
  windowSeconds: 12,
  decodeIntervalMs: 1000,
  muteWhileTransmitting: true,
  minCommitChars: 1,
  commitStability: 2,
  maxPendingAgeMs: 4_000,
  workerCount: 1,
  modelPath: null,
};
