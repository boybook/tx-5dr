import { performance } from 'node:perf_hooks';
import type { ResolvedVoiceTxBufferPolicy } from '@tx5dr/contracts';
import { StreamingLinearResampler } from '../realtime/StreamingAudioResampler.js';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';
import { createLogger } from '../utils/logger.js';
import type { VoiceTxOutputObserver } from './AudioStreamManager.js';
import { VoiceTxJitterController } from './VoiceTxJitterController.js';
import { VoiceTxOutputDeviceLead } from './VoiceTxOutputDeviceLead.js';
import { VoiceTxOutputDiagnostics } from './VoiceTxOutputDiagnostics.js';
import { VoiceTxOutputPlc } from './VoiceTxOutputPlc.js';
import { VoiceTxOutputQueue, type ConsumedVoiceChunk } from './VoiceTxOutputQueue.js';
import type { VoiceTxOutputSinkState } from './VoiceTxOutputTypes.js';

const logger = createLogger('VoiceTxOutputPipeline');
const DEBUG_REALTIME_JITTER = process.env.TX5DR_DEBUG_REALTIME_JITTER === '1';
const DEBUG_VOICE_TX_OUTPUT = process.env.TX5DR_DEBUG_VOICE_TX === '1' || DEBUG_REALTIME_JITTER;
const MAX_PLC_CHUNKS = 1;
const RTAUDIO_DEVICE_LEAD_MIN_MS = 100;
const RTAUDIO_DEVICE_LEAD_MAX_MS = 160;
const OUTPUT_CATCHUP_MAX_WRITES_PER_TICK = 10;
const OUTPUT_IDLE_POLL_MS = 5;
const TX_OUTPUT_DIAGNOSTIC_INTERVAL_MS = 1000;
const REBUFFER_RESUME_MARGIN_MS = 5;
const REBUFFER_ENTER_RATIO = 0.6;
const REBUFFER_ENTER_MIN_MS = 80;
const REBUFFER_ENTER_TARGET_GAP_MS = 80;
const REBUFFER_RESUME_TARGET_GAP_MS = 40;
const REBUFFER_RESUME_MIN_GAP_MS = 60;
const STALE_TARGET_MARGIN_MS = 200;

export type { VoiceTxOutputSinkState } from './VoiceTxOutputTypes.js';

export interface VoiceTxOutputPipelineDeps {
  getSinkState: () => VoiceTxOutputSinkState;
  getObserver: () => VoiceTxOutputObserver | null;
  getVolumeGain: () => number;
  writeOutputChunk: (samples: Float32Array, sink: VoiceTxOutputSinkState) => Promise<boolean> | boolean;
}

export class VoiceTxOutputPipeline {
  private readonly outputQueue = new VoiceTxOutputQueue();
  private resampler: StreamingLinearResampler | null = null;
  private resamplerInputRate = 0;
  private resamplerOutputRate = 0;
  private outputTimer: NodeJS.Timeout | null = null;
  private outputLoopActive = false;
  private outputEnabled = true;
  private playoutStarted = false;
  private rebuffering = false;
  private lastOutputWriteAt: number | null = null;
  private rebufferStartedAtMs: number | null = null;
  private readonly jitter = new VoiceTxJitterController({
    logger,
    debug: DEBUG_VOICE_TX_OUTPUT,
    debugRealtimeJitter: DEBUG_REALTIME_JITTER,
  });
  private readonly outputDeviceLead = new VoiceTxOutputDeviceLead();
  private readonly plc = new VoiceTxOutputPlc();
  private consecutivePlcChunks = 0;
  private underrunCount = 0;
  private plcFrames = 0;
  private lastSequence: number | null = null;
  private readonly diagnostics = new VoiceTxOutputDiagnostics(logger, DEBUG_VOICE_TX_OUTPUT, TX_OUTPUT_DIAGNOSTIC_INTERVAL_MS);
  private generation = 0;
  private lastStaleDropLogAt = 0;
  private suppressedStaleDropLogs = 0;

  constructor(private readonly deps: VoiceTxOutputPipelineDeps) {}

