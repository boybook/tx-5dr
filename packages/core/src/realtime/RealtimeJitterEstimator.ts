export const REALTIME_TIMING_PROBE_TYPE = 'realtime-timing-probe';
export const REALTIME_TIMING_PROBE_INTERVAL_MS = 200;
export const REALTIME_JITTER_SEED_TTL_MS = 30 * 60 * 1000;

export type RealtimeTimingProbeStream = 'monitor-downlink' | 'voice-uplink';

export interface RealtimeTimingProbeMessage {
  type: typeof REALTIME_TIMING_PROBE_TYPE;
  stream: RealtimeTimingProbeStream;
  sequence: number;
  sentAtMs: number;
  intervalMs: number;
}

export interface RealtimeJitterEstimatorOptions {
  minTargetMs: number;
  initialTargetMs: number;
  maxTargetMs: number;
  softFloorMs?: number;
  frameDurationMs?: number;
  basePreRollMs?: number;
  schedulingMarginMs?: number;
  decreaseAfterMs?: number;
  decreaseStepMs?: number;
  underrunIncreaseMs?: number;
  windowMs?: number;
  maxSamples?: number;
  nowMs?: number;
}

export interface RealtimeJitterPacketSample {
  sequence?: number | null;
  mediaTimestampMs?: number | null;
  arrivalTimeMs: number;
  frameDurationMs?: number | null;
}

export interface RealtimeJitterProbeSample {
  sequence?: number | null;
  sentAtMs?: number | null;
  arrivalTimeMs: number;
  intervalMs?: number | null;
}

export interface RealtimeJitterEstimatorSnapshot {
  activeTargetMs: number;
  recommendedTargetMs: number;
  minTargetMs: number;
  maxTargetMs: number;
  softFloorMs: number;
  jitterEwmaMs: number;
  relativeDelayP95Ms: number;
  sampleCount: number;
  lastUpdatedAtMs: number | null;
  lastSample?: RealtimeJitterSampleDiagnostics | null;
}

export interface RealtimeJitterSampleDiagnostics {
  sequence: number | null;
  senderMs: number;
  arrivalMs: number;
  stepMs: number;
  arrivalDeltaMs: number | null;
  senderDeltaMs: number | null;
  jitterSampleMs: number | null;
  relativeTransitMs: number;
  minRelativeTransitMs: number;
  relativeDelayMs: number;
}

interface TimelineSample {
  sequence: number | null;
  senderMs: number;
  arrivalMs: number;
  stepMs: number;
}

interface DelaySample {
  at: number;
  delayMs: number;
}

export function isRealtimeTimingProbeMessage(value: unknown): value is RealtimeTimingProbeMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Partial<RealtimeTimingProbeMessage>;
  return message.type === REALTIME_TIMING_PROBE_TYPE
    && (message.stream === 'monitor-downlink' || message.stream === 'voice-uplink')
    && Number.isFinite(Number(message.sequence))
    && Number.isFinite(Number(message.sentAtMs));
}

export function createRealtimeTimingProbe(
  stream: RealtimeTimingProbeStream,
  sequence: number,
  sentAtMs = Date.now(),
  intervalMs = REALTIME_TIMING_PROBE_INTERVAL_MS,
): RealtimeTimingProbeMessage {
  return {
    type: REALTIME_TIMING_PROBE_TYPE,
    stream,
    sequence: Math.max(0, Math.round(sequence)),
    sentAtMs: Math.round(sentAtMs),
    intervalMs: Math.max(1, Math.round(intervalMs)),
  };
}

export function resolveRealtimeJitterSeedTargetMs(
  value: unknown,
  nowMs = Date.now(),
  ttlMs = REALTIME_JITTER_SEED_TTL_MS,
): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const seed = value as { targetMs?: unknown; updatedAtMs?: unknown };
  const targetMs = Number(seed.targetMs);
  const updatedAtMs = Number(seed.updatedAtMs);
  if (!Number.isFinite(targetMs) || targetMs <= 0 || !Number.isFinite(updatedAtMs)) {
    return null;
  }
  if ((nowMs - updatedAtMs) > ttlMs) {
    return null;
  }
  return Math.round(targetMs);
}

