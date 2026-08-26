import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DecodeRequest, ModeDescriptor } from '@tx5dr/contracts';
import type { AudioPlaybackReadiness, PlaybackKind, PlayAudioOptions, StopPlaybackOptions } from '../audio/AudioStreamManager.js';
import { AudioMixer } from '../audio/AudioMixer.js';
import { WSJTXDecodeProcessPool } from '../decode/WSJTXDecodeProcessPool.js';
import { WSJTXEncodeWorkQueue, type EncodeRequest, type EncodeResult } from '../decode/WSJTXEncodeWorkQueue.js';
import type { VirtualRadioProfile } from '../config/virtualRadioProfile.js';
import type { SimulationScenarioDescriptor } from '@tx5dr/plugin-api';
import { createLogger } from '../utils/logger.js';
import {
  SimulationScenarioEngine,
  type SimulationDecodedMessage,
  type SimulationReplyDecision,
} from './SimulationScenarioEngine.js';

const logger = createLogger('VirtualRadioSession');
const SAMPLE_RATE = 12_000;
const PUMP_MS = 100;

interface ScheduledAudio {
  startMs: number;
  samples: Float32Array;
}

export interface VirtualRadioSessionOptions {
  profile: VirtualRadioProfile;
  scenarios: SimulationScenarioDescriptor[];
  mode: ModeDescriptor;
  dataDir: string;
  now: () => number;
  getOutputGain: () => number;
  ingestInput: (samples: Float32Array, sampleRate: number) => Promise<void>;
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

export class VirtualRadioSession {
  private readonly decodePool = new WSJTXDecodeProcessPool({ workerCount: 1 });
  private readonly encodeQueue = new WSJTXEncodeWorkQueue(1);
  private readonly scenarioEngine: SimulationScenarioEngine;
  private readonly channelRandom = new Map<string, () => number>();
  private readonly scheduledAudio: ScheduledAudio[] = [];
  private readonly scheduledPeerMessages = new Map<number, SimulationDecodedMessage[]>();
  private lastAdvancedSimulationSlot?: number;
  private pumpTimer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private playing = false;
  private playbackKind: PlaybackKind | null = null;
  private playbackStartedAt = 0;
  private playbackTimer: NodeJS.Timeout | null = null;
  private rejectPlayback: ((error: Error) => void) | null = null;
  private activeHostMonitorAudio?: ScheduledAudio;
  private traceTail: Promise<void> = Promise.resolve();
  private readonly sessionId = randomUUID();
  private readonly tracePath: string;

  constructor(private readonly options: VirtualRadioSessionOptions) {
    const byId = new Map(options.scenarios.map((scenario) => [scenario.id, scenario]));
    const peers = options.profile.radio.virtual.peers.map((peer) => ({
      id: peer.id,
      callsign: peer.callsign,
      grid: peer.grid,
      audioFrequencyHz: peer.audioFrequencyHz,
      scenario: byId.get(peer.scenarioId)!,
    }));
    this.scenarioEngine = new SimulationScenarioEngine(
      options.profile.radio.virtual.seed,
      peers,
      (event) => this.trace('scenario', event),
    );
    for (const peer of options.profile.radio.virtual.peers) {
      this.channelRandom.set(peer.id, seededRandom(hashSeed(`${String(options.profile.radio.virtual.seed)}\u0000channel\u0000${peer.id}`)));
    }
    this.tracePath = path.join(
      options.dataDir,
      'simulation',
      options.profile.id.replace(/[^A-Za-z0-9._-]/g, '_'),
      'traces',
      `${this.sessionId}.jsonl`,
    );
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stopped) throw new Error('virtual radio session has been stopped');
    await fs.mkdir(path.dirname(this.tracePath), { recursive: true });
    this.running = true;
    await this.trace('session-start', {
      sessionId: this.sessionId,
      profileId: this.options.profile.id,
      mode: this.options.mode.name,
      seed: this.options.profile.radio.virtual.seed,
      peers: this.options.profile.radio.virtual.peers,
    });
    this.pumpTimer = setInterval(() => { void this.pumpInput(); }, PUMP_MS);
    await this.pumpInput();
    logger.info('virtual radio session started', { sessionId: this.sessionId, tracePath: this.tracePath });
  }

  async stop(reason = 'virtual radio stopped'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    await this.stopCurrentPlayback();
    this.scheduledAudio.length = 0;
    this.scheduledPeerMessages.clear();
    await Promise.allSettled([this.decodePool.destroy(), this.encodeQueue.destroy()]);
    await this.trace('session-stop', { reason });
    await this.traceTail;
    logger.info('virtual radio session stopped', { sessionId: this.sessionId, reason });
  }

  getTracePath(): string { return this.tracePath; }
  isPlaying(kind?: PlaybackKind): boolean { return this.playing && (!kind || kind === this.playbackKind); }

