import { performance } from 'node:perf_hooks';

const FRAME_MS = 20;
const MAX_BACKLOG_MS = 160;
const RECOVERY_BACKLOG_MS = 80;

export interface DeterministicTxMonitorStats {
  emittedFrames: number;
  droppedFrames: number;
  observerFailures: number;
  maxQueuedAudioMs: number;
}

/** Paces a best-effort TX monitor without putting transport work on the output callback. */
export class DeterministicTxMonitorTap {
  private readonly frameSamples: number;
  private readonly maxSamples: number;
  private readonly recoverySamples: number;
  private readonly queue: Float32Array[] = [];
  private queueOffset = 0;
  private queuedSamples = 0;
  private preparedWaveform: Float32Array | null = null;
  private preparedAvailableSamples = 0;
  private preparedCursor = 0;
  private startedAt: number | null = null;
  private lastOfferAt: number | null = null;
  private nextDueAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly stats: DeterministicTxMonitorStats = { emittedFrames: 0, droppedFrames: 0, observerFailures: 0, maxQueuedAudioMs: 0 };

  constructor(
    private readonly sampleRate: number,
    private readonly emitFrame: (samples: Float32Array, sampleRate: number) => void,
    private readonly onStopped: (stats: DeterministicTxMonitorStats) => void,
    reservedLeadMs = 0,
  ) {
    this.frameSamples = Math.max(1, Math.round(sampleRate * FRAME_MS / 1000));
    this.maxSamples = Math.round(sampleRate * (MAX_BACKLOG_MS + reservedLeadMs) / 1000);
    this.recoverySamples = Math.round(sampleRate * (RECOVERY_BACKLOG_MS + reservedLeadMs) / 1000);
  }

  offer(samples: Float32Array): void {
    if (this.stopped || samples.length === 0) return;
    const now = performance.now();
    if (this.lastOfferAt !== null && now - this.lastOfferAt > MAX_BACKLOG_MS) this.dropQueuedAudio();
    this.lastOfferAt = now;
    this.queue.push(samples);
    this.queuedSamples += samples.length;
    this.stats.maxQueuedAudioMs = Math.max(this.stats.maxQueuedAudioMs, this.queuedSamples * 1000 / this.sampleRate);
    if (this.queuedSamples > this.maxSamples) {
      const excess = this.queuedSamples - this.recoverySamples;
      const drop = Math.min(this.queuedSamples, Math.ceil(excess / this.frameSamples) * this.frameSamples);
      this.discardQueued(drop);
      this.stats.droppedFrames += Math.ceil(drop / this.frameSamples);
    }
    this.schedule();
  }

  /** CHRONO may acknowledge a burst; its watermark grants audio, not send cadence. */
  acceptPrepared(waveform: Float32Array, availableSamples: number): void {
    if (this.stopped) return;
    this.preparedWaveform = waveform;
    this.preparedAvailableSamples = Math.min(waveform.length, Math.max(this.preparedAvailableSamples, availableSamples));
    if (this.startedAt === null) this.startedAt = performance.now();
    this.schedule();
  }

  finish(): void {
    if (this.stopped) return;
    if (this.preparedWaveform) {
      const remaining = this.preparedAvailableSamples - this.preparedCursor;
      if (remaining > this.frameSamples) {
        const skipped = remaining - this.frameSamples;
        this.preparedCursor += skipped;
        this.stats.droppedFrames += Math.ceil(skipped / this.frameSamples);
      }
      if (this.preparedCursor < this.preparedAvailableSamples) {
        this.publish(this.preparedWaveform.slice(this.preparedCursor, this.preparedAvailableSamples));
      }
    } else {
      if (this.queuedSamples > this.frameSamples) {
        const skipped = this.queuedSamples - this.frameSamples;
        this.discardQueued(skipped);
        this.stats.droppedFrames += Math.ceil(skipped / this.frameSamples);
      }
      if (this.queuedSamples > 0) this.publish(this.takeQueuedFrame(true)!);
    }
    this.stop();
  }

  abort(): void {
    this.stop();
  }

