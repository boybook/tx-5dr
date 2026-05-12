import { describe, expect, it } from 'vitest';
import { DeepCWDecoderBackend } from '../DeepCWDecoderBackend.js';
import { DEFAULT_CW_DECODER_CONFIG } from '../types.js';
import type { CWDecoderWorkerResult } from '../../worker-pool/CWDecoderWorkerCore.js';

class MockPool {
  calls: number[] = [];
  tuningUpdates: Array<{ targetFreqHz?: number; filterWidthHz?: number }> = [];
  stopCalls = 0;
  constructor(private readonly results: CWDecoderWorkerResult[]) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
  updateTuning(tuning: { targetFreqHz?: number; filterWidthHz?: number }): void {
    this.tuningUpdates.push(tuning);
  }
  getTelemetrySnapshot() {
    return {
      status: 'running' as const,
      workerCount: 1,
      jobsStarted: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
      inFlight: 0,
      pendingJobs: 0,
      lastError: null,
      workers: [],
    };
  }
  async decode(audio: Float32Array): Promise<CWDecoderWorkerResult> {
    this.calls.push(audio.length);
    return this.results.shift() ?? { id: 99, text: '', confidence: 0, plainText: '', wordSpaceSpans: [], characterSpans: [] };
  }
}

function audio(seconds: number): Float32Array {
  const samples = new Float32Array(seconds * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
  samples.fill(0.1);
  return samples;
}

function decodeResult(text = 'CQ TEST'): CWDecoderWorkerResult {
  const chars = Array.from(text);
  return {
    id: 1,
    text,
    plainText: text,
    displayText: text,
    confidence: 0.9,
    wordSpaceSpans: chars.flatMap((char, index) => (char === ' '
      ? [{ startFrame: 90 + index * 8, endFrame: 91 + index * 8 }]
      : [])),
    characterSpans: chars.map((char, index) => ({
      char,
      startFrame: 90 + index * 8,
      endFrame: 91 + index * 8,
    })),
  };
}

describe('DeepCWDecoderBackend', () => {
  it('commits a stable prefix and clears pending preview', async () => {
    const pool = new MockPool([decodeResult(), decodeResult()]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const pending: string[] = [];
    const commits: string[] = [];
    const resets: string[] = [];
    backend.on('reset', (event) => resets.push(event.sessionId));
    backend.on('pending', (event) => pending.push(event.text));
    backend.on('commit', (event) => commits.push(event.text));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, windowSeconds: 12, decodeIntervalMs: 1000 });
    backend.pushAudio(audio(4), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();
    backend.pushAudio(audio(1), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();

    expect(resets).toHaveLength(1);
    expect(pending).toEqual(['CQ TEST', 'CQ TEST', '']);
    expect(commits).toEqual(['CQ TEST']);
    expect(backend.getStatus()).toMatchObject({ lastPendingText: '', lastCommittedText: 'CQ TEST' });
    expect(pool.calls).toEqual([
      4 * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate,
      5 * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate,
    ]);
    await backend.stop('test');
  });

  it('does not create or start a worker pool until the decoder is started', async () => {
    let createdPools = 0;
    const backend = new DeepCWDecoderBackend({
      poolFactory: () => {
        createdPools += 1;
        return new MockPool([]) as never;
      },
    });

    await backend.updateConfig({ ...DEFAULT_CW_DECODER_CONFIG, enabled: false });

    expect(createdPools).toBe(0);
    expect(backend.getTelemetrySnapshot()).toMatchObject({ status: 'stopped', workers: [] });
  });

  it('clears transcript and pending audio without stopping the worker pool', async () => {
    const pool = new MockPool([decodeResult(), decodeResult()]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const pending: string[] = [];
    const resets: string[] = [];
    backend.on('pending', (event) => pending.push(event.text));
    backend.on('reset', (event) => resets.push(event.sessionId));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, windowSeconds: 12, decodeIntervalMs: 1000 });
    backend.pushAudio(audio(4), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();
    backend.pushAudio(audio(1), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();

    backend.clearTranscript();

    expect(resets).toHaveLength(2);
    expect(backend.getStatus()).toMatchObject({ state: 'running', lastPendingText: '', lastCommittedText: '', queuedSamples: 0 });
    expect(pending.at(-1)).toBe('');
    await backend.stop('test');
  });

  it('clears stale pending state on all-zero input without committing text', async () => {
    const pool = new MockPool([decodeResult()]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const pending: string[] = [];
    const commits: string[] = [];
    backend.on('pending', (event) => pending.push(event.text));
    backend.on('commit', (event) => commits.push(event.text));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, decodeIntervalMs: 1000 });
    backend.pushAudio(new Float32Array(3 * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();

    expect(commits).toEqual([]);
    expect(pending.at(-1)).toBe('');
    expect(backend.getStatus()).toMatchObject({ lastPendingText: '', queuedSamples: 0 });
    expect(pool.calls).toEqual([]);
    await backend.stop('test');
  });

  it('reports an error instead of resampling non-9600 Hz input inside the backend', async () => {
    const pool = new MockPool([decodeResult()]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const errors: string[] = [];
    backend.on('error', (event) => errors.push(event.error));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, decodeIntervalMs: 1000 });
    backend.pushAudio(audio(1), 12_000);

    expect(errors[0]).toContain('expects 9600 Hz audioData');
    expect(backend.getStatus()).toMatchObject({
      state: 'error',
      backendAvailable: false,
      backendError: expect.stringContaining('expects 9600 Hz audioData'),
    });
    expect(pool.calls).toEqual([]);
    await backend.stop('test');
  });

  it('updates target and filter width without restarting the worker pool', async () => {
    const pool = new MockPool([decodeResult()]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const pending: string[] = [];
    backend.on('pending', (event) => pending.push(event.text));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, targetFreqHz: 800, filterWidthHz: 800 });
    backend.pushAudio(audio(3), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);

    backend.updateTuning({ targetFreqHz: 650, filterWidthHz: 250 });

    expect(pool.stopCalls).toBe(0);
    expect(pool.tuningUpdates.at(-1)).toEqual({ targetFreqHz: 650, filterWidthHz: 250 });
    expect(pending.at(-1)).toBe('');
    expect(backend.getStatus()).toMatchObject({ state: 'running', lastPendingText: '', queuedSamples: 0 });
    await backend.stop('test');
  });
});