  getAudioPlaybackReadiness(_kind: PlaybackKind): AudioPlaybackReadiness {
    return this.running
      ? { ready: true, waitedForDrain: false, streamGeneration: 1 }
      : { ready: false, waitedForDrain: false, reason: 'virtual radio session is not running' };
  }

  async prepareAudioPlayback(kind: PlaybackKind): Promise<AudioPlaybackReadiness> {
    return this.getAudioPlaybackReadiness(kind);
  }

  async stopCurrentPlayback(options: StopPlaybackOptions = {}): Promise<number> {
    if (!this.playing || (options.kind && options.kind !== this.playbackKind)) return 0;
    const elapsed = Math.max(0, this.options.now() - this.playbackStartedAt);
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.playbackTimer = null;
    this.removeActiveHostMonitorAudio();
    this.rejectPlayback?.(new Error('playback interrupted'));
    this.rejectPlayback = null;
    this.playing = false;
    this.playbackKind = null;
    return elapsed;
  }

  async playAudio(audioData: Float32Array, sampleRate: number, options: PlayAudioOptions = {}): Promise<void> {
    if (!this.running) throw new Error('virtual radio session is not running');
    if (this.playing) throw new Error('virtual radio output is busy');
    const playbackKind = options.playbackKind ?? 'digital';
    this.playing = true;
    this.playbackKind = playbackKind;
    this.playbackStartedAt = this.options.now();
    const playbackStartedAt = this.playbackStartedAt;

    const gained = new Float32Array(audioData.length);
    const gain = this.options.getOutputGain();
    for (let index = 0; index < audioData.length; index += 1) {
      gained[index] = Math.max(-1, Math.min(1, audioData[index]! * gain));
    }
    if (sampleRate === SAMPLE_RATE) {
      this.activeHostMonitorAudio = {
        startMs: playbackStartedAt,
        samples: gained,
      };
      this.scheduledAudio.push(this.activeHostMonitorAudio);
      this.scheduledAudio.sort((left, right) => left.startMs - right.startMs);
    }
    const durationMs = Math.max(0, Math.round(gained.length / sampleRate * 1_000));
    const playbackCompletion = new Promise<void>((resolve, reject) => {
      this.rejectPlayback = reject;
      this.playbackTimer = setTimeout(resolve, durationMs);
    });
    void playbackCompletion.catch(() => undefined);
    options.onPlaybackStarted?.();
    options.onPlaybackChunk?.(gained, sampleRate);
    await this.trace('host-playback', { playbackKind, sampleRate, samples: gained.length, gain });

    let completed = false;
    try {
      await playbackCompletion;
      completed = true;
    } finally {
      this.playbackTimer = null;
      this.rejectPlayback = null;
      this.playing = false;
      this.playbackKind = null;
      this.activeHostMonitorAudio = undefined;
    }
    if (completed && playbackKind === 'digital' && this.running) {
      void this.decodeHostTransmission(gained, sampleRate, playbackStartedAt).catch((error) => {
        logger.warn('virtual peer decode failed', { error: (error as Error).message });
        void this.trace('decode-error', { error: (error as Error).message });
      });
    }
  }

  private async decodeHostTransmission(
    audio: Float32Array,
    sampleRate: number,
    transmissionStartMs = this.options.now(),
  ): Promise<void> {
    if (sampleRate !== SAMPLE_RATE) {
      throw new Error(`virtual radio digital playback requires ${SAMPLE_RATE} Hz audio, received ${sampleRate} Hz`);
    }
    const now = transmissionStartMs;
    const slotMs = this.options.mode.slotMs;
    const slotStartMs = Math.floor(now / slotMs) * slotMs;
    const slotSamples = Math.round(slotMs / 1_000 * SAMPLE_RATE);
    const buffer = new Float32Array(slotSamples);
    const offsetSamples = Math.max(0, Math.round((now - slotStartMs) / 1_000 * SAMPLE_RATE));
    buffer.set(audio.subarray(0, Math.max(0, slotSamples - offsetSamples)), offsetSamples);
    const request: DecodeRequest = {
      slotId: `simulation-${slotStartMs}`,
      mode: this.options.mode.name === 'FT4' ? 'FT4' : 'FT8',
      windowIdx: 0,
      pcm: buffer.buffer,
      sampleRate: SAMPLE_RATE,
      timestamp: now,
      windowOffsetMs: 0,
    };
    const decoded = await this.decodePool.decode(request);
    if (!this.running) return;
    const messages = decoded.frames.map((frame) => ({ text: frame.message, audioFrequencyHz: frame.freq }));
    await this.trace('host-decode', { slotStartMs, messages });
    const decisions = this.scenarioEngine.observe(messages, { advanceReceiveCycle: false });
    await this.scheduleReplies(slotStartMs, decisions);
  }

