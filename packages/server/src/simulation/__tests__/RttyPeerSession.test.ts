import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RttyDecoder, RttyEncoder } from 'rasterwave-node';
import { BUILTIN_PLUGINS } from '@tx5dr/builtin-plugins';
import type { TxAudioObservation } from '../../audio/TxAudioObservation.js';
import { RttyPeerSession, normalizeRttyMessage } from '../RttyPeerSession.js';

const scenarios = BUILTIN_PLUGINS.find((entry) => entry.definition.name === 'standard-qso')!.definition.simulationScenarios!;
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

function encode(text: string): Float32Array {
  const encoder = new RttyEncoder(12_000);
  encoder.pushText(text);
  encoder.finish();
  const chunks: Float32Array[] = [];
  while (!encoder.isFinished) chunks.push(encoder.readSamples(1_200).samples);
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

async function decode(pcm: Float32Array): Promise<string> {
  const characters: string[] = [];
  const decoder = new RttyDecoder(12_000, null, (event) => { if (event.type === 'character') characters.push(event.ch); });
  const padded = new Float32Array(pcm.length + 12_000);
  padded.set(pcm, 3_000);
  for (let offset = 0; offset < padded.length; offset += 1_200) {
    while (!decoder.pushF32(padded.subarray(offset, offset + 1_200))) await decoder.drain();
  }
  await decoder.finish();
  await decoder.dispose();
  return normalizeRttyMessage(characters.join(''));
}

describe('RttyPeerSession', () => {
  it('decodes a station CQ, answers through the scenario and renders decodable reply audio', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-rtty-peer-'));
    dirs.push(dir);
    let clock = 1_000_000;
    const peer = new RttyPeerSession({
      config: {
        mode: 'RTTY', dialFrequencyHz: 14_080_000, seed: 'test',
        peers: [{ id: 'remote-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'rtty-answering', audioFrequencyHz: 2210, dropProbability: 0, frequencyOffsetHz: 0, timingOffsetMs: 0 }],
      },
      artifactDir: dir,
      scenarios,
      now: () => clock,
      channel: () => ({ connected: true, frequency: 14_080_000, mode: 'RTTY' }),
      fail: (error) => { throw error; },
    });
    await peer.start();
    const pcm = encode('\nCQ CQ CQ DE BG5DRB BG5DRB BG5DRB K\n');
    const base = { transmissionId: 'tx-1', streamGeneration: 1, kind: 'rtty' as const, sampleRate: 12_000, stage: 'consumed' as const, timestampMs: clock };
    peer.observe({ ...base, phase: 'started', sampleOffset: 0 } as TxAudioObservation);
    for (let offset = 0; offset < pcm.length; offset += 1_200) {
      peer.observe({ ...base, phase: 'samples', sampleOffset: offset, samples: pcm.subarray(offset, offset + 1_200) } as TxAudioObservation);
    }
    clock += pcm.length / 12;
    peer.observe({ ...base, phase: 'completed', sampleOffset: pcm.length } as TxAudioObservation);
    await peer.settle();

    const trace = (await readFile(peer.getTracePath(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const decoded = trace.find((event) => event.kind === 'host-decode');
    expect(decoded.data.messages[0].text).toBe('CQ CQ CQ DE BG5DRB BG5DRB BG5DRB K');
    const scheduled = trace.find((event) => event.kind === 'reply-scheduled');
    expect(scheduled.data.text).toBe('BG5DRB DE JA1AAA JA1AAA K');

    const reply = peer.render(scheduled.data.startMs, 12_000, scheduled.data.samples);
    expect(await decode(reply)).toBe('BG5DRB DE JA1AAA JA1AAA K');
    await peer.stop('test');
  });
});
