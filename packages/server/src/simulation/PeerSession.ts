import { FT8MessageParser } from '@tx5dr/core';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MODES, type StationTestRun } from '@tx5dr/contracts';
import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
import { AudioMixer } from '../audio/AudioMixer.js';
import type { TxAudioObservation } from '../audio/TxAudioObservation.js';
import { resampleAudioProfessional } from '../utils/audioUtils.js';
import { WSJTXDecodeProcessPool } from '../decode/WSJTXDecodeProcessPool.js';
import { WSJTXEncodeWorkQueue, type EncodeRequest, type EncodeResult } from '../decode/WSJTXEncodeWorkQueue.js';
import { SimulationScenarioEngine, type SimulationReplyDecision } from './SimulationScenarioEngine.js';

const SAMPLE_RATE = 12_000;
interface ScheduledAudio { startMs: number; samples: Float32Array; }
export interface PeerSessionOptions {
  config: Pick<StationTestRun, 'mode' | 'dialFrequencyHz' | 'transmitCycle' | 'seed' | 'peers'>;
  artifactDir: string;
  scenarios: SimulationScenarioDescriptor[];
  now: () => number;
  channel: () => { connected: boolean; frequency: number; mode: string };
  fail: (error: Error) => void;
}
function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

/** A protocol peer consumes observed PCM and produces PCM; it never owns the station. */
export class PeerSession {
  readonly sessionId = randomUUID();
  private readonly mode;
  private readonly scenarioEngine: SimulationScenarioEngine;
  private readonly decodePool = new WSJTXDecodeProcessPool({ workerCount: 1 });
  private readonly encodeQueue = new WSJTXEncodeWorkQueue(1);
  private readonly channelRandom = new Map<string, () => number>();
  private readonly scheduledAudio: ScheduledAudio[] = [];
  private readonly transmissions = new Map<string, { startMs: number; rate: number; offset: number; chunks: Float32Array[] }>();
  private running = false;
  private readonly cancellation = new AbortController();
  private stopPromise?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private tail: Promise<void> = Promise.resolve();
  private traceTail: Promise<void> = Promise.resolve();
  private lastSlot = 0;
  private readonly tracePath: string;

