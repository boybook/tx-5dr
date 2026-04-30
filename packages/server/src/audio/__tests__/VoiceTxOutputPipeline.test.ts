import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveVoiceTxBufferPolicy, type ResolvedVoiceTxBufferPolicy } from '@tx5dr/contracts';
import { VoiceTxOutputPipeline, type VoiceTxOutputSinkState } from '../VoiceTxOutputPipeline.js';
import { clearVoiceTxJitterSeedsForTests } from '../VoiceTxJitterController.js';
import type { VoiceTxOutputObserver } from '../AudioStreamManager.js';
import type { VoiceTxFrameMeta } from '../../voice/VoiceTxDiagnostics.js';

const sink: VoiceTxOutputSinkState = {
  available: true,
  kind: 'rtaudio',
  outputSampleRate: 48000,
  outputBufferSize: 480,
};

function createMeta(
  sequence: number,
  clientSentAtMs: number | null = Date.now(),
  voiceTxBufferPolicy: ResolvedVoiceTxBufferPolicy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 40 }),
): VoiceTxFrameMeta {
  return {
    transport: 'rtc-data-audio',
    participantIdentity: 'rtc-data-send:test',
    sequence,
    clientSentAtMs,
    serverReceivedAtMs: Date.now(),
    sampleRate: 16000,
    samplesPerChannel: 320,
    voiceTxBufferPolicy,
  };
}