export class RealtimeJitterEstimator {
  private readonly minTargetMs: number;
  private readonly maxTargetMs: number;
  private readonly softFloorMs: number;
  private readonly frameDurationMs: number;
  private readonly basePreRollMs: number;
  private readonly schedulingMarginMs: number;
  private readonly decreaseAfterMs: number;
  private readonly decreaseStepMs: number;
  private readonly underrunIncreaseMs: number;
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private activeTargetMs: number;
  private lastTimelineSample: TimelineSample | null = null;
  private firstArrivalMs: number | null = null;
  private firstSenderMs: number | null = null;
  private minRelativeTransitMs = 0;
  private readonly delaySamples: DelaySample[] = [];
  private jitterEwmaMs = 0;
  private lastUpdatedAtMs: number | null = null;
  private lastSampleDiagnostics: RealtimeJitterSampleDiagnostics | null = null;
  private lastImpairmentAtMs: number;
  private lastTargetChangeAtMs: number;

  constructor(options: RealtimeJitterEstimatorOptions) {
    this.frameDurationMs = clampPositive(options.frameDurationMs, 20);
    this.minTargetMs = clampPositive(options.minTargetMs, 1);
    this.maxTargetMs = Math.max(this.minTargetMs, clampPositive(options.maxTargetMs, this.minTargetMs));
    this.softFloorMs = clamp(
      Math.round(options.softFloorMs ?? options.initialTargetMs),
      this.minTargetMs,
      this.maxTargetMs,
    );
    this.basePreRollMs = clampPositive(options.basePreRollMs, 60);
    this.schedulingMarginMs = Math.max(0, Math.round(options.schedulingMarginMs ?? 10));
    this.decreaseAfterMs = Math.max(0, Math.round(options.decreaseAfterMs ?? 10_000));
    this.decreaseStepMs = Math.max(1, Math.round(options.decreaseStepMs ?? this.frameDurationMs));
    this.underrunIncreaseMs = Math.max(1, Math.round(options.underrunIncreaseMs ?? this.frameDurationMs));
    this.windowMs = Math.max(1000, Math.round(options.windowMs ?? 10_000));
    this.maxSamples = Math.max(4, Math.round(options.maxSamples ?? 160));
    this.activeTargetMs = clamp(
      roundUpToStep(options.initialTargetMs, this.frameDurationMs),
      this.minTargetMs,
      this.maxTargetMs,
    );
    const now = Math.round(options.nowMs ?? Date.now());
    this.lastImpairmentAtMs = now;
    this.lastTargetChangeAtMs = now;
  }

  get targetMs(): number {
    return this.activeTargetMs;
  }

  reset(options?: { initialTargetMs?: number; nowMs?: number }): void {
    const now = Math.round(options?.nowMs ?? Date.now());
    const initial = options?.initialTargetMs ?? this.softFloorMs;
    this.activeTargetMs = clamp(roundUpToStep(initial, this.frameDurationMs), this.minTargetMs, this.maxTargetMs);
    this.lastTimelineSample = null;
    this.firstArrivalMs = null;
    this.firstSenderMs = null;
    this.minRelativeTransitMs = 0;
    this.delaySamples.length = 0;
    this.jitterEwmaMs = 0;
    this.lastUpdatedAtMs = null;
    this.lastSampleDiagnostics = null;
    this.lastImpairmentAtMs = now;
    this.lastTargetChangeAtMs = now;
  }

