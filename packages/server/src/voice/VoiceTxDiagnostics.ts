import type {
  RealtimeTransportKind,
  RealtimeVoiceTxBottleneckStage,
  RealtimeVoiceTxMetricWindow,
  RealtimeVoiceTxStatsResponse,
  ResolvedVoiceTxBufferPolicy,
} from '@tx5dr/contracts';

const ROLLING_WINDOW_MS = 5_000;
const PEAK_WINDOW_MS = 10_000;

interface TimedValue {
  at: number;
  value: number;
}

export interface VoiceTxFrameMeta {
  transport: RealtimeTransportKind;
  participantIdentity: string;
  sequence?: number | null;
  clientSentAtMs?: number | null;
  serverReceivedAtMs: number;
  mediaTimestampMs?: number;
  frameDurationMs?: number;
  codec?: 'opus' | 'pcm-s16le';
  sampleRate: number;
  samplesPerChannel: number;
  voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  concealment?: 'opus-plc' | 'pcm-tail';
}

export interface VoiceTxProcessedFrameStats {
  meta: VoiceTxFrameMeta;
  queueDepthFrames: number;
  queuedAudioMs: number;
  resampleMs: number;
  queueWaitMs: number;
  writeMs: number;
  serverPipelineMs: number;
  endToEndMs: number | null;
  outputBufferedMs: number | null;
  outputSampleRate: number | null;
  outputBufferSize: number | null;
  outputWriteIntervalMs?: number | null;
  jitterTargetMs?: number;
  underrunCount?: number;
  plcFrames?: number;
}

class MetricSeries {
  private readonly values: TimedValue[] = [];

  record(value: number, at = Date.now()): void {
    if (!Number.isFinite(value)) {
      return;
    }

    this.values.push({ at, value });
    this.trim(at);
  }

  snapshot(now = Date.now()): RealtimeVoiceTxMetricWindow {
    this.trim(now);

    if (this.values.length === 0) {
      return {
        current: null,
        rolling: null,
        peak: null,
      };
    }

    const current = this.values[this.values.length - 1]?.value ?? null;
    const rollingValues = this.values.filter((entry) => (now - entry.at) <= ROLLING_WINDOW_MS);
    const peakValues = this.values.filter((entry) => (now - entry.at) <= PEAK_WINDOW_MS);

    const rolling = rollingValues.length > 0
      ? rollingValues.reduce((sum, entry) => sum + entry.value, 0) / rollingValues.length
      : null;
    const peak = peakValues.length > 0
      ? peakValues.reduce((max, entry) => Math.max(max, entry.value), Number.NEGATIVE_INFINITY)
      : null;

    return {
      current,
      rolling,
      peak,
    };
  }

  reset(): void {
    this.values.length = 0;
  }

  private trim(now: number): void {
    while (this.values.length > 0 && (now - this.values[0]!.at) > PEAK_WINDOW_MS) {
      this.values.shift();
    }
  }
}

interface SessionInfo {
  clientId: string;
  label: string;
  startedAt: number;
  updatedAt: number;
  transport: RealtimeTransportKind | null;
}

export class VoiceTxDiagnostics {
  private activeSession: SessionInfo | null = null;
  private lastSnapshot: RealtimeVoiceTxStatsResponse | null = null;
  private receivedFrames = 0;
  private sequenceGaps = 0;
  private lastSequence: number | null = null;
  private droppedFrames = 0;
  private staleDroppedFrames = 0;
  private writeFailures = 0;
  private queueDepthFrames = 0;
  private queuedAudioMs = 0;
  private jitterTargetMs = 0;
  private underrunCount = 0;
  private plcFrames = 0;
  private outputSampleRate: number | null = null;
  private outputBufferSize: number | null = null;
  private lastFrameReceivedAt: number | null = null;

  private readonly clientToServerMs = new MetricSeries();
  private readonly frameIntervalMs = new MetricSeries();
  private readonly resampleMs = new MetricSeries();
  private readonly queueWaitMs = new MetricSeries();
  private readonly writeMs = new MetricSeries();
  private readonly serverPipelineMs = new MetricSeries();
  private readonly endToEndMs = new MetricSeries();
  private readonly outputBufferedMs = new MetricSeries();
  private readonly outputWriteIntervalMs = new MetricSeries();

  startSession(clientId: string, label: string): void {
    const now = Date.now();
    this.activeSession = {
      clientId,
      label,
      startedAt: now,
      updatedAt: now,
      transport: null,
    };
    this.resetMetrics();
  }

  endSession(): void {
    this.lastSnapshot = this.buildSnapshot(false);
    this.activeSession = null;
  }