  recordTimingProbe(data: {
    participantIdentity: string;
    transport: VoiceTxFrameMeta['transport'];
    codec?: VoiceTxFrameMeta['codec'];
    sequence: number;
    sentAtMs: number;
    receivedAtMs: number;
    intervalMs: number;
    voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
  }): void {
    this.jitter.recordProbeSeed(data);
  }

  ingest(pcmData: Float32Array, frameSampleRate: number, meta: VoiceTxFrameMeta): void {
    const sink = this.deps.getSinkState();
    if (!sink.available || sink.outputSampleRate <= 0 || sink.outputBufferSize <= 0) {
      this.dropFrame(meta, 'output-unavailable');
      return;
    }

    const now = Date.now();
    const policyApply = this.jitter.applyMediaPolicy(meta.voiceTxBufferPolicy, now, meta);
    const policy = this.jitter.policy;
    if (policyApply.changed) {
      this.outputQueue.clear();
      this.outputDeviceLead.reset();
      this.plc.reset();
      this.playoutStarted = false;
      this.rebuffering = false;
      this.rebufferStartedAtMs = null;
      this.consecutivePlcChunks = 0;
      this.lastSequence = null;
      this.lastOutputWriteAt = null;
    }
    const staleAgeMs = typeof meta.clientSentAtMs === 'number'
      ? now - meta.clientSentAtMs
      : null;
    const effectiveStaleFrameMs = this.getEffectiveStaleFrameMs(policy);
    if (typeof staleAgeMs === 'number' && staleAgeMs > effectiveStaleFrameMs) {
      this.logStaleDrop(meta, sink, staleAgeMs, effectiveStaleFrameMs);
      this.dropFrame(meta, 'stale');
      return;
    }

    if (this.hasSequenceGap(meta.sequence)) {
      this.noteUnderrun(now);
    }
    if (meta.concealment === 'opus-plc') {
      this.noteUnderrun(now);
      this.plcFrames += 1;
    } else {
      this.jitter.notePacket(meta, now);
      this.maybeEnterRebufferProtection();
    }

    const resampleStart = performance.now();
    const playbackFrame = this.resample(pcmData, frameSampleRate, sink.outputSampleRate);
    const resampleMs = performance.now() - resampleStart;
    if (playbackFrame.length === 0) {
      return;
    }
    this.diagnostics.noteIngress(meta, now, resampleMs);

    this.outputQueue.enqueue(playbackFrame, meta, now, resampleMs);
    this.deps.getObserver()?.onFrameEnqueued?.({
      meta,
      queueDepthFrames: this.outputQueue.length,
      queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
    });

    this.trimQueue(sink, meta, policy);
    this.recordBufferDiagnostics(sink);
    this.maybeLogDiagnostics('ingest');
    if (this.outputEnabled) {
      this.ensureOutputLoop();
    }
  }

  setOutputEnabled(enabled: boolean): void {
    this.outputEnabled = enabled;
    if (enabled && this.outputQueue.length > 0) {
      this.ensureOutputLoop();
    }
  }

  clear(): void {
    this.generation += 1;
    if (this.outputTimer) {
      clearTimeout(this.outputTimer);
      this.outputTimer = null;
    }
    this.outputQueue.clear();
    this.outputLoopActive = false;
    this.playoutStarted = false;
    this.rebuffering = false;
    this.resampler?.reset();
    this.resampler = null;
    this.resamplerInputRate = 0;
    this.resamplerOutputRate = 0;
    this.jitter.clear();
    this.lastOutputWriteAt = null;
    this.rebufferStartedAtMs = null;
    this.outputDeviceLead.reset();
    this.plc.reset();
    this.consecutivePlcChunks = 0;
    this.underrunCount = 0;
    this.plcFrames = 0;
    this.lastSequence = null;
    this.diagnostics.reset();
    this.lastStaleDropLogAt = 0;
    this.suppressedStaleDropLogs = 0;
  }

  getQueuedMs(outputSampleRate = this.deps.getSinkState().outputSampleRate): number {
    if (!outputSampleRate || outputSampleRate <= 0) {
      return 0;
    }
    return this.outputQueue.getQueuedMs(outputSampleRate);
  }

  getQueueDepthFrames(): number {
    return this.outputQueue.length;
  }

  getCurrentJitterTargetMs(): number {
    return this.jitter.targetMs;
  }