  recordPacket(sample: RealtimeJitterPacketSample): RealtimeJitterEstimatorSnapshot {
    const frameDurationMs = clampPositive(sample.frameDurationMs, this.frameDurationMs);
    // Packet timestamps are used for latency display elsewhere; jitter must use
    // the packet cadence so wall-clock/media timestamp skew cannot inflate delay.
    const senderMs = this.deriveSenderTimestamp(sample.sequence, frameDurationMs);
    return this.recordTimelineSample({
      sequence: typeof sample.sequence === 'number' ? sample.sequence : null,
      senderMs,
      arrivalMs: sample.arrivalTimeMs,
      stepMs: frameDurationMs,
    });
  }

  recordProbe(sample: RealtimeJitterProbeSample): RealtimeJitterEstimatorSnapshot {
    const intervalMs = clampPositive(sample.intervalMs, REALTIME_TIMING_PROBE_INTERVAL_MS);
    const senderMs = Number.isFinite(Number(sample.sentAtMs)) && Number(sample.sentAtMs) > 0
      ? Number(sample.sentAtMs)
      : this.deriveSenderTimestamp(sample.sequence, intervalMs);
    return this.recordTimelineSample({
      sequence: typeof sample.sequence === 'number' ? sample.sequence : null,
      senderMs,
      arrivalMs: sample.arrivalTimeMs,
      stepMs: intervalMs,
    });
  }

  noteUnderrun(nowMs = Date.now()): RealtimeJitterEstimatorSnapshot {
    const now = Math.round(nowMs);
    this.activeTargetMs = Math.min(this.maxTargetMs, roundUpToStep(this.activeTargetMs + this.underrunIncreaseMs, this.frameDurationMs));
    this.lastImpairmentAtMs = now;
    this.lastTargetChangeAtMs = now;
    return this.getSnapshot(now);
  }

  maybeUpdate(nowMs = Date.now()): RealtimeJitterEstimatorSnapshot {
    this.updateActiveTarget(Math.round(nowMs));
    return this.getSnapshot(nowMs);
  }

  getSnapshot(nowMs = Date.now()): RealtimeJitterEstimatorSnapshot {
    return {
      activeTargetMs: this.activeTargetMs,
      recommendedTargetMs: this.getRecommendedTargetMs(),
      minTargetMs: this.minTargetMs,
      maxTargetMs: this.maxTargetMs,
      softFloorMs: this.softFloorMs,
      jitterEwmaMs: this.jitterEwmaMs,
      relativeDelayP95Ms: this.getRelativeDelayP95Ms(),
      sampleCount: this.delaySamples.length,
      lastUpdatedAtMs: this.lastUpdatedAtMs ?? (this.delaySamples.length > 0 ? Math.round(nowMs) : null),
      lastSample: this.lastSampleDiagnostics,
    };
  }

  private recordTimelineSample(sample: TimelineSample): RealtimeJitterEstimatorSnapshot {
    const arrivalMs = Number(sample.arrivalMs);
    if (!Number.isFinite(arrivalMs)) {
      return this.getSnapshot();
    }
    const normalized: TimelineSample = {
      sequence: sample.sequence,
      senderMs: Number.isFinite(sample.senderMs) ? sample.senderMs : this.deriveSenderTimestamp(sample.sequence, sample.stepMs),
      arrivalMs,
      stepMs: clampPositive(sample.stepMs, this.frameDurationMs),
    };

    let arrivalDeltaMs: number | null = null;
    let senderDeltaMs: number | null = null;
    let jitterSampleMs: number | null = null;
    if (this.lastTimelineSample) {
      arrivalDeltaMs = normalized.arrivalMs - this.lastTimelineSample.arrivalMs;
      senderDeltaMs = this.resolveSenderDeltaMs(normalized, this.lastTimelineSample);
      if (arrivalDeltaMs >= 0 && senderDeltaMs > 0 && senderDeltaMs < 5000) {
        jitterSampleMs = Math.abs(arrivalDeltaMs - senderDeltaMs);
        this.jitterEwmaMs += (jitterSampleMs - this.jitterEwmaMs) / 16;
      }
    }

    if (this.firstArrivalMs === null || this.firstSenderMs === null) {
      this.firstArrivalMs = normalized.arrivalMs;
      this.firstSenderMs = normalized.senderMs;
      this.minRelativeTransitMs = 0;
    }
    const relativeTransitMs = (normalized.arrivalMs - this.firstArrivalMs) - (normalized.senderMs - this.firstSenderMs);
    this.minRelativeTransitMs = Math.min(this.minRelativeTransitMs, relativeTransitMs);
    const relativeDelayMs = Math.max(0, relativeTransitMs - this.minRelativeTransitMs);
    this.lastSampleDiagnostics = {
      sequence: normalized.sequence,
      senderMs: normalized.senderMs,
      arrivalMs: normalized.arrivalMs,
      stepMs: normalized.stepMs,
      arrivalDeltaMs,
      senderDeltaMs,
      jitterSampleMs,
      relativeTransitMs,
      minRelativeTransitMs: this.minRelativeTransitMs,
      relativeDelayMs,
    };
    this.delaySamples.push({ at: normalized.arrivalMs, delayMs: relativeDelayMs });
    this.trimSamples(normalized.arrivalMs);

    this.lastTimelineSample = normalized;
    this.lastUpdatedAtMs = normalized.arrivalMs;
    this.updateActiveTarget(normalized.arrivalMs);
    return this.getSnapshot(normalized.arrivalMs);
  }

