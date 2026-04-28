import { describe, expect, it } from 'vitest';
import { VoiceTxOutputPipeline, type VoiceTxOutputSinkState } from '../VoiceTxOutputPipeline.js';
import type { VoiceTxOutputObserver } from '../AudioStreamManager.js';
import type { VoiceTxFrameMeta } from '../../voice/VoiceTxDiagnostics.js';

const sink: VoiceTxOutputSinkState = {
  available: true,
  kind: 'rtaudio',
  outputSampleRate: 48000,
  outputBufferSize: 480,
};

function createMeta(sequence: number, clientSentAtMs: number | null = Date.now()): VoiceTxFrameMeta {
  return {
    transport: 'rtc-data-audio',
    participantIdentity: 'rtc-data-send:test',
    sequence,
    clientSentAtMs,
    serverReceivedAtMs: Date.now(),
    sampleRate: 16000,
    samplesPerChannel: 160,
  };
}

function createInputFrame(): Float32Array {
  const frame = new Float32Array(160);
  frame.fill(0.25);
  return frame;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VoiceTxOutputPipeline', () => {
  it('starts playout after a small realtime jitter target and writes output chunks', async () => {
    const writes: number[] = [];
    const processed: number[] = [];
    const observer: VoiceTxOutputObserver = {
      onFrameProcessed: ({ queuedAudioMs, jitterTargetMs }) => {
        processed.push(queuedAudioMs);
        expect(jitterTargetMs).toBeGreaterThanOrEqual(30);
      },
    };
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => observer,
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(samples.length);
        return true;
      },
    });

    for (let index = 0; index < 5; index += 1) {
      pipeline.ingest(createInputFrame(), 16000, createMeta(index));
    }

    await wait(30);
    pipeline.clear();

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((length) => length === sink.outputBufferSize)).toBe(true);
    expect(processed.length).toBeGreaterThan(0);
  });

  it('drops stale frames instead of letting old speech accumulate', () => {
    const dropped: string[] = [];
    const observer: VoiceTxOutputObserver = {
      onFrameDropped: ({ reason }) => {
        dropped.push(reason);
      },
    };
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => observer,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });

    pipeline.ingest(createInputFrame(), 16000, createMeta(1, Date.now() - 250));

    expect(dropped).toEqual(['stale']);
    expect(pipeline.getQueuedMs(sink.outputSampleRate)).toBe(0);
  });
});