  noteIngress(meta: VoiceTxFrameMeta): void {
    const session = this.activeSession;
    if (!session) {
      return;
    }

    session.updatedAt = Date.now();
    session.transport = meta.transport;
    this.receivedFrames += 1;

    if (this.lastFrameReceivedAt !== null) {
      this.frameIntervalMs.record(meta.serverReceivedAtMs - this.lastFrameReceivedAt, meta.serverReceivedAtMs);
    }
    this.lastFrameReceivedAt = meta.serverReceivedAtMs;

    if (typeof meta.clientSentAtMs === 'number') {
      const delta = meta.serverReceivedAtMs - meta.clientSentAtMs;
      if (delta >= 0 && delta <= 60_000) {
        this.clientToServerMs.record(delta, meta.serverReceivedAtMs);
      }
    }

    if (typeof meta.sequence === 'number') {
      if (typeof this.lastSequence === 'number' && meta.sequence > (this.lastSequence + 1)) {
        this.sequenceGaps += meta.sequence - this.lastSequence - 1;
      }
      this.lastSequence = meta.sequence;
    }
  }

  noteQueueState(queueDepthFrames: number, queuedAudioMs: number): void {
    if (!this.activeSession) {
      return;
    }

    this.queueDepthFrames = Math.max(0, Math.round(queueDepthFrames));
    this.queuedAudioMs = Math.max(0, queuedAudioMs);
    this.activeSession.updatedAt = Date.now();
  }

  noteDropped(queueDepthFrames: number, queuedAudioMs: number, reason?: 'backpressure' | 'output-unavailable' | 'stale' | 'jitter-trim'): void {
    if (!this.activeSession) {
      return;
    }

    this.droppedFrames += 1;
    if (reason === 'stale') {
      this.staleDroppedFrames += 1;
    }
    this.noteQueueState(queueDepthFrames, queuedAudioMs);
  }

  noteProcessed(stats: VoiceTxProcessedFrameStats): void {
    if (!this.activeSession) {
      return;
    }

    this.noteQueueState(stats.queueDepthFrames, stats.queuedAudioMs);
    this.outputSampleRate = stats.outputSampleRate ?? this.outputSampleRate;
    this.outputBufferSize = stats.outputBufferSize ?? this.outputBufferSize;
    this.resampleMs.record(stats.resampleMs);
    this.queueWaitMs.record(stats.queueWaitMs);
    this.writeMs.record(stats.writeMs);
    this.serverPipelineMs.record(stats.serverPipelineMs);
    if (typeof stats.endToEndMs === 'number' && stats.endToEndMs >= 0) {
      this.endToEndMs.record(stats.endToEndMs);
    }
    if (typeof stats.outputBufferedMs === 'number' && stats.outputBufferedMs >= 0) {
      this.outputBufferedMs.record(stats.outputBufferedMs);
    }
    if (typeof stats.outputWriteIntervalMs === 'number' && stats.outputWriteIntervalMs >= 0) {
      this.outputWriteIntervalMs.record(stats.outputWriteIntervalMs);
    }
    if (typeof stats.jitterTargetMs === 'number' && stats.jitterTargetMs >= 0) {
      this.jitterTargetMs = stats.jitterTargetMs;
    }
    if (typeof stats.underrunCount === 'number' && stats.underrunCount >= 0) {
      this.underrunCount = Math.round(stats.underrunCount);
    }
    if (typeof stats.plcFrames === 'number' && stats.plcFrames >= 0) {
      this.plcFrames = Math.round(stats.plcFrames);
    }
    this.activeSession.updatedAt = Date.now();
  }

  noteWriteFailure(): void {
    if (!this.activeSession) {
      return;
    }

    this.writeFailures += 1;
    this.activeSession.updatedAt = Date.now();
  }

  getSnapshot(): RealtimeVoiceTxStatsResponse {
    if (this.activeSession) {
      return this.buildSnapshot(true);
    }

    return this.lastSnapshot ?? this.buildEmptySnapshot();
  }