  private deriveSenderTimestamp(sequence: number | null | undefined, stepMs: number): number {
    if (typeof sequence === 'number' && Number.isFinite(sequence)) {
      return sequence * stepMs;
    }
    if (this.lastTimelineSample) {
      return this.lastTimelineSample.senderMs + stepMs;
    }
    return 0;
  }

  private resolveSenderDeltaMs(current: TimelineSample, previous: TimelineSample): number {
    const directDelta = current.senderMs - previous.senderMs;
    if (directDelta > 0 && directDelta < 5000) {
      return directDelta;
    }
    if (typeof current.sequence === 'number' && typeof previous.sequence === 'number' && current.sequence > previous.sequence) {
      return (current.sequence - previous.sequence) * current.stepMs;
    }
    return current.stepMs;
  }

  private updateActiveTarget(nowMs: number): void {
    const recommended = this.getRecommendedTargetMs();
    if (recommended > this.activeTargetMs) {
      this.activeTargetMs = recommended;
      this.lastImpairmentAtMs = nowMs;
      this.lastTargetChangeAtMs = nowMs;
      return;
    }
    if (recommended >= this.activeTargetMs) {
      return;
    }
    if ((nowMs - this.lastImpairmentAtMs) < this.decreaseAfterMs) {
      return;
    }
    if ((nowMs - this.lastTargetChangeAtMs) < this.decreaseAfterMs) {
      return;
    }
    this.activeTargetMs = Math.max(recommended, this.activeTargetMs - this.decreaseStepMs, this.minTargetMs);
    this.lastTargetChangeAtMs = nowMs;
    this.lastImpairmentAtMs = nowMs;
  }

  private getRecommendedTargetMs(): number {
    const raw = this.basePreRollMs + this.getRelativeDelayP95Ms() + this.schedulingMarginMs;
    const rounded = roundUpToStep(raw, this.frameDurationMs);
    return clamp(Math.max(rounded, this.softFloorMs), this.minTargetMs, this.maxTargetMs);
  }

  private getRelativeDelayP95Ms(): number {
    if (this.delaySamples.length === 0) {
      return 0;
    }
    const sorted = this.delaySamples.map((sample) => sample.delayMs).sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return sorted[index] ?? 0;
  }

  private trimSamples(nowMs: number): void {
    while (this.delaySamples.length > 0 && (nowMs - this.delaySamples[0]!.at) > this.windowMs) {
      this.delaySamples.shift();
    }
    while (this.delaySamples.length > this.maxSamples) {
      this.delaySamples.shift();
    }
  }
}

function clampPositive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roundUpToStep(value: number, step: number): number {
  const safeStep = Math.max(1, Math.round(step));
  return Math.ceil(value / safeStep) * safeStep;
}
