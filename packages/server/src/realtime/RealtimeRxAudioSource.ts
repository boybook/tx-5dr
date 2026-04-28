import { EventEmitter } from 'eventemitter3';
import type { NativeAudioInputFrame, NativeAudioInputSourceKind, AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { BufferedPreviewAudioService } from '../audio/BufferedPreviewAudioService.js';

export type RealtimeRxAudioSourcePath = 'native-radio' | 'buffered-preview';
export type RealtimeRxNativeSourceKind = NativeAudioInputSourceKind | 'voice-tx-monitor' | 'openwebrx-monitor';

export interface RealtimeAudioFrame {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  timestamp: number;
  sequence: number;
  sourceKind: RealtimeRxAudioSourcePath;
  nativeSourceKind?: RealtimeRxNativeSourceKind;
}

export interface RealtimeRxAudioSourceStats {
  sourcePath: RealtimeRxAudioSourcePath;
  latencyMs: number;
  bufferFillPercent: number;
  isActive: boolean;
  audioLevel?: number;
  droppedSamples?: number;
  sampleRate: number;
  latestSequence: number;
  latestTimestamp: number;
  receivedFrames: number;
  bufferedLatencyMs?: number;
}

export interface RealtimeRxAudioSourceEvents {
  audioFrame: (frame: RealtimeAudioFrame) => void;
}

export interface RealtimeRxAudioSource extends EventEmitter<RealtimeRxAudioSourceEvents> {
  readonly id: string;
  readonly sourcePath: RealtimeRxAudioSourcePath;
  getLatestStats(): RealtimeRxAudioSourceStats | null;
  dispose?(): void;
}

export class NativeRadioRxSource
  extends EventEmitter<RealtimeRxAudioSourceEvents>
  implements RealtimeRxAudioSource {
  readonly id = 'native-radio:radio';
  readonly sourcePath = 'native-radio' as const;
  private static readonly TX_MONITOR_HOLD_MS = 120;
  private static readonly ACTIVE_HOLD_MS = 1000;
  private latestStats: RealtimeRxAudioSourceStats | null = null;
  private latestReceivedAt = 0;
  private receivedFrames = 0;
  private sequence = 0;
  private txMonitorActiveUntil = 0;

  constructor(private readonly audioStreamManager: AudioStreamManager) {
    super();
    this.audioStreamManager.on('nativeAudioInputData', this.handleNativeFrame);
    this.audioStreamManager.on('txMonitorAudioData', this.handleTxMonitorFrame);
  }

  getLatestStats(): RealtimeRxAudioSourceStats | null {
    if (!this.latestStats) {
      return null;
    }
    return {
      ...this.latestStats,
      isActive: Date.now() - this.latestReceivedAt <= NativeRadioRxSource.ACTIVE_HOLD_MS,
    };
  }

  dispose(): void {
    this.audioStreamManager.off('nativeAudioInputData', this.handleNativeFrame);
    this.audioStreamManager.off('txMonitorAudioData', this.handleTxMonitorFrame);
    this.removeAllListeners();
  }

  private readonly handleNativeFrame = (frame: NativeAudioInputFrame): void => {
    if (frame.samples.length === 0) {
      return;
    }
    if (Date.now() < this.txMonitorActiveUntil) {
      return;
    }

    this.receivedFrames += 1;
    this.latestReceivedAt = Date.now();
    const sequence = this.sequence++;
    const realtimeFrame: RealtimeAudioFrame = {
      samples: new Float32Array(frame.samples),
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      timestamp: frame.timestamp,
      sequence,
      sourceKind: this.sourcePath,
      nativeSourceKind: frame.sourceKind,
    };
    this.latestStats = {
      sourcePath: this.sourcePath,
      latencyMs: 0,
      bufferFillPercent: 100,
      isActive: true,
      audioLevel: calculateRms(frame.samples),
      droppedSamples: 0,
      sampleRate: frame.sampleRate,
      latestSequence: sequence,
      latestTimestamp: frame.timestamp,
      receivedFrames: this.receivedFrames,
    };
    this.emit('audioFrame', realtimeFrame);
  };

  private readonly handleTxMonitorFrame = (data: { samples: Float32Array; sampleRate: number }): void => {
    if (data.samples.length === 0 || data.sampleRate <= 0) {
      return;
    }

    this.receivedFrames += 1;
    const timestamp = Date.now();
    this.latestReceivedAt = timestamp;
    const durationMs = (data.samples.length / data.sampleRate) * 1000;
    this.txMonitorActiveUntil = Math.max(
      this.txMonitorActiveUntil,
      timestamp + durationMs + NativeRadioRxSource.TX_MONITOR_HOLD_MS,
    );
    const sequence = this.sequence++;
    this.latestStats = {
      sourcePath: this.sourcePath,
      latencyMs: 0,
      bufferFillPercent: 100,
      isActive: true,
      audioLevel: calculateRms(data.samples),
      droppedSamples: 0,
      sampleRate: data.sampleRate,
      latestSequence: sequence,
      latestTimestamp: timestamp,
      receivedFrames: this.receivedFrames,
    };
    this.emit('audioFrame', {
      samples: new Float32Array(data.samples),
      sampleRate: data.sampleRate,
      channels: 1,
      timestamp,
      sequence,
      sourceKind: this.sourcePath,
      nativeSourceKind: 'voice-tx-monitor',
    });
  };
}

export class BufferedPreviewRxSource
  extends EventEmitter<RealtimeRxAudioSourceEvents>
  implements RealtimeRxAudioSource {
  readonly sourcePath = 'buffered-preview' as const;
  private latestStats: RealtimeRxAudioSourceStats | null = null;
  private receivedFrames = 0;

  constructor(
    readonly id: string,
    private readonly bufferedPreviewAudioService: BufferedPreviewAudioService,
    private readonly monitorKind: Extract<RealtimeRxNativeSourceKind, 'openwebrx-monitor'>,
  ) {
    super();
    this.bufferedPreviewAudioService.on('audioData', this.handleMonitorFrame);
  }

  getLatestStats(): RealtimeRxAudioSourceStats | null {
    return this.latestStats;
  }

  dispose(): void {
    this.bufferedPreviewAudioService.off('audioData', this.handleMonitorFrame);
    this.removeAllListeners();
  }

  private readonly handleMonitorFrame = (data: {
    audioData: ArrayBuffer;
    sampleRate: number;
    samples: number;
    timestamp: number;
    sequence: number;
  }): void => {
    const samples = new Float32Array(data.audioData);
    if (samples.length === 0) {
      return;
    }

    this.receivedFrames += 1;
    const monitorStats = this.bufferedPreviewAudioService.getLatestStats();
    this.latestStats = {
      sourcePath: this.sourcePath,
      latencyMs: monitorStats?.latencyMs ?? 0,
      bufferFillPercent: monitorStats?.bufferFillPercent ?? 0,
      isActive: monitorStats?.isActive ?? false,
      audioLevel: monitorStats?.audioLevel,
      droppedSamples: monitorStats?.droppedSamples,
      sampleRate: data.sampleRate,
      latestSequence: data.sequence,
      latestTimestamp: data.timestamp,
      receivedFrames: this.receivedFrames,
      bufferedLatencyMs: monitorStats?.latencyMs,
    };
    this.emit('audioFrame', {
      samples: new Float32Array(samples),
      sampleRate: data.sampleRate,
      channels: 1,
      timestamp: data.timestamp,
      sequence: data.sequence,
      sourceKind: this.sourcePath,
      nativeSourceKind: this.monitorKind,
    });
  };
}

function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}
