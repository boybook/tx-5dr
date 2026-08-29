import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODES, type DecodeRequest } from '@tx5dr/contracts';
import { BUILTIN_PLUGINS, BUILTIN_WW_DIGI_PLUGIN_NAME } from '@tx5dr/builtin-plugins';
import { WSJTXDecodeProcessPool } from '../decode/WSJTXDecodeProcessPool.js';
import { WSJTXEncodeWorkQueue, type EncodeRequest, type EncodeResult } from '../decode/WSJTXEncodeWorkQueue.js';
import { VirtualRadioProfileSchema } from '../config/virtualRadioProfile.js';
import { VirtualRadioSession } from './VirtualRadioSession.js';
import { AudioMixer } from '../audio/AudioMixer.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function encode(queue: WSJTXEncodeWorkQueue, request: EncodeRequest): Promise<EncodeResult> {
  return new Promise((resolve, reject) => {
    const complete = (result: EncodeResult & { request?: EncodeRequest }) => {
      if (result.request?.requestId !== request.requestId) return;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error, failed: EncodeRequest) => {
      if (failed.requestId !== request.requestId) return;
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      queue.off('encodeComplete', complete);
      queue.off('encodeError', fail);
    };
    queue.on('encodeComplete', complete);
    queue.on('encodeError', fail);
    void queue.push(request);
  });
}

