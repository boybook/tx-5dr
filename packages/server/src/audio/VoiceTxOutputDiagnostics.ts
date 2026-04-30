import type { RealtimeJitterEstimatorSnapshot } from '@tx5dr/core';
import type { ResolvedVoiceTxBufferPolicy } from '@tx5dr/contracts';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';
import type { Logger } from '../utils/logger.js';
import type { VoiceTxOutputSinkState } from './VoiceTxOutputTypes.js';

export interface VoiceTxOutputDiagnosticsState {
  sink: VoiceTxOutputSinkState;
  queueMs: number;
  deviceLeadMs: number;
  desiredDeviceLeadMs: number;
  adaptiveTargetMs: number;
  playoutStarted: boolean;
  rebuffering: boolean;
  rebufferDurationMs: number;
  rebufferEnterWaterMs: number;
  rebufferResumeWaterMs: number;
  rebufferReason?: string;
  jitterSnapshot: RealtimeJitterEstimatorSnapshot | null;
  jitterSource: 'probe' | 'packet' | null;
  policy: ResolvedVoiceTxBufferPolicy;
  underrunCount: number;
  plcFrames: number;
  queueDepthFrames: number;
}

interface VoiceTxOutputDiagnosticsWindow {
  startedAt: number;
  ticks: number;
  maxTickGapMs: number;
  ingressFrames: number;
  ingressOpusPlcFrames: number;
  ingressIntervalSumMs: number;
  ingressIntervalMaxMs: number;
  clientToServerSumMs: number;
  clientToServerSamples: number;
  clientToServerMaxMs: number;
  resampleSumMs: number;
  resampleMaxMs: number;
  sequenceGaps: number;
  writes: number;
  maxWritesPerTick: number;
  catchupLimitHits: number;
  writeSumMs: number;
  writeMaxMs: number;
  writeIntervalSumMs: number;
  writeIntervalSamples: number;
  writeIntervalMaxMs: number;
  writeFailures: number;
  underruns: number;
  plcChunks: number;
  paddedChunks: number;
  partialChunks: number;
  trimEvents: number;
  trimDroppedSamples: number;
  droppedOutputUnavailable: number;
  droppedStale: number;
  droppedBackpressure: number;
  droppedJitterTrim: number;
  boundaryJumpMax: number;
  chunkRmsSum: number;
  chunkPeakMax: number;
  zeroChunks: number;
  queueMsMax: number;
  deviceLeadMsMax: number;
  deviceLeadMsMin: number | null;
  totalBufferedMsMin: number | null;
  totalBufferedMsMax: number;
  rebufferHoldTicks: number;
  rebufferSuppressedWrites: number;
  rebufferSafetyWrites: number;
  rebufferDeviceLeadLowWaterMs: number | null;
}

