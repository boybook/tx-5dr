import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';

export interface VoiceTxQueuedSegment {
  samples: Float32Array;
  meta: VoiceTxFrameMeta;
  enqueuedAt: number;
  resampleMs: number;
  offset: number;
}

export interface ConsumedVoiceChunk {
  samples: Float32Array;
  meta: VoiceTxFrameMeta | null;
  enqueuedAt: number | null;
  resampleMs: number;
}

export interface VoiceTxTrimEvent {
  meta: VoiceTxFrameMeta;
  droppedSamples: number;
}

export class VoiceTxOutputQueue {
  private readonly queue: VoiceTxQueuedSegment[] = [];
  private queuedSamples = 0;

  get length(): number {
    return this.queue.length;
  }

  get samples(): number {
    return this.queuedSamples;
  }

  clear(): void {
    this.queue.length = 0;
    this.queuedSamples = 0;
  }

  enqueue(samples: Float32Array, meta: VoiceTxFrameMeta, enqueuedAt: number, resampleMs: number): void {
    this.queue.push({
      samples,
      meta,
      enqueuedAt,
      resampleMs,
      offset: 0,
    });
    this.queuedSamples += samples.length;
  }

  getQueuedMs(outputSampleRate: number): number {
    if (!outputSampleRate || outputSampleRate <= 0) {
      return 0;
    }
    return (this.queuedSamples / outputSampleRate) * 1000;
  }

  consume(sampleCount: number): ConsumedVoiceChunk {
    const out = new Float32Array(sampleCount);
    let outOffset = 0;
    let firstMeta: VoiceTxFrameMeta | null = null;
    let firstEnqueuedAt: number | null = null;
    let resampleMs = 0;

    while (outOffset < sampleCount && this.queue.length > 0) {
      const segment = this.queue[0]!;
      if (!firstMeta) {
        firstMeta = segment.meta;
        firstEnqueuedAt = segment.enqueuedAt;
        resampleMs = segment.resampleMs;
      }

      const available = segment.samples.length - segment.offset;
      const take = Math.min(sampleCount - outOffset, available);
      out.set(segment.samples.subarray(segment.offset, segment.offset + take), outOffset);
      outOffset += take;
      segment.offset += take;
      this.queuedSamples = Math.max(0, this.queuedSamples - take);

      if (segment.offset >= segment.samples.length) {
        this.queue.shift();
      }
    }

    return {
      samples: outOffset === sampleCount ? out : out.subarray(0, outOffset),
      meta: firstMeta,
      enqueuedAt: firstEnqueuedAt,
      resampleMs,
    };
  }

  trimTo(targetMs: number, headroomMs: number, outputSampleRate: number): VoiceTxTrimEvent[] {
    const events: VoiceTxTrimEvent[] = [];
    if (outputSampleRate <= 0) {
      return events;
    }
    const maxQueueMs = targetMs + headroomMs;
    if (this.getQueuedMs(outputSampleRate) <= maxQueueMs) {
      return events;
    }

    const trimToSamples = Math.ceil((targetMs / 1000) * outputSampleRate);
    while (this.queue.length > 0 && this.queuedSamples > trimToSamples) {
      const segment = this.queue[0]!;
      const overSamples = this.queuedSamples - trimToSamples;
      const available = segment.samples.length - segment.offset;
      const drop = Math.min(overSamples, available);
      segment.offset += drop;
      this.queuedSamples = Math.max(0, this.queuedSamples - drop);
      if (segment.offset >= segment.samples.length) {
        this.queue.shift();
      }
      if (drop > 0) {
        events.push({ meta: segment.meta, droppedSamples: drop });
      }
    }
    return events;
  }
}
