import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { StationTestRun } from '@tx5dr/contracts';
import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
import type { RttyDecodeEvent } from 'rasterwave-node';
import type { TxAudioObservation } from '../audio/TxAudioObservation.js';
import { SimulationScenarioEngine, type SimulationReplyDecision } from './SimulationScenarioEngine.js';

const require = createRequire(import.meta.url);
const SAMPLE_RATE = 12_000;
/** Pause between the station unkeying and the peer answering. */
const TURNAROUND_MS = 1_200;
/** Without station transmissions, a receive cycle elapses after this much silence. */
const QUIET_CYCLE_MS = 8_000;
/** Peer RTTY uses the amateur default: 45.45 baud, 170 Hz, mark below space on LSB. */
const PEER_SHIFT_HZ = 170;
const MAX_OBSERVED_SECONDS = 120;

interface ScheduledAudio { startMs: number; samples: Float32Array }

export interface RttyPeerSessionOptions {
  config: Pick<StationTestRun, 'mode' | 'dialFrequencyHz' | 'seed' | 'peers'>;
  artifactDir: string;
  scenarios: SimulationScenarioDescriptor[];
  now: () => number;
  channel: () => { connected: boolean; frequency: number; mode: string };
  fail: (error: Error) => void;
}

interface ObservedTransmission {
  startMs: number;
  rate: number;
  offset: number;
  chunks: Float32Array[];
}