  getOutputBufferState(): {
    queueMs: number;
    deviceLeadMs: number;
    totalBufferedMs: number;
    targetMs: number;
    rebufferEnterWaterMs: number;
    rebufferResumeWaterMs: number;
    rebuffering: boolean;
    playoutStarted: boolean;
  } {
    const sink = this.deps.getSinkState();
    const queueMs = this.getQueuedMs(sink.outputSampleRate);
    const deviceLeadMs = this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
    return {
      queueMs,
      deviceLeadMs,
      totalBufferedMs: queueMs + deviceLeadMs,
      targetMs: this.jitter.targetMs,
      rebufferEnterWaterMs: this.getRebufferEnterWaterMs(),
      rebufferResumeWaterMs: this.getRebufferResumeWaterMs(),
      rebuffering: this.rebuffering,
      playoutStarted: this.playoutStarted,
    };
  }

  private ensureOutputLoop(): void {
    if (this.outputTimer || this.outputLoopActive) {
      return;
    }
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    this.outputTimer = setTimeout(() => {
      this.outputTimer = null;
      void this.outputTick();
    }, Math.max(1, delayMs));
  }

  private async outputTick(): Promise<void> {
    if (this.outputLoopActive) {
      return;
    }
    this.outputLoopActive = true;
    const generation = this.generation;

    try {
      const sink = this.deps.getSinkState();
      this.diagnostics.noteTick();
      if (!this.outputEnabled) {
        return;
      }
      if (!sink.available || sink.outputSampleRate <= 0 || sink.outputBufferSize <= 0) {
        this.clear();
        return;
      }

      this.maybeReduceTarget(Date.now());
      const queueMs = this.getQueuedMs(sink.outputSampleRate);
      const chunkMs = (sink.outputBufferSize / sink.outputSampleRate) * 1000;
      const deviceLeadMs = this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
      const totalBufferedMs = queueMs + deviceLeadMs;
      const desiredDeviceLeadMs = this.getDesiredOutputDeviceLeadMs(sink, chunkMs);
      this.recordBufferDiagnostics(sink);
      if (!this.playoutStarted && totalBufferedMs < this.jitter.targetMs && this.outputQueue.length > 0) {
        this.maybeLogDiagnostics('pre-roll');
        this.scheduleNextTick(OUTPUT_IDLE_POLL_MS);
        return;
      }

      if (this.shouldHoldForRebuffer(sink, totalBufferedMs, desiredDeviceLeadMs)) {
        this.maybeLogDiagnostics(this.rebuffering ? 'rebuffer' : 'rebuffer-wait');
        this.scheduleNextTick(OUTPUT_IDLE_POLL_MS);
        return;
      }

      if (this.outputQueue.length === 0 && deviceLeadMs > chunkMs) {
        this.maybeLogDiagnostics('device-lead-wait');
        this.scheduleNextTick(Math.min(OUTPUT_IDLE_POLL_MS, Math.max(1, deviceLeadMs - chunkMs)));
        return;
      }

      if (this.outputQueue.length === 0 && this.consecutivePlcChunks >= MAX_PLC_CHUNKS) {
        this.playoutStarted = false;
        return;
      }

      if (this.outputQueue.length > 0) {
        this.playoutStarted = true;
      }

      let writes = 0;
      while (
        writes < OUTPUT_CATCHUP_MAX_WRITES_PER_TICK
        && generation === this.generation
        && this.outputEnabled
        && (
          this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate) < desiredDeviceLeadMs
          || (this.outputQueue.length === 0 && this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate) <= chunkMs * 0.5)
        )
      ) {
        if (this.outputQueue.length === 0 && this.consecutivePlcChunks >= MAX_PLC_CHUNKS) {
          break;
        }
        if (this.rebuffering && this.outputQueue.length === 0) {
          break;
        }
        const currentDeviceLeadMs = this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
        if (this.rebuffering && this.outputQueue.samples < sink.outputBufferSize) {
          break;
        }
        if (
          this.outputQueue.length > 0
          && this.outputQueue.samples < sink.outputBufferSize
          && currentDeviceLeadMs > chunkMs * 0.75
        ) {
          break;
        }
        const wrote = await this.writeNextOutputChunk(sink, chunkMs, generation);
        if (!wrote) {
          break;
        }
        if (this.rebuffering) {
          this.diagnostics.noteRebufferSafetyWrite(currentDeviceLeadMs);
        }
        writes += 1;
      }
      this.diagnostics.noteWritesPerTick(writes, writes >= OUTPUT_CATCHUP_MAX_WRITES_PER_TICK);

