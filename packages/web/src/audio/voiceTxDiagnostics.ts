import type { RealtimeTransportKind } from '@tx5dr/contracts';
import type { RealtimeClockConfidence } from '../realtime/RealtimeClockSync';

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
  clientDroppedFrames: number;
  samplesPerFrame: number | null;
  frameIntervalMs: VoiceTxLocalMetricWindow;
  encodeAndSendMs: VoiceTxLocalMetricWindow;
  sendBufferedAudioMs: VoiceTxLocalMetricWindow;
  socketBufferedAmountBytes: number | null;
  clockConfidence: RealtimeClockConfidence;
  degraded: boolean;
  codec: 'opus' | 'pcm-s16le' | null;
  bitrateKbps: VoiceTxLocalMetricWindow;
  pttToFirstSentFrameMs: number | null;
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
  private clientDroppedFrames = 0;
  private samplesPerFrame: number | null = null;
  private socketBufferedAmountBytes: number | null = null;
  private clockConfidence: RealtimeClockConfidence = 'unknown';
  private degraded = false;
  private codec: 'opus' | 'pcm-s16le' | null = null;
  private pttActivatedAt: number | null = null;
  private pttToFirstSentFrameMs: number | null = null;
  private lastSentAt: number | null = null;
  private updatedAt: number | null = null;
  private readonly frameIntervalMs = new MetricSeries();
  private readonly encodeAndSendMs = new MetricSeries();
  private readonly sendBufferedAudioMs = new MetricSeries();
  private readonly bitrateKbps = new MetricSeries();

  reset(transport: RealtimeTransportKind | null = null): void {
    this.transport = transport;
    this.framesSent = 0;
    this.sendSkippedFrames = 0;
    this.clientDroppedFrames = 0;
    this.samplesPerFrame = null;
    this.socketBufferedAmountBytes = null;
    this.clockConfidence = 'unknown';
    this.degraded = false;
    this.codec = null;
    this.pttActivatedAt = null;
    this.pttToFirstSentFrameMs = null;
    this.lastSentAt = null;
    this.updatedAt = null;
    this.frameIntervalMs.reset();
    this.encodeAndSendMs.reset();
    this.sendBufferedAudioMs.reset();
    this.bitrateKbps.reset();
  }

  setTransport(transport: RealtimeTransportKind | null): void {
    this.transport = transport;
    this.updatedAt = Date.now();
  }

  notePTTActivated(): void {
    this.pttActivatedAt = Date.now();
    this.pttToFirstSentFrameMs = null;
    this.updatedAt = this.pttActivatedAt;
  }

  noteFrameSent(
    samplesPerFrame: number,
    sendDurationMs: number,
    socketBufferedAmountBytes: number | null,
    sendBufferedAudioMs: number | null = null,
    clockConfidence: RealtimeClockConfidence = 'unknown',
    degraded = false,
    codec: 'opus' | 'pcm-s16le' | null = null,
    bitrateKbps: number | null = null,
  ): void {
    const now = Date.now();
    if (this.lastSentAt !== null) {
      this.frameIntervalMs.record(now - this.lastSentAt, now);
    }
    this.lastSentAt = now;
    this.framesSent += 1;
    this.samplesPerFrame = samplesPerFrame;
    this.socketBufferedAmountBytes = socketBufferedAmountBytes;
    this.clockConfidence = clockConfidence;
    this.degraded = degraded;
    this.codec = codec;
    this.encodeAndSendMs.record(sendDurationMs, now);
    if (sendBufferedAudioMs !== null) {
      this.sendBufferedAudioMs.record(sendBufferedAudioMs, now);
    }
    if (bitrateKbps !== null) {
      this.bitrateKbps.record(bitrateKbps, now);
    }
    if (this.pttActivatedAt !== null && this.pttToFirstSentFrameMs === null) {
      this.pttToFirstSentFrameMs = now - this.pttActivatedAt;
    }
    this.updatedAt = now;
  }

  noteFrameSkipped(dropped = false): void {
    this.sendSkippedFrames += 1;
    if (dropped) {
      this.clientDroppedFrames += 1;
    }
    this.updatedAt = Date.now();
  }

  getSnapshot(): VoiceTxLocalDiagnostics {
    const now = Date.now();
    return {
      transport: this.transport,
      framesSent: this.framesSent,
      sendSkippedFrames: this.sendSkippedFrames,
      clientDroppedFrames: this.clientDroppedFrames,
      samplesPerFrame: this.samplesPerFrame,
      frameIntervalMs: this.frameIntervalMs.snapshot(now),
      encodeAndSendMs: this.encodeAndSendMs.snapshot(now),
      sendBufferedAudioMs: this.sendBufferedAudioMs.snapshot(now),
      socketBufferedAmountBytes: this.socketBufferedAmountBytes,
      clockConfidence: this.clockConfidence,
      degraded: this.degraded,
      codec: this.codec,
      bitrateKbps: this.bitrateKbps.snapshot(now),
      pttToFirstSentFrameMs: this.pttToFirstSentFrameMs,
      updatedAt: this.updatedAt,
    };
  }
}
