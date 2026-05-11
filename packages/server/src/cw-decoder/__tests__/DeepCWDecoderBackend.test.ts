import { describe, expect, it } from 'vitest';
import { DeepCWDecoderBackend } from '../DeepCWDecoderBackend.js';
import { DEFAULT_CW_DECODER_CONFIG } from '../types.js';
import type { CWDecoderWorkerResult } from '../../worker-pool/CWDecoderWorkerCore.js';

class MockPool {
  calls: number[] = [];
  constructor(private readonly results: CWDecoderWorkerResult[]) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
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

describe('DeepCWDecoderBackend', () => {
  it('commits confirmed audio at a word-space split and clears pending preview', async () => {
    const pool = new MockPool([{
      id: 1,
      text: 'CQ TEST',
      plainText: 'CQ TEST',
      displayText: 'CQ TEST',
      confidence: 0.9,
      wordSpaceSpans: [{ startFrame: 100, endFrame: 105 }],
      characterSpans: [
        { char: 'C', startFrame: 0, endFrame: 1 },
        { char: 'Q', startFrame: 10, endFrame: 11 },
        { char: ' ', startFrame: 100, endFrame: 105 },
        { char: 'T', startFrame: 110, endFrame: 111 },
        { char: 'E', startFrame: 120, endFrame: 121 },
        { char: 'S', startFrame: 130, endFrame: 131 },
        { char: 'T', startFrame: 140, endFrame: 141 },
      ],
    }]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const pending: string[] = [];
    const commits: string[] = [];
    backend.on('pending', (event) => pending.push(event.text));
    backend.on('commit', (event) => commits.push(event.text));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, windowSeconds: 12, decodeIntervalMs: 1000 });
    backend.pushAudio(new Float32Array(4 * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();

    expect(pending).toEqual(['CQ TEST', '']);
    expect(commits).toEqual(['CQ']);
    expect(backend.getStatus()).toMatchObject({ lastPendingText: '', lastCommittedText: 'CQ' });
    expect(pool.calls[0]).toBe(4 * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
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
    const pool = new MockPool([{
      id: 1,
      text: 'CQ TEST',
      plainText: 'CQ TEST',
      displayText: 'CQ TEST',
      confidence: 0.9,
      wordSpaceSpans: [{ startFrame: 100, endFrame: 105 }],
      characterSpans: [
        { char: 'C', startFrame: 0, endFrame: 1 },
        { char: 'Q', startFrame: 10, endFrame: 11 },
        { char: ' ', startFrame: 100, endFrame: 105 },
      ],
    }]);
    const backend = new DeepCWDecoderBackend({ poolFactory: () => pool as never });
    const pending: string[] = [];
    backend.on('pending', (event) => pending.push(event.text));

    await backend.start({ ...DEFAULT_CW_DECODER_CONFIG, enabled: true, windowSeconds: 12, decodeIntervalMs: 1000 });
    backend.pushAudio(new Float32Array(4 * DEFAULT_CW_DECODER_CONFIG.decodeSampleRate), DEFAULT_CW_DECODER_CONFIG.decodeSampleRate);
    await (backend as unknown as { runDecodeJob: () => Promise<void> }).runDecodeJob();

    backend.clearTranscript();

    expect(backend.getStatus()).toMatchObject({ state: 'running', lastPendingText: '', lastCommittedText: '', queuedSamples: 0 });
    expect(pending.at(-1)).toBe('');
    await backend.stop('test');
  });
});