describe('VirtualRadioSession real codec loop', () => {
  it('decodes host baseband and produces a decodable WW Digi peer reply', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-virtual-session-'));
    tempDirs.push(dataDir);
    const profile = VirtualRadioProfileSchema.parse({
      id: 'virtual-dev', name: 'hidden', createdAt: 1, updatedAt: 1,
      radio: { type: 'virtual', virtual: {
        dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 'codec-loop',
        peers: [{ id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_500 }],
      } },
    });
    const now = Date.UTC(2026, 7, 26, 12, 0, 0) + MODES.FT8.transmitTiming;
    const scenarios = BUILTIN_PLUGINS.find((plugin) => plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME)!.definition.simulationScenarios!;
    const session = new VirtualRadioSession({
      profile,
      scenarios,
      mode: MODES.FT8,
      dataDir,
      now: () => now,
      getOutputGain: () => 1,
      ingestInput: async () => undefined,
    });
    const hostEncoder = new WSJTXEncodeWorkQueue(1);
    const verifyDecoder = new WSJTXDecodeProcessPool({ workerCount: 1 });
    try {
      await session.start();
      const hostAudio = await encode(hostEncoder, {
        operatorId: 'operator-1', requestId: 'host-grid', mode: 'FT8', frequency: 1_500,
        message: 'JA1AAA BG5DRB OL32',
      });
      await (session as unknown as {
        decodeHostTransmission(audio: Float32Array, sampleRate: number): Promise<void>;
      }).decodeHostTransmission(hostAudio.audioData, hostAudio.sampleRate);

      const scheduled = (session as unknown as {
        scheduledAudio: Array<{ startMs: number; samples: Float32Array }>;
      }).scheduledAudio;
      expect(scheduled).toHaveLength(1);
      const slot = new Float32Array(MODES.FT8.slotMs / 1_000 * 12_000);
      slot.set(scheduled[0]!.samples, MODES.FT8.transmitTiming / 1_000 * 12_000);
      const request: DecodeRequest = {
        slotId: `verify-${now}`,
        mode: 'FT8', windowIdx: 0, pcm: slot.buffer, sampleRate: 12_000,
        timestamp: now, windowOffsetMs: 0,
      };
      const reply = await verifyDecoder.decode(request);
      expect(reply.frames.map((frame) => frame.message)).toContain('BG5DRB JA1AAA R PM95');
    } finally {
      await session.stop('test complete');
      await hostEncoder.destroy();
      await verifyDecoder.destroy();
    }
  }, 30_000);

  it('decodes and answers three calibrated host tracks in one frame', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-virtual-multitrack-'));
    tempDirs.push(dataDir);
    const peers = [
      { id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_000 },
      { id: 'peer-2', callsign: 'JA2BBB', grid: 'PM96', scenarioId: 'standard', audioFrequencyHz: 1_500 },
      { id: 'peer-3', callsign: 'JA3CCC', grid: 'PM97', scenarioId: 'standard', audioFrequencyHz: 2_000 },
    ];
    const profile = VirtualRadioProfileSchema.parse({
      id: 'virtual-three', name: 'hidden', createdAt: 1, updatedAt: 1,
      radio: { type: 'virtual', virtual: {
        dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 'three-lanes', peers,
      } },
    });
    const scenarios = BUILTIN_PLUGINS.find((plugin) => plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME)!.definition.simulationScenarios!;
    const now = Date.UTC(2026, 7, 26, 12, 0, 0) + MODES.FT8.transmitTiming;
    const session = new VirtualRadioSession({
      profile, scenarios, mode: MODES.FT8, dataDir, now: () => now,
      getOutputGain: () => 1, ingestInput: async () => undefined,
    });
    const encoder = new WSJTXEncodeWorkQueue(1);
    const verifyDecoder = new WSJTXDecodeProcessPool({ workerCount: 1 });
    try {
      await session.start();
      const mixer = new AudioMixer(0);
      for (const [index, peer] of peers.entries()) {
        const result = await encode(encoder, {
          operatorId: `operator-${index}`, streamId: `stream-${index}`, requestId: `host-${index}`,
          mode: 'FT8', frequency: peer.audioFrequencyHz, message: `${peer.callsign} BG5DRB OL32`,
        });
        mixer.addOperatorAudio(
          `operator-${index}`, result.audioData, result.sampleRate, now - MODES.FT8.transmitTiming,
          `host-${index}`, 0,
          { frameId: 'host-three', frameRevision: 1, slotId: 'host-three', streamId: `stream-${index}`, audioFrequencyHz: peer.audioFrequencyHz },
        );
      }
      const hostSnapshot = mixer.getFrameSnapshot('host-three', 1)!;
      const hostMix = await mixer.mixFrame(hostSnapshot);
      expect(hostMix?.mixMetrics?.trackCount).toBe(3);
      await (session as unknown as {
        decodeHostTransmission(audio: Float32Array, sampleRate: number): Promise<void>;
      }).decodeHostTransmission(hostMix!.audioData, hostMix!.sampleRate);

      const scheduled = (session as unknown as {
        scheduledAudio: Array<{ startMs: number; samples: Float32Array }>;
      }).scheduledAudio;
      expect(scheduled).toHaveLength(1);
      const slot = new Float32Array(MODES.FT8.slotMs / 1_000 * 12_000);
      slot.set(scheduled[0]!.samples, MODES.FT8.transmitTiming / 1_000 * 12_000);
      const reply = await verifyDecoder.decode({
        slotId: `verify-three-${now}`, mode: 'FT8', windowIdx: 0,
        pcm: slot.buffer, sampleRate: 12_000, timestamp: now, windowOffsetMs: 0,
      });
      expect(reply.frames.map((frame) => frame.message)).toEqual(expect.arrayContaining([
        'BG5DRB JA1AAA R PM95', 'BG5DRB JA2BBB R PM96', 'BG5DRB JA3CCC R PM97',
      ]));
    } finally {
      await session.stop('test complete');
      await encoder.destroy();
      await verifyDecoder.destroy();
    }
  }, 30_000);

  it('mixes five deterministic CQ pile-up replies into one decodable frame', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-virtual-pileup-'));
    tempDirs.push(dataDir);
    const peers = ['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD', 'JA5EEE'].map((callsign, index) => ({
      id: `pileup-${index}`, callsign, grid: `PM9${index}`,
      scenarioId: 'cq-pileup', audioFrequencyHz: 700 + index * 300,
    }));
    const profile = VirtualRadioProfileSchema.parse({
      id: 'virtual-pileup', name: 'hidden', createdAt: 1, updatedAt: 1,
      radio: { type: 'virtual', virtual: {
        dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 'pileup', peers,
      } },
    });
    const scenarios = BUILTIN_PLUGINS.find((plugin) => plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME)!.definition.simulationScenarios!;
    const now = Date.UTC(2026, 7, 26, 12, 0, 0) + MODES.FT8.transmitTiming;
    const session = new VirtualRadioSession({
      profile, scenarios, mode: MODES.FT8, dataDir, now: () => now,
      getOutputGain: () => 1, ingestInput: async () => undefined,
    });
    const encoder = new WSJTXEncodeWorkQueue(1);
    const decoder = new WSJTXDecodeProcessPool({ workerCount: 1 });
    try {
      await session.start();
      const cq = await encode(encoder, {
        operatorId: 'operator-1', requestId: 'pileup-cq', mode: 'FT8', frequency: 1_500,
        message: 'CQ WW BG5DRB OL32',
      });
      await (session as unknown as {
        decodeHostTransmission(audio: Float32Array, sampleRate: number): Promise<void>;
      }).decodeHostTransmission(cq.audioData, cq.sampleRate);
      const scheduled = (session as unknown as {
        scheduledAudio: Array<{ startMs: number; samples: Float32Array }>;
      }).scheduledAudio;
      expect(scheduled).toHaveLength(1);
      const slot = new Float32Array(MODES.FT8.slotMs / 1_000 * 12_000);
      slot.set(scheduled[0]!.samples, MODES.FT8.transmitTiming / 1_000 * 12_000);
      const reply = await decoder.decode({
        slotId: `verify-pileup-${now}`, mode: 'FT8', windowIdx: 0,
        pcm: slot.buffer, sampleRate: 12_000, timestamp: now, windowOffsetMs: 0,
      });
      expect(reply.frames.map((frame) => frame.message)).toEqual(expect.arrayContaining(
        peers.map((peer) => `BG5DRB ${peer.callsign} ${peer.grid}`),
      ));
    } finally {
      await session.stop('test complete');
      await encoder.destroy();
      await decoder.destroy();
    }
  }, 30_000);

  it('uses the same isolated loop for FT4', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-virtual-ft4-'));
    tempDirs.push(dataDir);
    const profile = VirtualRadioProfileSchema.parse({
      id: 'virtual-ft4', name: 'hidden', createdAt: 1, updatedAt: 1,
      radio: { type: 'virtual', virtual: {
        dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 'ft4-loop',
        peers: [{ id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_500 }],
      } },
    });
    const scenarios = BUILTIN_PLUGINS.find((plugin) => plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME)!.definition.simulationScenarios!;
    const now = Date.UTC(2026, 7, 26, 12, 0, 0) + MODES.FT4.transmitTiming;
    const session = new VirtualRadioSession({
      profile, scenarios, mode: MODES.FT4, dataDir, now: () => now,
      getOutputGain: () => 1, ingestInput: async () => undefined,
    });
    const encoder = new WSJTXEncodeWorkQueue(1);
    const decoder = new WSJTXDecodeProcessPool({ workerCount: 1 });
    try {
      await session.start();
      const host = await encode(encoder, {
        operatorId: 'operator-1', requestId: 'host-ft4', mode: 'FT4', frequency: 1_500,
        message: 'JA1AAA BG5DRB OL32',
      });
      await (session as unknown as {
        decodeHostTransmission(audio: Float32Array, sampleRate: number): Promise<void>;
      }).decodeHostTransmission(host.audioData, host.sampleRate);
      const scheduled = (session as unknown as {
        scheduledAudio: Array<{ startMs: number; samples: Float32Array }>;
      }).scheduledAudio;
      const slot = new Float32Array(MODES.FT4.slotMs / 1_000 * 12_000);
      slot.set(scheduled[0]!.samples, MODES.FT4.transmitTiming / 1_000 * 12_000);
      const reply = await decoder.decode({
        slotId: `verify-ft4-${now}`, mode: 'FT4', windowIdx: 0,
        pcm: slot.buffer, sampleRate: 12_000, timestamp: now, windowOffsetMs: 0,
      });
      expect(reply.frames.map((frame) => frame.message)).toContain('BG5DRB JA1AAA R PM95');
    } finally {
      await session.stop('test complete');
      await encoder.destroy();
      await decoder.destroy();
    }
  }, 30_000);

  it('preserves the physical playback cancellation contract', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-virtual-cancel-'));
    tempDirs.push(dataDir);
    const profile = VirtualRadioProfileSchema.parse({
      id: 'virtual-cancel', name: 'hidden', createdAt: 1, updatedAt: 1,
      radio: { type: 'virtual', virtual: {
        dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 'cancel',
        peers: [{ id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_500 }],
      } },
    });
    const scenarios = BUILTIN_PLUGINS.find((plugin) => plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME)!.definition.simulationScenarios!;
    let now = Date.now();
    const session = new VirtualRadioSession({
      profile, scenarios, mode: MODES.FT8, dataDir, now: () => now,
      getOutputGain: () => 1, ingestInput: async () => undefined,
    });
    await session.start();
    try {
      const playback = session.playAudio(new Float32Array(12_000), 12_000, { playbackKind: 'tune-tone' });
      const interrupted = expect(playback).rejects.toThrow('playback interrupted');
      await new Promise<void>((resolve) => setImmediate(resolve));
      now += 250;
      expect(await session.stopCurrentPlayback({ kind: 'tune-tone' })).toBe(250);
      await interrupted;
      expect(session.isPlaying()).toBe(false);
    } finally {
      await session.stop('test complete');
    }
  });

  it('catches up delayed host-monitor input without gaps and truncates it on cancellation', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tx5dr-virtual-tx-monitor-'));
    tempDirs.push(dataDir);
    const profile = VirtualRadioProfileSchema.parse({
      id: 'virtual-tx-monitor', name: 'hidden', createdAt: 1, updatedAt: 1,
      radio: { type: 'virtual', virtual: {
        dialFrequencyHz: 14_090_000, scenarioProvider: 'ww-digi', seed: 'tx-monitor',
        peers: [{ id: 'peer-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: 'standard', audioFrequencyHz: 1_500 }],
      } },
    });
    const scenarios = BUILTIN_PLUGINS.find((plugin) => (
      plugin.definition.name === BUILTIN_WW_DIGI_PLUGIN_NAME
    ))!.definition.simulationScenarios!;
    let now = Date.now();
    const ingested: Float32Array[] = [];
    const session = new VirtualRadioSession({
      profile, scenarios, mode: MODES.FT8, dataDir, now: () => now,
      getOutputGain: () => 1,
      ingestInput: async (samples) => { ingested.push(samples.slice()); },
    });
    await session.start();
    try {
      const internals = session as unknown as {
        pumpTimer: NodeJS.Timeout | null;
        pumpInput(): Promise<void>;
      };
      if (internals.pumpTimer) clearTimeout(internals.pumpTimer);
      internals.pumpTimer = null;
      const waveform = Float32Array.from(
        { length: 12_000 },
        (_value, index) => ((index % 100) - 50) / 100,
      );
      const playback = session.playAudio(waveform, 12_000, { playbackKind: 'tune-tone' });
      const interrupted = expect(playback).rejects.toThrow('playback interrupted');
      await new Promise<void>((resolve) => setImmediate(resolve));

      now += 350;
      await internals.pumpInput();
      expect(ingested).toHaveLength(3);
      const caughtUp = new Float32Array(3_600);
      ingested.forEach((chunk, index) => caughtUp.set(chunk, index * chunk.length));
      expect(caughtUp).toEqual(waveform.slice(0, 3_600));

      expect(await session.stopCurrentPlayback({ kind: 'tune-tone' })).toBe(350);
      await interrupted;
      now += 150;
      await internals.pumpInput();
      expect(ingested).toHaveLength(5);
      expect(ingested[3]?.slice(0, 600)).toEqual(waveform.slice(3_600, 4_200));
      expect(ingested[3]?.slice(600).every((sample) => sample === 0)).toBe(true);
      expect(ingested[4]?.every((sample) => sample === 0)).toBe(true);
    } finally {
      await session.stop('test complete');
    }
  });
});