  private async scheduleReplies(sourceSlotStartMs: number, decisions: SimulationReplyDecision[]): Promise<void> {
    const peers = new Map(this.options.profile.radio.virtual.peers.map((peer) => [peer.id, peer]));
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
      const targetSlotStart = sourceSlotStartMs + this.options.mode.slotMs * decision.delayCycles;
      const entries = grouped.get(targetSlotStart) ?? [];
      entries.push({ peerId: peer.id, audio: encoded.audioData, frequency, timingOffsetMs: peer.timingOffsetMs });
      grouped.set(targetSlotStart, entries);
      const scheduledMessages = this.scheduledPeerMessages.get(targetSlotStart) ?? [];
      scheduledMessages.push({
        text: decision.text,
        audioFrequencyHz: frequency,
        sourcePeerId: peer.id,
      });
      this.scheduledPeerMessages.set(targetSlotStart, scheduledMessages);
      await this.trace('reply-encoded', { peerId: peer.id, text: decision.text, frequency, targetSlotStart });
    }
    for (const [targetSlotStart, tracks] of grouped) {
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
        startMs: targetSlotStart + (this.options.mode.transmitTiming ?? 0) + earliestOffsetMs,
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
      mode: this.options.mode.name === 'FT4' ? 'FT4' : 'FT8',
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
      const cleanup = () => {
        this.encodeQueue.off('encodeComplete', completed);
        this.encodeQueue.off('encodeError', failed);
      };
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

  private async pumpInput(): Promise<void> {
    if (!this.running) return;
    const endMs = this.options.now();
    await this.advanceSimulationClock(endMs);
    const chunkSamples = Math.round(SAMPLE_RATE * PUMP_MS / 1_000);
    const startMs = endMs - PUMP_MS;
    const chunk = new Float32Array(chunkSamples);
    for (const scheduled of this.scheduledAudio) {
      const scheduledEnd = scheduled.startMs + scheduled.samples.length / SAMPLE_RATE * 1_000;
      if (scheduledEnd <= startMs || scheduled.startMs >= endMs) continue;
      const chunkStart = Math.max(0, Math.floor((scheduled.startMs - startMs) / 1_000 * SAMPLE_RATE));
      const sourceStart = Math.max(0, Math.floor((startMs - scheduled.startMs) / 1_000 * SAMPLE_RATE));
      const count = Math.min(chunk.length - chunkStart, scheduled.samples.length - sourceStart);
      for (let index = 0; index < count; index += 1) {
        chunk[chunkStart + index] = Math.max(-1, Math.min(1, chunk[chunkStart + index]! + scheduled.samples[sourceStart + index]!));
      }
    }
    for (let index = this.scheduledAudio.length - 1; index >= 0; index -= 1) {
      const scheduled = this.scheduledAudio[index]!;
      if (scheduled.startMs + scheduled.samples.length / SAMPLE_RATE * 1_000 <= endMs) {
        if (scheduled === this.activeHostMonitorAudio) this.activeHostMonitorAudio = undefined;
        this.scheduledAudio.splice(index, 1);
      }
    }
    await this.options.ingestInput(chunk, SAMPLE_RATE);
  }

  private async advanceSimulationClock(now: number): Promise<void> {
    const slotMs = this.options.mode.slotMs;
    const currentSlotStart = Math.floor(now / slotMs) * slotMs;
    let lastSlot = this.lastAdvancedSimulationSlot;
    if (lastSlot === undefined || currentSlotStart - lastSlot > slotMs * 4) {
      lastSlot = currentSlotStart - slotMs;
    }
    while (lastSlot < currentSlotStart) {
      const slotStart: number = lastSlot + slotMs;
      lastSlot = slotStart;
      this.lastAdvancedSimulationSlot = lastSlot;
      const messages = this.scheduledPeerMessages.get(slotStart) ?? [];
      this.scheduledPeerMessages.delete(slotStart);
      const decisions = this.scenarioEngine.observe(messages, { advanceReceiveCycle: true });
      await this.trace('simulation-cycle', {
        slotStartMs: slotStart,
        messages: messages.map((message) => ({
          text: message.text,
          audioFrequencyHz: message.audioFrequencyHz,
          sourcePeerId: message.sourcePeerId,
        })),
        replies: decisions.length,
      });
      await this.scheduleReplies(slotStart, decisions);
    }
  }

  private removeActiveHostMonitorAudio(): void {
    const scheduled = this.activeHostMonitorAudio;
    if (!scheduled) return;
    const index = this.scheduledAudio.indexOf(scheduled);
    if (index >= 0) this.scheduledAudio.splice(index, 1);
    this.activeHostMonitorAudio = undefined;
  }

  private trace(kind: string, data: unknown = {}): Promise<void> {
    const line = `${JSON.stringify({ at: this.options.now(), kind, data })}\n`;
    this.traceTail = this.traceTail.then(() => fs.appendFile(this.tracePath, line, 'utf8')).catch((error) => {
      logger.warn('virtual radio trace write failed', { error: (error as Error).message, tracePath: this.tracePath });
    });
    return this.traceTail;
  }
}