      if (generation !== this.generation) {
        return;
      }

      const nextDeviceLeadMs = this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
      if (this.rebuffering) {
        const nextTotalBufferedMs = this.getQueuedMs(sink.outputSampleRate) + nextDeviceLeadMs;
        if (nextTotalBufferedMs + REBUFFER_RESUME_MARGIN_MS >= this.getRebufferResumeWaterMs()) {
          this.rebuffering = false;
          this.rebufferStartedAtMs = null;
        }
      }
      if (this.outputQueue.length > 0 || this.consecutivePlcChunks < MAX_PLC_CHUNKS || nextDeviceLeadMs > chunkMs) {
        const leadHeadroomMs = Math.max(1, nextDeviceLeadMs - desiredDeviceLeadMs + chunkMs);
        this.scheduleNextTick(Math.min(OUTPUT_IDLE_POLL_MS, leadHeadroomMs));
      }
      this.maybeLogDiagnostics('tick');
    } finally {
      this.outputLoopActive = false;
    }
  }

  private async writeNextOutputChunk(
    sink: VoiceTxOutputSinkState,
    chunkMs: number,
    generation: number,
  ): Promise<boolean> {
    const consumed = this.outputQueue.length > 0
      ? this.consumeChunk(sink.outputBufferSize, sink.outputSampleRate)
      : this.createPlcChunk(sink.outputBufferSize, sink.outputSampleRate);
    if (consumed.samples.length < sink.outputBufferSize) {
      this.diagnostics.notePartialChunk();
      this.noteUnderrun(Date.now());
      consumed.samples = this.padChunk(consumed.samples, sink.outputBufferSize, sink.outputSampleRate);
    }

    const processed = this.applyGain(consumed.samples);
    const writeStart = performance.now();
    const writeOk = await this.deps.writeOutputChunk(processed, sink);
    const writeMs = performance.now() - writeStart;
    if (generation !== this.generation) {
      return false;
    }
    const writeAt = Date.now();
    const outputWriteIntervalMs = this.lastOutputWriteAt === null
      ? null
      : Math.max(0, writeAt - this.lastOutputWriteAt);
    this.lastOutputWriteAt = writeAt;

    if (!writeOk) {
      this.deps.getObserver()?.onWriteFailure?.({
        meta: consumed.meta ?? this.fallbackMeta(),
        queueDepthFrames: this.outputQueue.length,
        queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
      });
      this.diagnostics.noteWriteFailure();
      this.maybeLogDiagnostics('write-failure', true);
      return false;
    }

    this.noteOutputDeviceWrite(processed.length, sink.outputSampleRate, writeStart);
    this.diagnostics.noteOutput(processed, writeMs, outputWriteIntervalMs);
    if (consumed.meta) {
      const outputBufferedMs = this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
      const queueWaitMs = consumed.enqueuedAt === null ? 0 : Math.max(0, writeAt - consumed.enqueuedAt);
      const serverPipelineMs = Math.max(0, writeAt - consumed.meta.serverReceivedAtMs);
      const endToEndMs = typeof consumed.meta.clientSentAtMs === 'number'
        ? Math.max(0, writeAt - consumed.meta.clientSentAtMs)
        : null;
      this.deps.getObserver()?.onFrameProcessed?.({
        meta: consumed.meta,
        queueDepthFrames: this.outputQueue.length,
        queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
        resampleMs: consumed.resampleMs,
        queueWaitMs,
        writeMs,
        serverPipelineMs,
        endToEndMs,
        outputBufferedMs,
        outputSampleRate: sink.outputSampleRate,
        outputBufferSize: sink.outputBufferSize,
        outputWriteIntervalMs,
        jitterTargetMs: this.jitter.targetMs,
        underrunCount: this.underrunCount,
        plcFrames: this.plcFrames,
      });
    }
    return true;
  }

  private getEstimatedOutputDeviceLeadMs(outputSampleRate: number, now = performance.now()): number {
    return this.outputDeviceLead.get(outputSampleRate, now);
  }

  private noteOutputDeviceWrite(sampleCount: number, outputSampleRate: number, now = performance.now()): void {
    this.outputDeviceLead.noteWrite(sampleCount, outputSampleRate, now);
  }

  private getDesiredOutputDeviceLeadMs(sink: VoiceTxOutputSinkState, chunkMs: number): number {
    if (sink.kind !== 'rtaudio') {
      return chunkMs;
    }
    return Math.min(
      RTAUDIO_DEVICE_LEAD_MAX_MS,
      Math.max(chunkMs * 3, RTAUDIO_DEVICE_LEAD_MIN_MS, this.jitter.targetMs * 0.55),
    );
  }

  private shouldHoldForRebuffer(
    sink: VoiceTxOutputSinkState,
    totalBufferedMs: number,
    desiredDeviceLeadMs: number,
  ): boolean {
    if (!this.playoutStarted) {
      return false;
    }

    const queueMs = this.getQueuedMs(sink.outputSampleRate);
    const deviceLeadMs = this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
    if (this.rebuffering) {
      if (totalBufferedMs + REBUFFER_RESUME_MARGIN_MS >= this.getRebufferResumeWaterMs()) {
        this.rebuffering = false;
        this.rebufferStartedAtMs = null;
        return false;
      }
      if (queueMs <= 0 && deviceLeadMs <= 0.5) {
        this.rebuffering = false;
        this.rebufferStartedAtMs = null;
        // Let the normal underrun path emit at most one short tail PLC chunk
        // before stopping. Rebuffering should not generate repeated padding.
        return false;
      }
      if (this.shouldProtectDeviceLeadDuringRebuffer(sink, deviceLeadMs, desiredDeviceLeadMs)) {
        return false;
      }
      this.diagnostics.noteRebufferHold(this.outputQueue.samples >= sink.outputBufferSize, deviceLeadMs);
      return true;
    }

    const enterWaterMs = this.getRebufferEnterWaterMs();
    if (totalBufferedMs < enterWaterMs) {
      this.enterRebuffering();
      if (this.shouldProtectDeviceLeadDuringRebuffer(sink, deviceLeadMs, desiredDeviceLeadMs)) {
        return false;
      }
      this.diagnostics.noteRebufferHold(this.outputQueue.samples >= sink.outputBufferSize, deviceLeadMs);
      return true;
    }
    return false;
  }

  private maybeEnterRebufferProtection(): void {
    if (!this.playoutStarted || this.rebuffering) {
      return;
    }
    const sink = this.deps.getSinkState();
    if (!sink.available || sink.outputSampleRate <= 0 || sink.outputBufferSize <= 0) {
      return;
    }
    const totalBufferedMs = this.getQueuedMs(sink.outputSampleRate)
      + this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate);
    if (totalBufferedMs < this.getRebufferEnterWaterMs()) {
      this.enterRebuffering();
      this.maybeLogDiagnostics('rebuffer-target-increase', true);
    }
  }

  private getRebufferEnterWaterMs(): number {
    const targetMs = this.jitter.targetMs;
    const upperBoundMs = Math.max(REBUFFER_ENTER_MIN_MS, targetMs - REBUFFER_ENTER_TARGET_GAP_MS);
    return Math.max(
      REBUFFER_ENTER_MIN_MS,
      Math.min(upperBoundMs, Math.round(targetMs * REBUFFER_ENTER_RATIO)),
    );
  }

  private getRebufferResumeWaterMs(): number {
    const targetMs = this.jitter.targetMs;
    const enterWaterMs = this.getRebufferEnterWaterMs();
    return Math.min(
      targetMs,
      Math.max(enterWaterMs + REBUFFER_RESUME_MIN_GAP_MS, targetMs - REBUFFER_RESUME_TARGET_GAP_MS),
    );
  }

  private getEffectiveStaleFrameMs(policy = this.jitter.policy): number {
    return Math.max(policy.staleFrameMs, this.jitter.targetMs + policy.headroomMs + STALE_TARGET_MARGIN_MS);
  }

  private shouldProtectDeviceLeadDuringRebuffer(
    sink: VoiceTxOutputSinkState,
    deviceLeadMs: number,
    desiredDeviceLeadMs: number,
  ): boolean {
    return sink.kind === 'rtaudio'
      && this.outputQueue.length > 0
      && this.outputQueue.samples >= sink.outputBufferSize
      && deviceLeadMs < desiredDeviceLeadMs;
  }

  private enterRebuffering(): void {
    if (!this.rebuffering) {
      this.rebufferStartedAtMs = Date.now();
    }
    this.rebuffering = true;
  }

  private consumeChunk(sampleCount: number, outputSampleRate: number): ConsumedVoiceChunk {
    const consumed = this.outputQueue.consume(sampleCount);
    if (consumed.samples.length > 0) {
      this.plc.applyRestoreCrossfade(consumed.samples, consumed.samples.length, outputSampleRate);
      this.plc.recordRealOutput(consumed.samples, outputSampleRate);
      this.consecutivePlcChunks = 0;
    }
    return consumed;
  }

  private createPlcChunk(sampleCount: number, outputSampleRate: number): ConsumedVoiceChunk {
    this.noteUnderrun(Date.now());
    this.consecutivePlcChunks += 1;
    this.diagnostics.notePlcChunk();
    const out = this.createTailPlcSamples(sampleCount, outputSampleRate);
    return {
      samples: out,
      meta: null,
      enqueuedAt: null,
      resampleMs: 0,
    };
  }

  private padChunk(samples: Float32Array, sampleCount: number, outputSampleRate: number): Float32Array {
    const out = new Float32Array(sampleCount);
    const realSamples = Math.min(samples.length, sampleCount);
    out.set(samples.subarray(0, realSamples));
    if (realSamples > 0) {
      this.plc.applyRestoreCrossfade(out, realSamples, outputSampleRate);
      this.plc.recordRealOutput(out.subarray(0, realSamples), outputSampleRate);
    }
    this.consecutivePlcChunks += 1;
    this.diagnostics.notePaddedChunk();
    out.set(this.createTailPlcSamples(sampleCount - realSamples, outputSampleRate), realSamples);
    return out;
  }

  private createTailPlcSamples(sampleCount: number, outputSampleRate: number): Float32Array {
    const result = this.plc.createTailSamples(sampleCount, outputSampleRate);
    if (result.generated) {
      this.plcFrames += 1;
    }
    return result.samples;
  }

  private trimQueue(
    sink: VoiceTxOutputSinkState,
    meta: VoiceTxFrameMeta,
    policy = this.jitter.policy,
  ): void {
    const events = this.outputQueue.trimTo(this.jitter.targetMs, policy.headroomMs, sink.outputSampleRate);
    for (const event of events) {
      this.diagnostics.noteTrim(event.droppedSamples);
      this.deps.getObserver()?.onFrameDropped?.({
        meta: event.meta ?? meta,
        queueDepthFrames: this.outputQueue.length,
        queuedAudioMs: this.getQueuedMs(sink.outputSampleRate),
        reason: 'jitter-trim',
      });
    }
  }

  private resample(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) {
      return new Float32Array(samples);
    }
    if (
      !this.resampler
      || this.resamplerInputRate !== inputRate
      || this.resamplerOutputRate !== outputRate
    ) {
      this.resampler = new StreamingLinearResampler(inputRate, outputRate);
      this.resamplerInputRate = inputRate;
      this.resamplerOutputRate = outputRate;
    }
    return this.resampler.process(samples);
  }

  private applyGain(samples: Float32Array): Float32Array {
    const gain = this.deps.getVolumeGain();
    const out = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]! * gain;
      out[index] = sample > 1 ? 1 : (sample < -1 ? -1 : sample);
    }
    return out;
  }

  private dropFrame(meta: VoiceTxFrameMeta, reason: 'backpressure' | 'output-unavailable' | 'stale' | 'jitter-trim'): void {
    this.diagnostics.noteDrop(reason);
    this.maybeLogDiagnostics(`drop-${reason}`, reason !== 'stale');
    this.deps.getObserver()?.onFrameDropped?.({
      meta,
      queueDepthFrames: this.outputQueue.length,
      queuedAudioMs: this.getQueuedMs(),
      reason,
    });
  }

  private logStaleDrop(
    meta: VoiceTxFrameMeta,
    sink: VoiceTxOutputSinkState,
    staleAgeMs: number,
    effectiveStaleFrameMs: number,
  ): void {
    if (!DEBUG_VOICE_TX_OUTPUT) {
      return;
    }
    const now = Date.now();
    if ((now - this.lastStaleDropLogAt) < TX_OUTPUT_DIAGNOSTIC_INTERVAL_MS) {
      this.suppressedStaleDropLogs += 1;
      return;
    }
    const suppressedSinceLastLog = this.suppressedStaleDropLogs;
    this.suppressedStaleDropLogs = 0;
    this.lastStaleDropLogAt = now;
    logger.warn('Voice TX output dropping stale frame', {
      staleAgeMs,
      effectiveStaleFrameMs,
      policyStaleFrameMs: this.jitter.policy.staleFrameMs,
      targetMs: this.jitter.targetMs,
      queueMs: this.getQueuedMs(sink.outputSampleRate),
      deviceLeadMs: this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate),
      suppressedSinceLastLog,
      participantIdentity: meta.participantIdentity,
      sequence: meta.sequence,
      transport: meta.transport,
      codec: meta.codec,
    });
  }

  private hasSequenceGap(sequence?: number | null): boolean {
    if (typeof sequence !== 'number') {
      return false;
    }
    const hasGap = this.lastSequence !== null && sequence > this.lastSequence + 1;
    if (hasGap) {
      this.diagnostics.noteSequenceGap(sequence - this.lastSequence! - 1);
    }
    this.lastSequence = sequence;
    return hasGap;
  }

  private noteUnderrun(now: number): void {
    this.underrunCount += 1;
    this.diagnostics.noteUnderrun();
    if (this.jitter.noteUnderrun(now)) {
      this.maybeEnterRebufferProtection();
    }
  }

  private maybeReduceTarget(now: number): void {
    if (this.jitter.maybeUpdate(now)) {
      this.maybeEnterRebufferProtection();
    }
  }

  private recordBufferDiagnostics(sink: VoiceTxOutputSinkState): void {
    this.diagnostics.noteBuffer(
      this.getQueuedMs(sink.outputSampleRate),
      this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate),
    );
  }

  private maybeLogDiagnostics(reason: string, force = false): void {
    const sink = this.deps.getSinkState();
    const chunkMs = sink.outputSampleRate > 0 ? (sink.outputBufferSize / sink.outputSampleRate) * 1000 : 0;
    this.diagnostics.maybeLog(reason, {
      sink,
      queueMs: this.getQueuedMs(sink.outputSampleRate),
      deviceLeadMs: this.getEstimatedOutputDeviceLeadMs(sink.outputSampleRate),
      desiredDeviceLeadMs: this.getDesiredOutputDeviceLeadMs(sink, chunkMs),
      adaptiveTargetMs: this.jitter.targetMs,
      playoutStarted: this.playoutStarted,
      rebuffering: this.rebuffering,
      rebufferDurationMs: this.rebufferStartedAtMs === null ? 0 : Math.max(0, Date.now() - this.rebufferStartedAtMs),
      rebufferEnterWaterMs: this.getRebufferEnterWaterMs(),
      rebufferResumeWaterMs: this.getRebufferResumeWaterMs(),
      rebufferReason: reason,
      jitterSnapshot: this.jitter.snapshot,
      jitterSource: this.jitter.source,
      policy: this.jitter.policy,
      underrunCount: this.underrunCount,
      plcFrames: this.plcFrames,
      queueDepthFrames: this.outputQueue.length,
    }, force);
  }

  private fallbackMeta(): VoiceTxFrameMeta {
    const now = Date.now();
    return {
      transport: 'ws-compat',
      participantIdentity: 'unknown',
      sequence: null,
      clientSentAtMs: null,
      serverReceivedAtMs: now,
      sampleRate: 0,
      samplesPerChannel: 0,
      voiceTxBufferPolicy: this.jitter.policy,
    };
  }
}