  private buildSnapshot(active: boolean): RealtimeVoiceTxStatsResponse {
    const now = Date.now();
    const summaryTransport = this.activeSession?.transport ?? this.lastSnapshot?.summary.transport ?? null;
    const snapshot: RealtimeVoiceTxStatsResponse = {
      scope: 'radio',
      summary: {
        active,
        transport: summaryTransport,
        bottleneckStage: null,
        startedAt: this.activeSession?.startedAt ?? this.lastSnapshot?.summary.startedAt ?? null,
        updatedAt: this.activeSession?.updatedAt ?? this.lastSnapshot?.summary.updatedAt ?? null,
        clientId: this.activeSession?.clientId ?? this.lastSnapshot?.summary.clientId ?? null,
        label: this.activeSession?.label ?? this.lastSnapshot?.summary.label ?? null,
      },
      transport: {
        receivedFrames: this.receivedFrames,
        sequenceGaps: this.sequenceGaps,
        lastSequence: this.lastSequence,
        clientToServerMs: this.clientToServerMs.snapshot(now),
      },
      serverIngress: {
        frameIntervalMs: this.frameIntervalMs.snapshot(now),
        queueDepthFrames: this.queueDepthFrames,
        queuedAudioMs: this.queuedAudioMs,
        droppedFrames: this.droppedFrames,
        staleDroppedFrames: this.staleDroppedFrames,
        underrunCount: this.underrunCount,
        plcFrames: this.plcFrames,
        jitterTargetMs: this.jitterTargetMs,
      },
      serverOutput: {
        resampleMs: this.resampleMs.snapshot(now),
        queueWaitMs: this.queueWaitMs.snapshot(now),
        writeMs: this.writeMs.snapshot(now),
        serverPipelineMs: this.serverPipelineMs.snapshot(now),
        endToEndMs: this.endToEndMs.snapshot(now),
        outputBufferedMs: this.outputBufferedMs.snapshot(now),
        outputWriteIntervalMs: this.outputWriteIntervalMs.snapshot(now),
        outputSampleRate: this.outputSampleRate,
        outputBufferSize: this.outputBufferSize,
        writeFailures: this.writeFailures,
      },
    };

    snapshot.summary.bottleneckStage = this.resolveBottleneckStage(snapshot);
    return snapshot;
  }

  private resolveBottleneckStage(snapshot: RealtimeVoiceTxStatsResponse): RealtimeVoiceTxBottleneckStage | null {
    const candidates: Array<{ stage: RealtimeVoiceTxBottleneckStage; value: number }> = [
      {
        stage: 'transport',
        value: snapshot.transport.clientToServerMs.rolling ?? 0,
      },
      {
        stage: 'server-queue',
        value: Math.max(
          snapshot.serverOutput.queueWaitMs.rolling ?? 0,
          snapshot.serverIngress.queuedAudioMs,
        ),
      },
      {
        stage: 'server-output',
        value: Math.max(
          snapshot.serverOutput.resampleMs.rolling ?? 0,
          snapshot.serverOutput.writeMs.rolling ?? 0,
          snapshot.serverOutput.outputBufferedMs.rolling ?? 0,
        ),
      },
    ];

    const winner = candidates.reduce<{ stage: RealtimeVoiceTxBottleneckStage; value: number } | null>((best, current) => {
      if (current.value <= 0) {
        return best;
      }
      if (!best || current.value > best.value) {
        return current;
      }
      return best;
    }, null);

    return winner?.stage ?? null;
  }

  private buildEmptySnapshot(): RealtimeVoiceTxStatsResponse {
    return {
      scope: 'radio',
      summary: {
        active: false,
        transport: null,
        bottleneckStage: null,
        startedAt: null,
        updatedAt: null,
        clientId: null,
        label: null,
      },
      transport: {
        receivedFrames: 0,
        sequenceGaps: 0,
        lastSequence: null,
        clientToServerMs: this.emptyMetricWindow(),
      },
      serverIngress: {
        frameIntervalMs: this.emptyMetricWindow(),
        queueDepthFrames: 0,
        queuedAudioMs: 0,
        droppedFrames: 0,
        staleDroppedFrames: 0,
        underrunCount: 0,
        plcFrames: 0,
        jitterTargetMs: 0,
      },
      serverOutput: {
        resampleMs: this.emptyMetricWindow(),
        queueWaitMs: this.emptyMetricWindow(),
        writeMs: this.emptyMetricWindow(),
        serverPipelineMs: this.emptyMetricWindow(),
        endToEndMs: this.emptyMetricWindow(),
        outputBufferedMs: this.emptyMetricWindow(),
        outputWriteIntervalMs: this.emptyMetricWindow(),
        outputSampleRate: null,
        outputBufferSize: null,
        writeFailures: 0,
      },
    };
  }

  private emptyMetricWindow(): RealtimeVoiceTxMetricWindow {
    return {
      current: null,
      rolling: null,
      peak: null,
    };
  }

  private resetMetrics(): void {
    this.receivedFrames = 0;
    this.sequenceGaps = 0;
    this.lastSequence = null;
    this.droppedFrames = 0;
    this.staleDroppedFrames = 0;
    this.writeFailures = 0;
    this.queueDepthFrames = 0;
    this.queuedAudioMs = 0;
    this.jitterTargetMs = 0;
    this.underrunCount = 0;
    this.plcFrames = 0;
    this.outputSampleRate = null;
    this.outputBufferSize = null;
    this.lastFrameReceivedAt = null;
    this.clientToServerMs.reset();
    this.frameIntervalMs.reset();
    this.resampleMs.reset();
    this.queueWaitMs.reset();
    this.writeMs.reset();
    this.serverPipelineMs.reset();
    this.endToEndMs.reset();
    this.outputBufferedMs.reset();
    this.outputWriteIntervalMs.reset();
  }
}