function createInputFrame(value = 0.25): Float32Array {
  const frame = new Float32Array(320);
  frame.fill(value);
  return frame;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VoiceTxOutputPipeline', () => {
  beforeEach(() => {
    clearVoiceTxJitterSeedsForTests();
  });

  it('starts playout after a small realtime jitter target and writes output chunks', async () => {
    const writes: number[] = [];
    const outputBuffered: number[] = [];
    const observer: VoiceTxOutputObserver = {
      onFrameProcessed: ({ outputBufferedMs, jitterTargetMs }) => {
        outputBuffered.push(outputBufferedMs ?? 0);
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
    expect(outputBuffered.length).toBeGreaterThan(0);
    expect(outputBuffered.some((value) => value > 10)).toBe(true);
    expect(outputBuffered.every((value) => value <= 80)).toBe(true);
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

    pipeline.ingest(createInputFrame(), 16000, createMeta(1, Date.now() - 320));

    expect(dropped).toEqual(['stale']);
    expect(pipeline.getQueuedMs(sink.outputSampleRate)).toBe(0);
  });

  it('uses target-relative TX waterlines for runtime rebuffer decisions', () => {
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });

    pipeline.setOutputEnabled(false);
    pipeline.ingest(
      createInputFrame(),
      16000,
      createMeta(1, Date.now(), resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 400 })),
    );
    const highTargetState = pipeline.getOutputBufferState();
    expect(highTargetState.targetMs).toBe(400);
    expect(highTargetState.rebufferEnterWaterMs).toBe(240);
    expect(highTargetState.rebufferResumeWaterMs).toBe(360);

    pipeline.clear();
    pipeline.setOutputEnabled(false);
    pipeline.ingest(
      createInputFrame(),
      16000,
      createMeta(1, Date.now(), resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 120 })),
    );
    const lowTargetState = pipeline.getOutputBufferState();
    pipeline.clear();

    expect(lowTargetState.targetMs).toBe(120);
    expect(lowTargetState.rebufferEnterWaterMs).toBe(80);
    expect(lowTargetState.rebufferResumeWaterMs).toBe(120);
  });

  it('relaxes stale drops when the TX target is high', () => {
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
    const policy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 400 });

    pipeline.setOutputEnabled(false);
    pipeline.ingest(createInputFrame(), 16000, createMeta(1, Date.now() - 500, policy));
    expect(dropped).toEqual([]);
    expect(pipeline.getQueuedMs(sink.outputSampleRate)).toBeGreaterThan(0);

    pipeline.ingest(createInputFrame(), 16000, createMeta(2, Date.now() - 1900, policy));
    pipeline.clear();

    expect(dropped).toEqual(['stale']);
  });

  it('uses the selected TX buffer policy to allow larger stable queues', () => {
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
    const stablePolicy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 170 });

    for (let index = 0; index < 10; index += 1) {
      pipeline.ingest(createInputFrame(), 16000, createMeta(index, Date.now(), stablePolicy));
    }
    pipeline.clear();

    expect(dropped).not.toContain('jitter-trim');
  });

  it('raises the TX jitter target from packet arrival jitter before output underruns', () => {
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });
    const policy = resolveVoiceTxBufferPolicy({ profile: 'auto' });
    const base = Date.now();

    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(0, base, policy),
      mediaTimestampMs: 0,
      serverReceivedAtMs: base,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });
    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(1, base + 20, policy),
      mediaTimestampMs: 20,
      serverReceivedAtMs: base + 90,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });

    expect(pipeline.getCurrentJitterTargetMs()).toBeGreaterThan(policy.targetMs);
    pipeline.clear();
  });

  it('does not mix pre-PTT probe timestamps with media packet timestamps', () => {
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });
    const policy = resolveVoiceTxBufferPolicy({ profile: 'auto' });
    const base = Date.now();

    pipeline.recordTimingProbe({
      participantIdentity: 'rtc-data-send:test',
      transport: 'rtc-data-audio',
      codec: 'pcm-s16le',
      sequence: 1,
      sentAtMs: base,
      receivedAtMs: base,
      intervalMs: 200,
      voiceTxBufferPolicy: policy,
    });
    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(0, base, policy),
      mediaTimestampMs: 0,
      serverReceivedAtMs: base + 20,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });
    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(1, base + 20, policy),
      mediaTimestampMs: 20,
      serverReceivedAtMs: base + 40,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });

    expect(pipeline.getCurrentJitterTargetMs()).toBeLessThan(policy.maxMs);
    pipeline.clear();
  });

  it('does not let non-media timing probes reset the active TX target', () => {
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });
    const policy = resolveVoiceTxBufferPolicy({ profile: 'auto' });
    const base = Date.now();

    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(0, base, policy),
      participantIdentity: 'rtc-data-send:active:11111111-1111-4111-8111-111111111111',
      serverReceivedAtMs: base,
      frameDurationMs: 20,
      codec: 'opus',
    });
    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(1, base + 20, policy),
      participantIdentity: 'rtc-data-send:active:11111111-1111-4111-8111-111111111111',
      serverReceivedAtMs: base + 140,
      frameDurationMs: 20,
      codec: 'opus',
    });

    const learnedTarget = pipeline.getCurrentJitterTargetMs();
    expect(learnedTarget).toBeGreaterThan(policy.targetMs);

    for (let index = 0; index < 4; index += 1) {
      pipeline.recordTimingProbe({
        participantIdentity: 'rtc-data-send:other:22222222-2222-4222-8222-222222222222',
        transport: 'rtc-data-audio',
        codec: 'pcm-s16le',
        sequence: index,
        sentAtMs: base + (index * 200),
        receivedAtMs: base + (index * 200),
        intervalMs: 200,
        voiceTxBufferPolicy: policy,
      });
    }

    expect(pipeline.getCurrentJitterTargetMs()).toBe(learnedTarget);
    pipeline.clear();
  });

  it('reuses TX jitter seed across randomized participant identities for the same stable client', () => {
    const policy = resolveVoiceTxBufferPolicy({ profile: 'auto' });
    const base = Date.now();
    const seedPipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });

    seedPipeline.recordTimingProbe({
      participantIdentity: 'rtc-data-send:token-abc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      transport: 'rtc-data-audio',
      codec: 'opus',
      sequence: 0,
      sentAtMs: base,
      receivedAtMs: base,
      intervalMs: 200,
      voiceTxBufferPolicy: policy,
    });
    seedPipeline.recordTimingProbe({
      participantIdentity: 'rtc-data-send:token-abc:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      transport: 'rtc-data-audio',
      codec: 'opus',
      sequence: 1,
      sentAtMs: base + 200,
      receivedAtMs: base + 360,
      intervalMs: 200,
      voiceTxBufferPolicy: policy,
    });

    const mediaPipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });
    mediaPipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(0, base + 400, policy),
      participantIdentity: 'rtc-data-send:token-abc:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      serverReceivedAtMs: base + 400,
      frameDurationMs: 20,
      codec: 'opus',
    });

    expect(mediaPipeline.getCurrentJitterTargetMs()).toBeGreaterThan(policy.targetMs);
    seedPipeline.clear();
    mediaPipeline.clear();
  });

  it('uses sequence timing instead of jittery media timestamps for TX target estimation', () => {
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });
    const policy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 40 });
    const base = Date.now();

    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(0, base, policy),
      participantIdentity: 'rtc-data-send:jittery-media-timestamp',
      mediaTimestampMs: 0,
      serverReceivedAtMs: base,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });
    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(1, base + 20, policy),
      participantIdentity: 'rtc-data-send:jittery-media-timestamp',
      mediaTimestampMs: 1000,
      serverReceivedAtMs: base + 20,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });

    expect(pipeline.getCurrentJitterTargetMs()).toBe(policy.targetMs);
    pipeline.clear();
  });

  it('keeps a custom TX buffer target fixed while auto would adapt', () => {
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: () => true,
    });
    const policy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 80 });
    const base = Date.now();

    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(0, base, policy),
      serverReceivedAtMs: base,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });
    pipeline.ingest(createInputFrame(), 16000, {
      ...createMeta(1, base + 20, policy),
      serverReceivedAtMs: base + 120,
      frameDurationMs: 20,
      codec: 'pcm-s16le',
    });

    expect(pipeline.getCurrentJitterTargetMs()).toBe(policy.targetMs);
    pipeline.clear();
  });

  it('does not re-preroll a fixed custom TX buffer on every incoming packet', async () => {
    const writes: Float32Array[] = [];
    const policy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 100 });
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => sink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(new Float32Array(samples));
        return true;
      },
    });

    for (let index = 0; index < 6; index += 1) {
      pipeline.ingest(createInputFrame(), 16000, createMeta(index, Date.now(), policy));
    }

    await wait(45);
    const writesBeforeLatePacket = writes.length;
    pipeline.ingest(createInputFrame(), 16000, createMeta(6, Date.now(), policy));
    await wait(45);
    pipeline.clear();

    expect(writesBeforeLatePacket).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(writesBeforeLatePacket);
    expect(pipeline.getCurrentJitterTargetMs()).toBe(resolveVoiceTxBufferPolicy().targetMs);
  });

  it('keeps playing below target until the runtime low-water is reached', async () => {
    const chunkSink = { ...sink, outputBufferSize: 960 };
    const writes: Float32Array[] = [];
    const policy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 200 });
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => chunkSink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(new Float32Array(samples));
        return true;
      },
    });

    try {
      for (let index = 0; index < 12; index += 1) {
        pipeline.ingest(createInputFrame(), 16000, createMeta(index, Date.now(), policy));
      }

      await wait(120);
      expect(writes.length).toBeGreaterThan(0);

      const lowWaterState = pipeline.getOutputBufferState();
      expect(lowWaterState.targetMs).toBe(200);
      expect(lowWaterState.totalBufferedMs).toBeLessThan(lowWaterState.targetMs);
      expect(lowWaterState.totalBufferedMs).toBeGreaterThanOrEqual(lowWaterState.rebufferEnterWaterMs - 1);
      expect(lowWaterState.rebuffering).toBe(false);
      expect(lowWaterState.playoutStarted).toBe(true);
      expect(lowWaterState.queueMs).toBeGreaterThan(0);

      const writesBeforeRebuffer = writes.length;
      await wait(140);
      const rebufferState = pipeline.getOutputBufferState();
      expect(rebufferState.totalBufferedMs).toBeLessThan(rebufferState.rebufferEnterWaterMs);
      expect(rebufferState.rebuffering || !rebufferState.playoutStarted).toBe(true);

      for (let index = 12; index < 22; index += 1) {
        pipeline.ingest(createInputFrame(), 16000, createMeta(index, Date.now(), policy));
      }
      await wait(40);
      expect(pipeline.getOutputBufferState().rebuffering).toBe(false);
      expect(writes.length).toBeGreaterThan(writesBeforeRebuffer);
    } finally {
      pipeline.clear();
    }
  });

  it('does not rebuffer on an auto target raise while buffered audio remains above low-water', async () => {
    vi.useFakeTimers({
      now: new Date('2026-04-29T00:05:00.000Z'),
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'],
    });
    const chunkSink = { ...sink, outputBufferSize: 960 };
    const policy = resolveVoiceTxBufferPolicy({ profile: 'auto' });
    const writes: Float32Array[] = [];
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => chunkSink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(new Float32Array(samples));
        return true;
      },
    });
    const base = Date.now();

    try {
      for (let index = 0; index < 5; index += 1) {
        pipeline.ingest(createInputFrame(), 16000, {
          ...createMeta(index, base + (index * 20), policy),
          serverReceivedAtMs: base + (index * 20),
          frameDurationMs: 20,
          codec: 'pcm-s16le',
        });
      }
      await vi.advanceTimersByTimeAsync(2);
      expect(writes.length).toBeGreaterThan(0);

      const writesBeforeJitter = writes.length;
      pipeline.ingest(createInputFrame(), 16000, {
        ...createMeta(5, base + 100, policy),
        serverReceivedAtMs: base + 180,
        frameDurationMs: 20,
        codec: 'pcm-s16le',
      });

      const stateAfterJitter = pipeline.getOutputBufferState();
      expect(stateAfterJitter.targetMs).toBeGreaterThan(policy.targetMs);
      expect(stateAfterJitter.totalBufferedMs).toBeGreaterThanOrEqual(stateAfterJitter.rebufferEnterWaterMs);
      expect(stateAfterJitter.rebuffering).toBe(false);

      await vi.advanceTimersByTimeAsync(80);
      expect(writes.length).toBeGreaterThan(writesBeforeJitter);
      expect(writes.every((samples) => samples.length === chunkSink.outputBufferSize)).toBe(true);
    } finally {
      pipeline.clear();
      vi.useRealTimers();
    }
  });

  it('waits for the next 20ms frame instead of padding partial RtAudio chunks while device lead is healthy', async () => {
    const chunkSink = { ...sink, outputBufferSize: 1024 };
    const writes: Float32Array[] = [];
    let maxUnderruns = 0;
    let maxPlcFrames = 0;
    const policy = resolveVoiceTxBufferPolicy({ profile: 'custom', customTargetBufferMs: 100 });
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => chunkSink,
      getObserver: () => ({
        onFrameProcessed: ({ underrunCount, plcFrames }) => {
          maxUnderruns = Math.max(maxUnderruns, underrunCount ?? 0);
          maxPlcFrames = Math.max(maxPlcFrames, plcFrames ?? 0);
        },
      }),
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(new Float32Array(samples));
        return true;
      },
    });

    for (let index = 0; index < 10; index += 1) {
      pipeline.ingest(createInputFrame(), 16000, createMeta(index, Date.now(), policy));
    }

    await wait(60);
    pipeline.clear();

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((samples) => samples.length === chunkSink.outputBufferSize)).toBe(true);
    expect(maxUnderruns).toBe(0);
    expect(maxPlcFrames).toBe(0);
  });

  it('uses one short tail PLC chunk on output underrun before stopping', async () => {
    const writes: Float32Array[] = [];
    const chunkSink = { ...sink, outputBufferSize: 960 };
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => chunkSink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(new Float32Array(samples));
        return true;
      },
    });

    for (let index = 0; index < 3; index += 1) {
      pipeline.ingest(new Float32Array(960).fill(0.5), 48000, createMeta(index));
    }

    await wait(140);
    pipeline.clear();

    const plcWrites = writes.filter((samples) => {
      const firstZero = samples.findIndex((sample, index) => index > 0 && Math.abs(sample) < 0.000001);
      return firstZero > 0
        && samples.some((sample, index) => index < firstZero && sample > 0 && sample < 0.5)
        && Array.from(samples.slice(firstZero)).every((sample) => Math.abs(sample) < 0.000001);
    });
    expect(plcWrites).toHaveLength(1);
    const plc = plcWrites[0]!;
    const plcTailSamples = Math.ceil(chunkSink.outputSampleRate * 0.008);
    expect(plc[0]).toBeCloseTo(0.5, 2);
    expect(plc.filter((sample) => sample > 0 && sample < 0.5).length).toBeLessThanOrEqual(plcTailSamples);
  });

  it('crossfades the first restored output after a tail PLC chunk', async () => {
    const writes: Float32Array[] = [];
    const chunkSink = { ...sink, outputBufferSize: 960 };
    const pipeline = new VoiceTxOutputPipeline({
      getSinkState: () => chunkSink,
      getObserver: () => null,
      getVolumeGain: () => 1,
      writeOutputChunk: (samples) => {
        writes.push(new Float32Array(samples));
        return true;
      },
    });

    for (let index = 0; index < 3; index += 1) {
      pipeline.ingest(new Float32Array(960).fill(0.25), 48000, createMeta(index));
    }
    await wait(120);
    for (let index = 3; index < 6; index += 1) {
      pipeline.ingest(new Float32Array(960).fill(0.75), 48000, createMeta(index));
    }

    await wait(120);
    pipeline.clear();

    const restored = writes.find((samples) => samples[0]! > 0.25 && samples[0]! < 0.75);
    expect(restored).toBeDefined();
    expect(restored?.[0]).toBeLessThan(restored?.[150] ?? 0);
    expect(restored?.[150]).toBeCloseTo(0.75, 2);
  });
});