  private schedule(): void {
    if (this.stopped || this.timer || !this.hasReadyAudio()) return;
    const now = performance.now();
    if (this.nextDueAt === 0 || now - this.nextDueAt > FRAME_MS) this.nextDueAt = now;
    this.timer = setTimeout(() => this.tick(), Math.max(0, this.nextDueAt - now));
  }

  private tick(): void {
    this.timer = null;
    if (this.stopped) return;
    const now = performance.now();
    const scheduledAt = this.nextDueAt;
    if (!this.preparedWaveform && this.lastOfferAt !== null && now - this.lastOfferAt > MAX_BACKLOG_MS) {
      this.dropQueuedAudio();
    }
    const frame = this.preparedWaveform ? this.takePreparedFrame(now) : this.takeQueuedFrame();
    if (frame) this.publish(frame);
    this.nextDueAt = now - scheduledAt > FRAME_MS
      ? now + FRAME_MS
      : Math.max(scheduledAt + FRAME_MS, now + FRAME_MS / 2);
    this.schedule();
  }

  private takeQueuedFrame(allowPartial = false): Float32Array | null {
    if (this.queuedSamples < this.frameSamples && !allowPartial) return null;
    if (this.queuedSamples === 0) return null;
    const count = Math.min(this.frameSamples, this.queuedSamples);
    const frame = new Float32Array(count);
    let offset = 0;
    while (offset < count) {
      const head = this.queue[0]!;
      const copied = Math.min(count - offset, head.length - this.queueOffset);
      frame.set(head.subarray(this.queueOffset, this.queueOffset + copied), offset);
      offset += copied;
      this.queueOffset += copied;
      this.queuedSamples -= copied;
      if (this.queueOffset === head.length) { this.queue.shift(); this.queueOffset = 0; }
    }
    return frame;
  }

  private takePreparedFrame(now: number): Float32Array | null {
    const waveform = this.preparedWaveform!;
    const dueSamples = Math.max(0, Math.floor((now - (this.startedAt ?? now)) * this.sampleRate / 1000));
    const latestFreshStart = Math.max(0, Math.min(dueSamples - this.maxSamples, this.preparedAvailableSamples - this.frameSamples));
    if (this.preparedCursor < latestFreshStart) {
      const skipped = Math.floor((latestFreshStart - this.preparedCursor) / this.frameSamples) * this.frameSamples;
      this.preparedCursor += skipped;
      this.stats.droppedFrames += skipped / this.frameSamples;
    }
    if (this.preparedCursor >= this.preparedAvailableSamples) return null;
    const end = Math.min(this.preparedCursor + this.frameSamples, this.preparedAvailableSamples);
    if (end - this.preparedCursor < this.frameSamples) return null;
    const frame = waveform.slice(this.preparedCursor, end);
    this.preparedCursor = end;
    return frame;
  }

  private hasReadyAudio(): boolean {
    if (this.preparedWaveform) {
      const available = this.preparedAvailableSamples - this.preparedCursor;
      return available >= this.frameSamples;
    }
    return this.queuedSamples >= this.frameSamples;
  }

  private discardQueued(samples: number): void {
    while (samples > 0 && this.queue.length > 0) {
      const head = this.queue[0]!;
      const discarded = Math.min(samples, head.length - this.queueOffset);
      this.queueOffset += discarded;
      this.queuedSamples -= discarded;
      samples -= discarded;
      if (this.queueOffset === head.length) { this.queue.shift(); this.queueOffset = 0; }
    }
  }

  private dropQueuedAudio(): void {
    this.stats.droppedFrames += Math.ceil(this.queuedSamples / this.frameSamples);
    this.queue.length = 0;
    this.queueOffset = 0;
    this.queuedSamples = 0;
  }

  private publish(frame: Float32Array): void {
    try { this.emitFrame(frame, this.sampleRate); }
    catch { this.stats.observerFailures += 1; }
    this.stats.emittedFrames += 1;
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queuedSamples = 0;
    this.preparedWaveform = null;
    this.onStopped({ ...this.stats });
  }
}
