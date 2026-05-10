import type { CWKeyerBackend as CWKeyerBackendType, CWKeyerConfig } from '@tx5dr/contracts';

export interface CWBackendAvailability {
  available: boolean;
  error: string | null;
}

export interface CWBackendPlaybackSignal {
  isStopped(): boolean;
  wait(ms: number): Promise<boolean>;
  onKeyDown?(): void;
}

export interface CWKeyerBackend {
  readonly type: CWKeyerBackendType;
  readonly supportsManualKeying: boolean;

  start(config: CWKeyerConfig): Promise<void>;
  stop(): Promise<void>;
  sendText(text: string, wpm: number, signal: CWBackendPlaybackSignal): Promise<void>;
  stopActive(): Promise<void>;
  getAvailability(): CWBackendAvailability;
  keyDown?(): Promise<void>;
  keyUp?(): Promise<void>;
}
