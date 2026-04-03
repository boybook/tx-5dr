import type { RealtimeTransportKind } from '@tx5dr/contracts';

const ROLLING_WINDOW_MS = 5_000;
const PEAK_WINDOW_MS = 10_000;

interface TimedValue {
  at: number;
  value: number;
}

export interface VoiceTxLocalMetricWindow {
  current: number | null;
  rolling: number | null;
  peak: number | null;
}

export interface VoiceTxLocalDiagnostics {
  transport: RealtimeTransportKind | null;
  framesSent: number;
  sendSkippedFrames: number;
  samplesPerFrame: number | null;
  frameIntervalMs: VoiceTxLocalMetricWindow;
  encodeAndSendMs: VoiceTxLocalMetricWindow;
  socketBufferedAmountBytes: number | null;
  pttToFirstSentFrameMs: number | null;
  pttToTrackUnmuteMs: number | null;
  livekitBitrateKbps: number | null;
  livekitPacketsSent: number | null;
  livekitRoundTripTimeMs: number | null;
  livekitJitterMs: number | null;
  updatedAt: number | null;
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

  snapshot(now = Date.now()): VoiceTxLocalMetricWindow {
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

    return {
      current,
      rolling: rollingValues.length > 0
        ? rollingValues.reduce((sum, entry) => sum + entry.value, 0) / rollingValues.length
        : null,
      peak: peakValues.length > 0
        ? peakValues.reduce((max, entry) => Math.max(max, entry.value), Number.NEGATIVE_INFINITY)
        : null,
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

export class VoiceTxLocalStatsCollector {
  private transport: RealtimeTransportKind | null = null;
  private framesSent = 0;
  private sendSkippedFrames = 0;
  private samplesPerFrame: number | null = null;
  private socketBufferedAmountBytes: number | null = null;
  private pttActivatedAt: number | null = null;
  private pttToFirstSentFrameMs: number | null = null;
  private pttToTrackUnmuteMs: number | null = null;
  private livekitBitrateKbps: number | null = null;
  private livekitPacketsSent: number | null = null;
  private livekitRoundTripTimeMs: number | null = null;
  private livekitJitterMs: number | null = null;
  private lastSentAt: number | null = null;
  private updatedAt: number | null = null;
  private readonly frameIntervalMs = new MetricSeries();
  private readonly encodeAndSendMs = new MetricSeries();

  reset(transport: RealtimeTransportKind | null = null): void {
    this.transport = transport;
    this.framesSent = 0;
    this.sendSkippedFrames = 0;
    this.samplesPerFrame = null;
    this.socketBufferedAmountBytes = null;
    this.pttActivatedAt = null;
    this.pttToFirstSentFrameMs = null;
    this.pttToTrackUnmuteMs = null;
    this.livekitBitrateKbps = null;
    this.livekitPacketsSent = null;
    this.livekitRoundTripTimeMs = null;
    this.livekitJitterMs = null;
    this.lastSentAt = null;
    this.updatedAt = null;
    this.frameIntervalMs.reset();
    this.encodeAndSendMs.reset();
  }

  setTransport(transport: RealtimeTransportKind | null): void {
    this.transport = transport;
    this.updatedAt = Date.now();
  }

  notePTTActivated(): void {
    this.pttActivatedAt = Date.now();
    this.pttToFirstSentFrameMs = null;
    this.pttToTrackUnmuteMs = null;
    this.updatedAt = this.pttActivatedAt;
  }

  noteTrackUnmuted(durationMs: number): void {
    this.pttToTrackUnmuteMs = durationMs;
    if (this.pttToFirstSentFrameMs === null) {
      this.pttToFirstSentFrameMs = durationMs;
    }
    this.updatedAt = Date.now();
  }

  noteLiveKitSenderStats(data: {
    bitrateKbps: number | null;
    packetsSent: number | null;
    roundTripTimeMs: number | null;
    jitterMs: number | null;
  }): void {
    this.livekitBitrateKbps = data.bitrateKbps;
    this.livekitPacketsSent = data.packetsSent;
    this.livekitRoundTripTimeMs = data.roundTripTimeMs;
    this.livekitJitterMs = data.jitterMs;
    this.updatedAt = Date.now();
  }

  noteFrameSent(samplesPerFrame: number, sendDurationMs: number, socketBufferedAmountBytes: number | null): void {
    const now = Date.now();
    if (this.lastSentAt !== null) {
      this.frameIntervalMs.record(now - this.lastSentAt, now);
    }
    this.lastSentAt = now;
    this.framesSent += 1;
    this.samplesPerFrame = samplesPerFrame;
    this.socketBufferedAmountBytes = socketBufferedAmountBytes;
    this.encodeAndSendMs.record(sendDurationMs, now);
    if (this.pttActivatedAt !== null && this.pttToFirstSentFrameMs === null) {
      this.pttToFirstSentFrameMs = now - this.pttActivatedAt;
    }
    this.updatedAt = now;
  }

  noteFrameSkipped(): void {
    this.sendSkippedFrames += 1;
    this.updatedAt = Date.now();
  }

  getSnapshot(): VoiceTxLocalDiagnostics {
    const now = Date.now();
    return {
      transport: this.transport,
      framesSent: this.framesSent,
      sendSkippedFrames: this.sendSkippedFrames,
      samplesPerFrame: this.samplesPerFrame,
      frameIntervalMs: this.frameIntervalMs.snapshot(now),
      encodeAndSendMs: this.encodeAndSendMs.snapshot(now),
      socketBufferedAmountBytes: this.socketBufferedAmountBytes,
      pttToFirstSentFrameMs: this.pttToFirstSentFrameMs,
      pttToTrackUnmuteMs: this.pttToTrackUnmuteMs,
      livekitBitrateKbps: this.livekitBitrateKbps,
      livekitPacketsSent: this.livekitPacketsSent,
      livekitRoundTripTimeMs: this.livekitRoundTripTimeMs,
      livekitJitterMs: this.livekitJitterMs,
      updatedAt: this.updatedAt,
    };
  }
}