export class VoiceTxOutputDiagnostics {
  private window = this.createWindow();
  private lastTickAt: number | null = null;
  private lastIngressAt: number | null = null;
  private lastOutputSample: number | null = null;
  private lastLogAt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly enabled: boolean,
    private readonly intervalMs: number,
  ) {}

  reset(): void {
    this.window = this.createWindow();
    this.lastTickAt = null;
    this.lastIngressAt = null;
    this.lastOutputSample = null;
    this.lastLogAt = 0;
  }

  noteTick(): void {
    if (!this.enabled) {
      return;
    }
    const now = Date.now();
    if (this.lastTickAt !== null) {
      this.window.maxTickGapMs = Math.max(this.window.maxTickGapMs, now - this.lastTickAt);
    }
    this.lastTickAt = now;
    this.window.ticks += 1;
  }

  noteIngress(meta: VoiceTxFrameMeta, now: number, resampleMs: number): void {
    if (!this.enabled) {
      return;
    }
    if (this.lastIngressAt !== null) {
      const intervalMs = Math.max(0, now - this.lastIngressAt);
      this.window.ingressIntervalSumMs += intervalMs;
      this.window.ingressIntervalMaxMs = Math.max(this.window.ingressIntervalMaxMs, intervalMs);
    }
    this.lastIngressAt = now;
    this.window.ingressFrames += 1;
    if (meta.concealment === 'opus-plc') {
      this.window.ingressOpusPlcFrames += 1;
    }
    if (typeof meta.clientSentAtMs === 'number') {
      const clientToServerMs = Math.max(0, now - meta.clientSentAtMs);
      if (clientToServerMs <= 60_000) {
        this.window.clientToServerSumMs += clientToServerMs;
        this.window.clientToServerSamples += 1;
        this.window.clientToServerMaxMs = Math.max(this.window.clientToServerMaxMs, clientToServerMs);
      }
    }
    this.window.resampleSumMs += resampleMs;
    this.window.resampleMaxMs = Math.max(this.window.resampleMaxMs, resampleMs);
  }

  noteBuffer(queueMs: number, deviceLeadMs: number): void {
    if (!this.enabled) {
      return;
    }
    const totalBufferedMs = queueMs + deviceLeadMs;
    this.window.queueMsMax = Math.max(this.window.queueMsMax, queueMs);
    this.window.deviceLeadMsMax = Math.max(this.window.deviceLeadMsMax, deviceLeadMs);
    this.window.deviceLeadMsMin = this.window.deviceLeadMsMin === null
      ? deviceLeadMs
      : Math.min(this.window.deviceLeadMsMin, deviceLeadMs);
    this.window.totalBufferedMsMax = Math.max(this.window.totalBufferedMsMax, totalBufferedMs);
    this.window.totalBufferedMsMin = this.window.totalBufferedMsMin === null
      ? totalBufferedMs
      : Math.min(this.window.totalBufferedMsMin, totalBufferedMs);
  }

  noteOutput(samples: Float32Array, writeMs: number, outputWriteIntervalMs: number | null): void {
    if (!this.enabled) {
      return;
    }
    this.window.writes += 1;
    this.window.writeSumMs += writeMs;
    this.window.writeMaxMs = Math.max(this.window.writeMaxMs, writeMs);
    if (typeof outputWriteIntervalMs === 'number') {
      this.window.writeIntervalSamples += 1;
      this.window.writeIntervalSumMs += outputWriteIntervalMs;
      this.window.writeIntervalMaxMs = Math.max(this.window.writeIntervalMaxMs, outputWriteIntervalMs);
    }

    let sumSquares = 0;
    let peak = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index] ?? 0;
      sumSquares += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
    this.window.chunkRmsSum += rms;
    this.window.chunkPeakMax = Math.max(this.window.chunkPeakMax, peak);
    if (peak <= 1e-5) {
      this.window.zeroChunks += 1;
    }
    if (samples.length > 0) {
      const first = samples[0] ?? 0;
      if (this.lastOutputSample !== null) {
        this.window.boundaryJumpMax = Math.max(
          this.window.boundaryJumpMax,
          Math.abs(first - this.lastOutputSample),
        );
      }
      this.lastOutputSample = samples[samples.length - 1] ?? first;
    }
  }

  noteSequenceGap(count: number): void {
    this.window.sequenceGaps += Math.max(0, count);
  }

  noteUnderrun(): void {
    this.window.underruns += 1;
  }

  notePlcChunk(): void {
    this.window.plcChunks += 1;
  }

  notePaddedChunk(): void {
    this.window.paddedChunks += 1;
  }

  notePartialChunk(): void {
    this.window.partialChunks += 1;
  }

  noteTrim(dropSamples: number): void {
    this.window.trimEvents += 1;
    this.window.trimDroppedSamples += Math.max(0, dropSamples);
  }

  noteWriteFailure(): void {
    this.window.writeFailures += 1;
  }

  noteWritesPerTick(writes: number, catchupLimitHit: boolean): void {
    this.window.maxWritesPerTick = Math.max(this.window.maxWritesPerTick, writes);
    if (catchupLimitHit) {
      this.window.catchupLimitHits += 1;
    }
  }

  noteRebufferHold(suppressedWrite: boolean, deviceLeadMs: number): void {
    if (!this.enabled) {
      return;
    }
    this.window.rebufferHoldTicks += 1;
    if (suppressedWrite) {
      this.window.rebufferSuppressedWrites += 1;
    }
    this.window.rebufferDeviceLeadLowWaterMs = this.window.rebufferDeviceLeadLowWaterMs === null
      ? deviceLeadMs
      : Math.min(this.window.rebufferDeviceLeadLowWaterMs, deviceLeadMs);
  }

  noteRebufferSafetyWrite(deviceLeadMs: number): void {
    if (!this.enabled) {
      return;
    }
    this.window.rebufferSafetyWrites += 1;
    this.window.rebufferDeviceLeadLowWaterMs = this.window.rebufferDeviceLeadLowWaterMs === null
      ? deviceLeadMs
      : Math.min(this.window.rebufferDeviceLeadLowWaterMs, deviceLeadMs);
  }

  noteDrop(reason: 'backpressure' | 'output-unavailable' | 'stale' | 'jitter-trim'): void {
    if (reason === 'output-unavailable') {
      this.window.droppedOutputUnavailable += 1;
    } else if (reason === 'stale') {
      this.window.droppedStale += 1;
    } else if (reason === 'backpressure') {
      this.window.droppedBackpressure += 1;
    } else if (reason === 'jitter-trim') {
      this.window.droppedJitterTrim += 1;
    }
  }

  maybeLog(reason: string, state: VoiceTxOutputDiagnosticsState, force = false): void {
    if (!this.enabled) {
      return;
    }
    const now = Date.now();
    if (!force && (now - this.lastLogAt) < this.intervalMs) {
      return;
    }
    const window = this.window;
    const elapsedMs = Math.max(1, now - window.startedAt);
    const avg = (sum: number, count: number): number | null => count > 0 ? sum / count : null;
    const chunkMs = state.sink.outputSampleRate > 0
      ? (state.sink.outputBufferSize / state.sink.outputSampleRate) * 1000
      : 0;

    this.logger.info('Voice TX output diagnostics', {
      reason,
      elapsedMs,
      sink: {
        available: state.sink.available,
        kind: state.sink.kind,
        outputSampleRate: state.sink.outputSampleRate,
        outputBufferSize: state.sink.outputBufferSize,
        chunkMs,
      },
      buffer: {
        queueMs: state.queueMs,
        deviceLeadMs: state.deviceLeadMs,
        totalBufferedMs: state.queueMs + state.deviceLeadMs,
        targetMs: state.adaptiveTargetMs,
        desiredDeviceLeadMs: state.desiredDeviceLeadMs,
        queueMsMax: window.queueMsMax,
        deviceLeadMsMax: window.deviceLeadMsMax,
        deviceLeadMsMin: window.deviceLeadMsMin,
        totalBufferedMsMin: window.totalBufferedMsMin,
        totalBufferedMsMax: window.totalBufferedMsMax,
        playoutStarted: state.playoutStarted,
        rebuffering: state.rebuffering,
        rebufferDurationMs: state.rebufferDurationMs,
        rebufferEnterWaterMs: state.rebufferEnterWaterMs,
        rebufferResumeWaterMs: state.rebufferResumeWaterMs,
        rebufferReason: state.rebufferReason ?? (state.rebuffering ? reason : null),
        rebufferHoldTicks: window.rebufferHoldTicks,
        rebufferSuppressedWrites: window.rebufferSuppressedWrites,
        rebufferSafetyWrites: window.rebufferSafetyWrites,
        rebufferDeviceLeadLowWaterMs: window.rebufferDeviceLeadLowWaterMs,
      },
      ingress: {
        frames: window.ingressFrames,
        opusPlcFrames: window.ingressOpusPlcFrames,
        avgIntervalMs: avg(window.ingressIntervalSumMs, Math.max(0, window.ingressFrames - 1)),
        maxIntervalMs: window.ingressIntervalMaxMs,
        avgClientToServerMs: avg(window.clientToServerSumMs, window.clientToServerSamples),
        maxClientToServerMs: window.clientToServerMaxMs,
        avgResampleMs: avg(window.resampleSumMs, window.ingressFrames),
        maxResampleMs: window.resampleMaxMs,
        sequenceGaps: window.sequenceGaps,
      },
      output: {
        ticks: window.ticks,
        maxTickGapMs: window.maxTickGapMs,
        writes: window.writes,
        maxWritesPerTick: window.maxWritesPerTick,
        catchupLimitHits: window.catchupLimitHits,
        avgWriteMs: avg(window.writeSumMs, window.writes),
        maxWriteMs: window.writeMaxMs,
        avgWriteIntervalMs: avg(window.writeIntervalSumMs, window.writeIntervalSamples),
        maxWriteIntervalMs: window.writeIntervalMaxMs,
        writeFailures: window.writeFailures,
        underruns: window.underruns,
        plcChunks: window.plcChunks,
        paddedChunks: window.paddedChunks,
        partialChunks: window.partialChunks,
        trimEvents: window.trimEvents,
        trimDroppedMs: state.sink.outputSampleRate > 0
          ? (window.trimDroppedSamples / state.sink.outputSampleRate) * 1000
          : 0,
        boundaryJumpMax: window.boundaryJumpMax,
        avgChunkRms: avg(window.chunkRmsSum, window.writes),
        chunkPeakMax: window.chunkPeakMax,
        zeroChunks: window.zeroChunks,
      },
      drops: {
        outputUnavailable: window.droppedOutputUnavailable,
        stale: window.droppedStale,
        backpressure: window.droppedBackpressure,
        jitterTrim: window.droppedJitterTrim,
      },
      jitter: state.jitterSnapshot ? {
        source: state.jitterSource,
        targetMs: state.jitterSnapshot.activeTargetMs,
        recommendedMs: state.jitterSnapshot.recommendedTargetMs,
        p95Ms: state.jitterSnapshot.relativeDelayP95Ms,
        jitterEwmaMs: state.jitterSnapshot.jitterEwmaMs,
        sampleCount: state.jitterSnapshot.sampleCount,
      } : null,
      policy: {
        profile: state.policy.profile,
        targetMs: state.policy.targetMs,
        minMs: state.policy.minMs,
        maxMs: state.policy.maxMs,
      },
      totals: {
        underrunCount: state.underrunCount,
        plcFrames: state.plcFrames,
        queueDepthFrames: state.queueDepthFrames,
      },
    });
    this.lastLogAt = now;
    this.window = this.createWindow(now);
  }

  private createWindow(now = Date.now()): VoiceTxOutputDiagnosticsWindow {
    return {
      startedAt: now,
      ticks: 0,
      maxTickGapMs: 0,
      ingressFrames: 0,
      ingressOpusPlcFrames: 0,
      ingressIntervalSumMs: 0,
      ingressIntervalMaxMs: 0,
      clientToServerSumMs: 0,
      clientToServerSamples: 0,
      clientToServerMaxMs: 0,
      resampleSumMs: 0,
      resampleMaxMs: 0,
      sequenceGaps: 0,
      writes: 0,
      maxWritesPerTick: 0,
      catchupLimitHits: 0,
      writeSumMs: 0,
      writeMaxMs: 0,
      writeIntervalSumMs: 0,
      writeIntervalSamples: 0,
      writeIntervalMaxMs: 0,
      writeFailures: 0,
      underruns: 0,
      plcChunks: 0,
      paddedChunks: 0,
      partialChunks: 0,
      trimEvents: 0,
      trimDroppedSamples: 0,
      droppedOutputUnavailable: 0,
      droppedStale: 0,
      droppedBackpressure: 0,
      droppedJitterTrim: 0,
      boundaryJumpMax: 0,
      chunkRmsSum: 0,
      chunkPeakMax: 0,
      zeroChunks: 0,
      queueMsMax: 0,
      deviceLeadMsMax: 0,
      deviceLeadMsMin: null,
      totalBufferedMsMin: null,
      totalBufferedMsMax: 0,
      rebufferHoldTicks: 0,
      rebufferSuppressedWrites: 0,
      rebufferSafetyWrites: 0,
      rebufferDeviceLeadLowWaterMs: null,
    };
  }
}