  constructor(private readonly options: PeerSessionOptions) {
    this.mode = MODES[options.config.mode];
    this.tracePath = path.join(options.artifactDir, 'peer.jsonl');
    const scenarios = new Map(options.scenarios.map(s => [s.id, s]));
    this.scenarioEngine = new SimulationScenarioEngine(options.config.seed, options.config.peers.map(peer => {
      const scenario = scenarios.get(peer.scenarioId);
      if (!scenario || !scenario.modes.includes(options.config.mode)) throw new Error(`Peer scenario unavailable: ${peer.scenarioId}`);
      if (peer.identityPool && !scenario.identityPool?.length) throw new Error('Scenario has no identity pool');
      this.channelRandom.set(peer.id, seededRandom(hashSeed(`${options.config.seed}:${peer.id}`)));
      return { ...peer, scenario, identityPool: peer.identityPool === 'scenario' ? scenario.identityPool : undefined };
    }), event => { void this.trace('scenario', event); });
  }
  async start(): Promise<void> {
    if (this.running || this.cancellation.signal.aborted) throw new Error('Peer session cannot be restarted');
    await fs.mkdir(path.dirname(this.tracePath), { recursive: true });
    this.running = true;
    await this.decodePool.decode({ slotId: 'peer-readiness', mode: this.options.config.mode, windowIdx: 0,
      pcm: new Float32Array(this.mode.slotMs * SAMPLE_RATE / 1000).buffer, sampleRate: SAMPLE_RATE,
      timestamp: this.options.now(), windowOffsetMs: 0 });
    await this.encodeReply('readiness', 'CQ BG5DRB OL32', 1000);
    this.lastSlot = Math.floor(this.options.now() / this.mode.slotMs) * this.mode.slotMs;
    await this.trace('session-start', { config: this.options.config, peers: this.scenarioEngine.getSnapshots() });
    this.timer = setInterval(() => {
      const current = Math.floor(this.options.now() / this.mode.slotMs) * this.mode.slotMs;
      if (current < this.lastSlot) { this.options.fail(new Error('Peer clock moved backwards')); return; }
      if (current === this.lastSlot) return;
      const previous = this.lastSlot;
      this.lastSlot = current;
      this.enqueue(async () => {
        if (current - previous > this.mode.slotMs) throw new Error('Peer clock skipped a slot');
        // Other peers hear the actual mixed channel through the same real codec.
        const pcm = this.render(previous, SAMPLE_RATE, this.mode.slotMs * SAMPLE_RATE / 1000);
        if (pcm.some(sample => sample !== 0)) await this.decode(pcm, previous, false);
        if (Math.floor(previous / this.mode.slotMs) % 2 !== this.options.config.transmitCycle) {
          const decisions = this.scenarioEngine.observe([], { advanceReceiveCycle: true });
          await this.scheduleReplies(previous, decisions);
        }
        while (this.scheduledAudio[0] && this.scheduledAudio[0].startMs + this.scheduledAudio[0].samples.length / SAMPLE_RATE * 1000 < current - this.mode.slotMs) this.scheduledAudio.shift();
      });
    }, 10);
  }
  private channelMatches(): boolean {
    const c = this.options.channel();
    return this.running && c.connected && Math.abs(c.frequency - this.options.config.dialFrequencyHz) < 1 && c.mode === this.options.config.mode;
  }
  /** Contribution only; the owning audio input decides where and when to mix it. */
  render(startMs: number, sampleRate: number, count: number): Float32Array {
    const result = new Float32Array(count);
    if (!this.channelMatches()) return result;
    for (const audio of this.scheduledAudio) {
      for (let i = 0; i < count; i++) {
        const position = (startMs + i / sampleRate * 1000 - audio.startMs) * SAMPLE_RATE / 1000;
        if (position < 0 || position >= audio.samples.length) continue;
        const j = Math.floor(position), fraction = position - j;
        result[i] = Math.max(-1, Math.min(1, result[i]! + audio.samples[j]! * (1 - fraction) + (audio.samples[j + 1] ?? 0) * fraction));
      }
    }
    return result;
  }
  observe = (event: TxAudioObservation): void => {
    if (!this.channelMatches() || event.kind !== 'digital') return;
    if (event.phase === 'started') {
      if (this.transmissions.size >= 2) { this.options.fail(new Error('Peer observation backlog exceeded')); return; }
      this.transmissions.set(event.transmissionId, { startMs: event.timestampMs, rate: 0, offset: 0, chunks: [] });
      void this.trace('host-start', { ...event });
      return;
    }
    const tx = this.transmissions.get(event.transmissionId);
    if (!tx) return;
    if (event.phase === 'samples' && event.samples) {
      if ((tx.rate && tx.rate !== event.sampleRate) || tx.offset !== event.sampleOffset || tx.offset + event.samples.length > event.sampleRate * this.mode.slotMs / 1000) {
        this.options.fail(new Error('Peer observed discontinuous or oversized transmission')); return;
      }
      tx.rate = event.sampleRate; tx.offset += event.samples.length; tx.chunks.push(event.samples.slice());
      return;
    }
    if (event.phase === 'completed' || event.phase === 'interrupted') {
      this.transmissions.delete(event.transmissionId);
      this.enqueue(async () => {
        await this.trace('host-end', { ...event });
        if (!tx.offset) throw new Error('Transmission has no observed output');
        const joined = new Float32Array(tx.offset);
        let offset = 0;
        for (const chunk of tx.chunks) { joined.set(chunk, offset); offset += chunk.length; }
        const pcm = tx.rate === SAMPLE_RATE ? joined : await resampleAudioProfessional(joined, tx.rate, SAMPLE_RATE, 1);
        const slot = Math.floor(tx.startMs / this.mode.slotMs) * this.mode.slotMs;
        const window = new Float32Array(this.mode.slotMs * SAMPLE_RATE / 1000);
        const start = Math.max(0, Math.round((tx.startMs - slot) * SAMPLE_RATE / 1000));
        window.set(pcm.subarray(0, window.length - start), start);
        await fs.writeFile(path.join(this.options.artifactDir, `${event.transmissionId}.f32`), Buffer.from(window.buffer));
        await this.decode(window, slot, true);
      });
    }
  };
  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(async () => { if (this.running) await work(); }).catch(error => { if (this.running) this.options.fail(error as Error); });
  }
  private async decode(pcm: Float32Array, slot: number, host: boolean): Promise<void> {
    const result = await this.decodePool.decode({ slotId: `peer-${slot}`, mode: this.options.config.mode, windowIdx: 0,
      pcm: pcm.buffer as ArrayBuffer, sampleRate: SAMPLE_RATE, timestamp: slot, windowOffsetMs: 0 });
    if (!this.running || !this.channelMatches()) return;
    const identities = this.scenarioEngine.getSnapshots();
    const messages = result.frames.map(frame => {
      const sender = FT8MessageParser.parseDecodedSenderCallsign(frame.message);
      return { text: frame.message, audioFrequencyHz: frame.freq, sourcePeerId: host ? undefined : identities.find(p => p.callsign === sender)?.peerId };
    });
    await this.trace(host ? 'host-decode' : 'channel-decode', { slot, messages });
    // Peers never react to their own transmitted identity.
    const decisions = this.scenarioEngine.observe(messages, { advanceReceiveCycle: false });
    await this.scheduleReplies(slot, decisions);
  }
  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    this.cancellation.abort();
    if (this.timer) clearInterval(this.timer);
    this.transmissions.clear();
    this.scheduledAudio.length = 0;
    this.stopPromise = (async () => {
      await Promise.allSettled([this.decodePool.destroy(), this.encodeQueue.destroy()]);
      await this.tail;
      await this.trace('session-stop', { reason });
      await this.traceTail;
    })();
    return this.stopPromise;
  }
  async settle(): Promise<void> { await this.tail; await this.traceTail; }
  getTracePath(): string { return this.tracePath; }
  private async scheduleReplies(sourceSlotStartMs: number, decisions: SimulationReplyDecision[]): Promise<void> {
    const peers = new Map(this.options.config.peers.map((peer) => [peer.id, peer]));
    const grouped = new Map<number, Array<{ peerId: string; audio: Float32Array; frequency: number; timingOffsetMs: number }>>();
    for (const decision of decisions) {
      if (!this.running) return;
      const peer = peers.get(decision.peerId)!;
      const random = this.channelRandom.get(peer.id)!;
      if (random() < peer.dropProbability) {
        await this.trace('reply-dropped', { peerId: peer.id, text: decision.text });
        continue;
      }
      const frequency = decision.audioFrequencyHz + peer.frequencyOffsetHz;
      const encoded = await this.encodeReply(peer.id, decision.text, frequency);
      if (!this.running) return;
      let targetSlotStart = sourceSlotStartMs + this.mode.slotMs * decision.delayCycles;
      if (Math.floor(targetSlotStart / this.mode.slotMs) % 2 !== this.options.config.transmitCycle) targetSlotStart += this.mode.slotMs;
      if (targetSlotStart + this.mode.transmitTiming < this.options.now()) {
        throw new Error('Peer reply missed its transmit slot');
      }
      const entries = grouped.get(targetSlotStart) ?? [];
      entries.push({ peerId: peer.id, audio: encoded.audioData, frequency, timingOffsetMs: peer.timingOffsetMs });
      grouped.set(targetSlotStart, entries);
      await this.trace('reply-encoded', { peerId: peer.id, text: decision.text, frequency, targetSlotStart });
    }
    for (const [targetSlotStart, tracks] of grouped) {
      if (!this.running) return;
      const mixer = new AudioMixer(0);
      const frameId = `simulation-reply-${targetSlotStart}`;
      const earliestOffsetMs = Math.min(...tracks.map((track) => track.timingOffsetMs));
      tracks.forEach((track, index) => mixer.addOperatorAudio(
        track.peerId,
        this.prefixAudio(track.audio, track.timingOffsetMs - earliestOffsetMs, SAMPLE_RATE),
        SAMPLE_RATE,
        targetSlotStart,
        `${frameId}-${index}`,
        0,
        { frameId, frameRevision: 1, slotId: `simulation-${targetSlotStart}`, audioFrequencyHz: track.frequency },
      ));
      const snapshot = mixer.getFrameSnapshot(frameId, 1);
      const mixed = snapshot ? await mixer.mixFrame(snapshot) : null;
      if (!mixed) continue;
      this.scheduledAudio.push({
        startMs: targetSlotStart + (this.mode.transmitTiming ?? 0) + earliestOffsetMs,
        samples: mixed.audioData,
      });
      this.scheduledAudio.sort((left, right) => left.startMs - right.startMs);
      await this.trace('reply-scheduled', { targetSlotStart, tracks: tracks.length, samples: mixed.audioData.length });
    }
  }

  private encodeReply(peerId: string, message: string, frequency: number): Promise<EncodeResult> {
    if (!this.running) return Promise.reject(new Error('virtual radio session is not running'));
    const requestId = `simulation-${this.sessionId}-${randomUUID()}`;
    const request: EncodeRequest = {
      operatorId: `simulation:${peerId}`,
      streamId: peerId,
      requestId,
      message,
      frequency,
      mode: this.mode.name === 'FT4' ? 'FT4' : 'FT8',
    };
    return new Promise<EncodeResult>((resolve, reject) => {
      const completed = (result: EncodeResult & { request?: EncodeRequest }) => {
        if (result.request?.requestId !== requestId) return;
        cleanup();
        resolve(result);
      };
      const failed = (error: Error, failedRequest: EncodeRequest) => {
        if (failedRequest.requestId !== requestId) return;
        cleanup();
        reject(error);
      };
      const cancelled = () => { cleanup(); reject(new Error('Peer encode cancelled')); };
      const cleanup = () => {
        this.cancellation.signal.removeEventListener('abort', cancelled);
        this.encodeQueue.off('encodeComplete', completed);
        this.encodeQueue.off('encodeError', failed);
      };
      this.cancellation.signal.addEventListener('abort', cancelled, { once: true });
      this.encodeQueue.on('encodeComplete', completed);
      this.encodeQueue.on('encodeError', failed);
      void this.encodeQueue.push(request);
    });
  }

  private prefixAudio(audio: Float32Array, timingOffsetMs: number, sampleRate: number): Float32Array {
    const offsetSamples = Math.max(0, Math.round(timingOffsetMs / 1_000 * sampleRate));
    if (offsetSamples === 0) return audio;
    const shifted = new Float32Array(audio.length + offsetSamples);
    shifted.set(audio, offsetSamples);
    return shifted;
  }


  private trace(kind: string, data: unknown = {}): Promise<void> {
    const write = this.traceTail.then(() => fs.appendFile(this.tracePath, `${JSON.stringify({ at: this.options.now(), kind, data })}\n`));
    this.traceTail = write.catch(error => { if (this.running) this.options.fail(error as Error); });
    return write;
  }
}