/** Collapses whitespace and line breaks so scenario patterns see one line per transmission. */
export function normalizeRttyMessage(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * Keyboard-mode counterpart of `PeerSession` for RTTY station tests.
 *
 * The peer decodes each observed station transmission with the real native
 * decoder, advances the declarative scenario with the decoded text and answers
 * with audio from the real native encoder. A receive cycle is one complete
 * station transmission or {@link QUIET_CYCLE_MS} of silence (8 s).
 */
export class RttyPeerSession {
  readonly sessionId = randomUUID();
  private readonly scenarioEngine: SimulationScenarioEngine;
  private readonly codec = require('rasterwave-node') as typeof import('rasterwave-node');
  private readonly transmissions = new Map<string, ObservedTransmission>();
  private readonly scheduledAudio: ScheduledAudio[] = [];
  private readonly tracePath: string;
  private running = false;
  private stopPromise?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private tail: Promise<void> = Promise.resolve();
  private traceTail: Promise<void> = Promise.resolve();
  private lastActivityMs = 0;
  private stationTransmitting = false;

  constructor(private readonly options: RttyPeerSessionOptions) {
    if (options.config.mode !== 'RTTY') throw new Error('RttyPeerSession only simulates RTTY');
    this.tracePath = path.join(options.artifactDir, 'peer.jsonl');
    const scenarios = new Map(options.scenarios.map((scenario) => [scenario.id, scenario]));
    this.scenarioEngine = new SimulationScenarioEngine(options.config.seed, options.config.peers.map((peer) => {
      const scenario = scenarios.get(peer.scenarioId);
      if (!scenario || !scenario.modes.includes('RTTY')) throw new Error(`Peer scenario unavailable: ${peer.scenarioId}`);
      if (peer.identityPool && !scenario.identityPool?.length) throw new Error('Scenario has no identity pool');
      return { ...peer, scenario, identityPool: peer.identityPool === 'scenario' ? scenario.identityPool : undefined };
    }), (event) => { void this.trace('scenario', event); });
  }

  async start(): Promise<void> {
    if (this.running || this.stopPromise) throw new Error('Peer session cannot be restarted');
    await fs.mkdir(path.dirname(this.tracePath), { recursive: true });
    this.running = true;
    this.lastActivityMs = this.options.now();
    await this.trace('session-start', { config: this.options.config, peers: this.scenarioEngine.getSnapshots() });
    this.timer = setInterval(() => {
      const now = this.options.now();
      if (this.stationTransmitting || this.isPeerTransmitting(now) || now - this.lastActivityMs < QUIET_CYCLE_MS) return;
      this.lastActivityMs = now;
      this.enqueue(async () => {
        const decisions = this.scenarioEngine.observe([], { advanceReceiveCycle: true });
        await this.scheduleReplies(decisions, this.options.now());
      });
    }, 250);
  }

  private channelMatches(): boolean {
    const channel = this.options.channel();
    return this.running && channel.connected && channel.mode === 'RTTY'
      && Math.abs(channel.frequency - this.options.config.dialFrequencyHz) < 1;
  }

  private isPeerTransmitting(now: number): boolean {
    return this.scheduledAudio.some((audio) => now < audio.startMs + audio.samples.length / SAMPLE_RATE * 1000);
  }

  /** Contribution to the station's receive audio; the audio owner decides where to mix it. */
  render(startMs: number, sampleRate: number, count: number): Float32Array {
    const result = new Float32Array(count);
    if (!this.channelMatches()) return result;
    for (const audio of this.scheduledAudio) {
      for (let i = 0; i < count; i += 1) {
        const position = (startMs + i / sampleRate * 1000 - audio.startMs) * SAMPLE_RATE / 1000;
        if (position < 0 || position >= audio.samples.length) continue;
        const j = Math.floor(position);
        const fraction = position - j;
        const value = audio.samples[j]! * (1 - fraction) + (audio.samples[j + 1] ?? 0) * fraction;
        result[i] = Math.max(-1, Math.min(1, result[i]! + value));
      }
    }
    return result;
  }

  observe = (event: TxAudioObservation): void => {
    if (!this.channelMatches() || event.kind !== 'rtty') return;
    if (event.phase === 'started') {
      if (this.transmissions.size >= 2) { this.options.fail(new Error('Peer observation backlog exceeded')); return; }
      this.stationTransmitting = true;
      this.transmissions.set(event.transmissionId, { startMs: event.timestampMs, rate: 0, offset: 0, chunks: [] });
      void this.trace('host-start', { ...event, samples: undefined });
      return;
    }
    const tx = this.transmissions.get(event.transmissionId);
    if (!tx) return;
    if (event.phase === 'samples' && event.samples) {
      if ((tx.rate && tx.rate !== event.sampleRate) || tx.offset !== event.sampleOffset
        || tx.offset + event.samples.length > event.sampleRate * MAX_OBSERVED_SECONDS) {
        this.options.fail(new Error('Peer observed discontinuous or oversized transmission'));
        return;
      }
      tx.rate = event.sampleRate;
      tx.offset += event.samples.length;
      tx.chunks.push(event.samples.slice());
      return;
    }
    if (event.phase === 'completed' || event.phase === 'interrupted') {
      this.transmissions.delete(event.transmissionId);
      this.stationTransmitting = this.transmissions.size > 0;
      const endedAt = this.options.now();
      this.lastActivityMs = endedAt;
      this.enqueue(async () => {
        await this.trace('host-end', { ...event, samples: undefined });
        if (!tx.offset) throw new Error('Transmission has no observed output');
        const pcm = new Float32Array(tx.offset);
        let offset = 0;
        for (const chunk of tx.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
        await fs.writeFile(path.join(this.options.artifactDir, `${event.transmissionId}.f32`), Buffer.from(pcm.buffer));
        const text = await this.decode(pcm, tx.rate);
        if (!this.running || !this.channelMatches()) return;
        const message = normalizeRttyMessage(text);
        await this.trace('host-decode', { messages: message ? [{ text: message }] : [] });
        const decisions = this.scenarioEngine.observe(
          message ? [{ text: message, audioFrequencyHz: 0 }] : [],
          { advanceReceiveCycle: true },
        );
        await this.scheduleReplies(decisions, endedAt);
      });
    }
  };

  private async decode(pcm: Float32Array, sampleRate: number): Promise<string> {
    const characters: string[] = [];
    const decoder = new this.codec.RttyDecoder(sampleRate, { squelch: 0.25 }, (event: RttyDecodeEvent) => {
      if (event.type === 'character') characters.push(event.ch);
    });
    try {
      const padded = new Float32Array(pcm.length + sampleRate);
      padded.set(pcm, Math.round(sampleRate / 4));
      const frame = Math.round(sampleRate / 10);
      for (let offset = 0; offset < padded.length; offset += frame) {
        while (!decoder.pushF32(padded.subarray(offset, offset + frame))) await decoder.drain();
      }
      await decoder.finish();
    } finally {
      await decoder.dispose().catch(() => undefined);
    }
    return characters.join('');
  }

  private async scheduleReplies(decisions: SimulationReplyDecision[], referenceMs: number): Promise<void> {
    const peers = new Map(this.options.config.peers.map((peer) => [peer.id, peer]));
    let startMs = Math.max(referenceMs + TURNAROUND_MS, this.options.now() + 200);
    for (const decision of decisions) {
      if (!this.running) return;
      const peer = peers.get(decision.peerId)!;
      const center = peer.audioFrequencyHz + peer.frequencyOffsetHz;
      const encoder = new this.codec.RttyEncoder(SAMPLE_RATE, {
        markHz: center - PEER_SHIFT_HZ / 2,
        spaceHz: center + PEER_SHIFT_HZ / 2,
        shiftHz: PEER_SHIFT_HZ,
      });
      encoder.pushText(`\n${decision.text}\n`);
      encoder.finish();
      const chunks: Float32Array[] = [];
      let total = 0;
      while (!encoder.isFinished) {
        const read = encoder.readSamples(SAMPLE_RATE);
        chunks.push(read.samples);
        total += read.samples.length;
      }
      encoder.dispose();
      const samples = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
      applyChannelNoise(samples, peer.channelSnrDb, `${this.options.config.seed}:${peer.id}:${startMs}`);
      this.scheduledAudio.push({ startMs, samples });
      this.scheduledAudio.sort((left, right) => left.startMs - right.startMs);
      this.lastActivityMs = startMs + total / SAMPLE_RATE * 1000;
      await this.trace('reply-scheduled', { peerId: peer.id, text: decision.text, startMs, samples: total });
      startMs += total / SAMPLE_RATE * 1000 + 500;
    }
    const now = this.options.now();
    while (this.scheduledAudio[0] && this.scheduledAudio[0].startMs + this.scheduledAudio[0].samples.length / SAMPLE_RATE * 1000 < now - 5_000) {
      this.scheduledAudio.shift();
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(async () => { if (this.running) await work(); })
      .catch((error) => { if (this.running) this.options.fail(error as Error); });
  }

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.transmissions.clear();
    this.scheduledAudio.length = 0;
    this.stopPromise = (async () => {
      await this.tail;
      await this.trace('session-stop', { reason });
      await this.traceTail;
    })();
    return this.stopPromise;
  }

  async settle(): Promise<void> { await this.tail; await this.traceTail; }
  getTracePath(): string { return this.tracePath; }

  private trace(kind: string, data: unknown = {}): Promise<void> {
    const write = this.traceTail.then(() => fs.appendFile(this.tracePath, `${JSON.stringify({ at: this.options.now(), kind, data })}\n`));
    this.traceTail = write.catch((error) => { if (this.running) this.options.fail(error as Error); });
    return write;
  }
}

/**
 * Adds seeded white noise so the signal-to-noise ratio in a 3 kHz bandwidth
 * equals `snrDb` (channel impairment at the external boundary).
 */
function applyChannelNoise(samples: Float32Array, snrDb: number | undefined, seed: string): void {
  if (snrDb === undefined || samples.length === 0) return;
  let power = 0;
  for (const sample of samples) power += sample * sample;
  power /= samples.length;
  const sigma = Math.sqrt(power / 10 ** (snrDb / 10) * SAMPLE_RATE / 2 / 3_000);
  let state = 2166136261;
  for (let index = 0; index < seed.length; index += 1) state = Math.imul(state ^ seed.charCodeAt(index), 16777619);
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (((value ^ (value >>> 14)) >>> 0) + 1) / 4294967297;
  };
  for (let index = 0; index < samples.length; index += 2) {
    const radius = Math.sqrt(-2 * Math.log(uniform())) * sigma;
    const angle = 2 * Math.PI * uniform();
    samples[index] = samples[index]! + radius * Math.cos(angle);
    if (index + 1 < samples.length) samples[index + 1] = samples[index + 1]! + radius * Math.sin(angle);
  }
}
