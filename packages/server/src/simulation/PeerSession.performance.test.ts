import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODES, StationTestRunSchema } from '@tx5dr/contracts';
import { FT8MessageParser } from '@tx5dr/core';
import { AudioMixer } from '../audio/AudioMixer.js';
import { WSJTXEncodeWorkQueue, type EncodeRequest, type EncodeResult } from '../decode/WSJTXEncodeWorkQueue.js';
import { WSJTXDecodeProcessPool } from '../decode/WSJTXDecodeProcessPool.js';
import { PeerSession } from './PeerSession.js';
import { wwDigiSimulationScenarios } from './testFixtures/ww-digi-simulation-scenarios.js';

function encode(queue: WSJTXEncodeWorkQueue, request: EncodeRequest): Promise<EncodeResult> {
  return new Promise((resolve, reject) => {
    const complete = (result: EncodeResult & { request?: EncodeRequest }) => { if (result.request?.requestId === request.requestId) { cleanup(); resolve(result); } };
    const fail = (error: Error, failed: EncodeRequest) => { if (failed.requestId === request.requestId) { cleanup(); reject(error); } };
    const cleanup = () => { queue.off('encodeComplete', complete); queue.off('encodeError', fail); };
    queue.on('encodeComplete', complete); queue.on('encodeError', fail); void queue.push(request);
  });
}

describe('audio peer real codec', () => {
  it('round-trips extreme reports through the actual FT8 and FT4 encoders', async () => {
    const encoder = new WSJTXEncodeWorkQueue(1);
    try {
      for (const mode of ['FT8', 'FT4'] as const) for (const snr of [-90, 75]) {
        const message = `JA1AAA BG5DRB ${FT8MessageParser.generateSignalReport(snr)}`;
        const result = await encode(encoder, { operatorId: 'report', requestId: `${mode}-${snr}`, mode, frequency: 1500, message });
        expect(result.success).toBe(true);
      }
    } finally { await encoder.destroy(); }
  });

  for (const mode of ['FT8', 'FT4'] as const) for (const count of [1, 3, 5]) {
    it(`${mode} decodes ${count} observed tracks and returns real mixed audio`, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'tx5dr-peer-codec-'));
      const peers = ['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD', 'JA5EEE'].slice(0, count).map((callsign, i) => ({
        id: `peer-${i}`, callsign, grid: `PM9${i}`, scenarioId: count === 5 ? 'cq-pileup' : 'standard', audioFrequencyHz: 700 + i * 300,
      }));
      const descriptor = MODES[mode];
      const slot = Date.UTC(2026, 7, 26, 12, 0, 0);
      const now = slot + descriptor.transmitTiming;
      const config = StationTestRunSchema.parse({ version: 1, profileId: 'dummy', mode, dialFrequencyHz: 14090000,
        scenarioProvider: 'fixture', seed: 'codec', peers, artifactDir: dir });
      const failures: Error[] = [];
      let frequency = 14090000;
      const session = new PeerSession({ config, artifactDir: dir, scenarios: wwDigiSimulationScenarios, now: () => now,
        channel: () => ({ connected: true, frequency, mode }), fail: error => failures.push(error) });
      const encoder = new WSJTXEncodeWorkQueue(1);
      const decoder = new WSJTXDecodeProcessPool({ workerCount: 1 });
      try {
        await session.start();
        const mixer = new AudioMixer(0);
        for (const [i, peer] of (count === 5 ? peers.slice(0, 1) : peers).entries()) {
          const audio = await encode(encoder, { operatorId: `op-${i}`, requestId: `tx-${i}`, mode, frequency: peer.audioFrequencyHz,
            message: count === 5 ? 'CQ WW BG5DRB OL32' : `${peer.callsign} BG5DRB OL32` });
          mixer.addOperatorAudio(`op-${i}`, audio.audioData, audio.sampleRate, slot, `tx-${i}`, 0,
            { frameId: 'host', frameRevision: 1, slotId: 'host', streamId: `stream-${i}`, audioFrequencyHz: peer.audioFrequencyHz });
        }
        const mixed = await mixer.mixFrame(mixer.getFrameSnapshot('host', 1)!);
        const base = { transmissionId: 'host', streamGeneration: 1, kind: 'digital' as const, timestampMs: now,
          sampleOffset: 0, sampleRate: 12000, stage: 'consumed' as const };
        session.observe({ ...base, phase: 'started' });
        session.observe({ ...base, phase: 'samples', samples: mixed!.audioData });
        session.observe({ ...base, phase: 'completed', sampleOffset: mixed!.audioData.length });
        await session.settle();
        expect(failures).toEqual([]);
        const replySlot = slot + descriptor.slotMs;
        const pcm = session.render(replySlot, 12000, descriptor.slotMs * 12);
        expect(pcm.some(s => s !== 0)).toBe(true);
        const result = await decoder.decode({ slotId: 'verify', mode, windowIdx: 0, pcm: pcm.buffer, sampleRate: 12000, timestamp: replySlot, windowOffsetMs: 0 });
        expect(result.frames.map(f => f.message)).toEqual(expect.arrayContaining(peers.map(p => count === 5 ? `BG5DRB ${p.callsign} ${p.grid}` : `BG5DRB ${p.callsign} R ${p.grid}`)));
        frequency = 7074000;
        expect(session.render(replySlot, 12000, descriptor.slotMs * 12).every(s => s === 0)).toBe(true);
        const trace = await readFile(session.getTracePath(), 'utf8');
        expect(trace).toContain('host-decode');
        await session.stop('test complete');
        frequency = 14090000;
        expect(session.render(replySlot, 12000, descriptor.slotMs * 12).every(s => s === 0)).toBe(true);
      } finally {
        await session.stop('cleanup'); await encoder.destroy(); await decoder.destroy(); await rm(dir, { recursive: true, force: true });
      }
    }, 30000);
  }
});
