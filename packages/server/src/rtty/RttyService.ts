import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'eventemitter3';
import {
  resolveRttyAudioTones,
  type RttyConfig,
  type RttyDecoderEvent,
  type RttyDecoderStatus,
  type RttyReceivedCharacter,
  type RttyScanUpdate,
  type RttySignal,
  type RttyTxStatus,
} from '@tx5dr/contracts';
import type { RttyDecodeEvent, RttyDecoder, RttyEncoder } from 'rasterwave-node';
import type { DeterministicPlaybackSession, PlayAudioOptions } from '../audio/AudioStreamManager.js';
import type { PhysicalTxLeaseRequest, PhysicalTxResult } from '../transmission/PhysicalTxCoordinator.js';
import { createLogger } from '../utils/logger.js';
import { rttyCodecRuntime, type RttyCodecRuntime } from './RttyCodecRuntime.js';
import { RttyChannelScan } from './RttyChannelScan.js';

const logger = createLogger('RttyService');

/** Audio kept ahead of playback while streaming; text behind it stays editable. */
const LOOKAHEAD_MS = 250;
const STREAM_TICK_MS = 20;
const INPUT_CHUNK_MS = 100;
const NATIVE_QUEUE_SECONDS = 2;
const JS_BACKLOG_MS = 500;
const CHARACTER_FLUSH_MS = 100;
const SIGNAL_EMIT_MS = 250;
const SENT_TEXT_LIMIT = 2_000;
const TIME_ANCHOR_LIMIT = 128;
const DECODER_RESTART_DELAY_MS = 1_000;
/** Received audio kept for re-decoding after a tuning or settings change. */
const HISTORY_SECONDS = 60;
/** Received characters of the current transcript kept for clients that join late. */
const TRANSCRIPT_SNAPSHOT_LIMIT = 4_000;
/** Decoder AFC range (rasterwave default); an offset near it means the tones are off the signal. */
const AFC_RANGE_HZ = 50;
/** Window and minimum count of decoded characters behind the lock/quality indicator. */
const QUALITY_WINDOW_MS = 6_000;
const QUALITY_MIN_CHARACTERS = 4;
const LOCK_QUALITY = 0.45;
/** Both tones must be this far above the noise and this close to each other when tuned. */
const LOCK_MIN_TONE_DB = 3;
const LOCK_MAX_TONE_IMBALANCE_DB = 15;
/** Displayed SNR range and smoothing: raw estimates swing widely without a signal. */
const SNR_MIN_DB = -30;
const SNR_MAX_DB = 60;
const SNR_SMOOTHING = 0.3;
/** A replay is shown only if this share of its characters was decoded locked on both tones... */
const REPLAY_MIN_LOCKED_RATIO = 0.5;
/** ...it decoded at least this many characters... */
const REPLAY_MIN_CHARACTERS = 6;
/** ...and its words differ from what is already shown. */
const REPLAY_SAME_TEXT_SIMILARITY = 0.7;
/** Upper bound of automatic repeats (e.g. about 15 minutes of CQ at an 8 s interval). */
const MAX_REPEAT_RUNS = 100;
/** A confident received character after a repeated message means someone answered. */
const ANSWER_CONFIDENCE = 0.6;

export interface RttyAudioStream {
  on(event: 'audioData', listener: (samples: Float32Array, sampleRate: number) => void): unknown;
  off(event: 'audioData', listener: (samples: Float32Array, sampleRate: number) => void): unknown;
  getInternalSampleRate(): number;
  openDeterministicPlayback(options: PlayAudioOptions & { playbackKind: 'rtty' }): DeterministicPlaybackSession;
}

export interface RttyPhysicalTx {
  acquireLease(request: PhysicalTxLeaseRequest): Promise<string>;
  markStreamingLeaseActive(leaseId: string): void;
  markStreamingLeaseDraining(leaseId: string): void;
  releaseLease(leaseId: string, reason: string): Promise<PhysicalTxResult>;
  forceInterruptLease(leaseId: string, reason: string): Promise<PhysicalTxResult | null>;
}

export interface RttyServiceOptions {
  audioStream: RttyAudioStream;
  physicalTx: RttyPhysicalTx;
  getConfig: () => RttyConfig;
  /** Dial frequency of the radio, or null when there is no radio (local playback). */
  getFrequency: () => number | null;
  /** False while a configured radio is disconnected; RTTY then cannot transmit. */
  isRadioReady?: () => boolean;
  codec?: RttyCodecRuntime;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Timer for the automatic repeat; returns a cancel function. */
  schedule?: (callback: () => void, ms: number) => () => void;
}

/** Upper bound of text waiting for a later transmission (prepared audio paths). */
const DEFERRED_TEXT_LIMIT = 2_000;

interface RepeatState {
  clientId: string;
  label: string;
  messageId: string;
  intervalSec: number;
  text: string;
  operatorId?: string;
  nextRunAt: number | null;
  cancelTimer: (() => void) | null;
  /** Dial frequency the loop was started on; any change ends it. */
  frequency: number | null;
  runs: number;
  /** Received activity before this time does not count as an answer. */
  quietSince: number;
}

export interface RttyRepeatRequest {
  clientId: string;
  label: string;
  messageId: string;
  intervalSec: number;
  /** Resolved message text; `{RX}` is implied. */
  text: string;
  operatorId?: string;
}

export interface RttyAppendOptions {
  /** Start a transmission when none is active (default true). */
  start?: boolean;
  /** End the transmission after this text. `{RX}` in the text has the same effect. */
  finishAfter?: boolean;
  messageId?: string | null;
  /** Operator on whose behalf the client transmits; recorded on the physical lease. */
  operatorId?: string;
  /** Internal: the automatic repeat sends this; any other text cancels the repeat. */
  fromRepeat?: boolean;
}

interface CommittedCharacter {
  ch: string;
  endSample: number;
}

interface TxSession {
  sessionId: string;
  clientId: string;
  label: string;
  operatorIds: string[];
  messageId: string | null;
  startedAt: number;
  expectedFrequency: number | null;
  encoder: RttyEncoder | null;
  playback: DeterministicPlaybackSession | null;
  leaseId: string | null;
  /** Text typed before the encoder exists. */
  pendingBeforeEncoder: string;
  committed: CommittedCharacter[];
  sentText: string;
  consumedSamples: number;
  streaming: boolean;
  finishRequested: boolean;
  aborted: boolean;
  abortError: string | null;
}

/** A recorded receive chunk; `gapBefore` counts samples muted or lost before it. */
interface HistoryChunk {
  /** Increasing per recorded chunk, so a replay can catch up with newer audio. */
  seq: number;
  samples: Float32Array;
  endTime: number;
  gapBefore: number;
}

/** Settings whose change makes earlier text worth decoding again. */
const REDECODE_FIELDS: Array<keyof RttyConfig> = [
  // Not `sideband`: with CAT it retunes the radio, so earlier audio was received on the old sideband.
  'baud', 'shiftHz', 'stopBits', 'centerHz', 'reverse', 'characterSet', 'usos', 'squelch', 'noiseBlanker',
];

type ReplayOutcome = 'replayed' | 'superseded' | 'skipped';

export interface RttyServiceTelemetry {
  rx: {
    state: RttyDecoderStatus['state'];
    sampleRate: number | null;
    historySeconds: number;
    samplesDecoded: number;
    samplesLost: number;
    overruns: number;
    restarts: number;
    replays: number;
    lastReplayMs: number | null;
    backlogChunks: number;
    nativeQueuedSamples: number;
    scannerChannels: number;
    scannerDroppedChunks: number;
  };
  tx: {
    phase: RttyTxStatus['phase'];
    sessions: number;
    errors: number;
    lastError: string | null;
  };
}

interface RxState {
  decoder: RttyDecoder;
  sampleRate: number;
  generation: number;
  chunk: Float32Array;
  chunkOffset: number;
  backlog: Float32Array[];
  draining: boolean;
  /** Input samples handed to the decoder, including samples declared lost. */
  cursor: number;

  pendingDropped: number;
  anchors: Array<{ endSample: number; time: number }>;
  characters: RttyReceivedCharacter[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  lastWasCarriageReturn: boolean;
  /** Tones the decoder currently listens on (may differ from saved config while previewing). */
  appliedMark: number;
  appliedSpace: number;
}

export interface RttyServiceEvents {
  txStatus: (status: RttyTxStatus) => void;
  decoderStatus: (status: RttyDecoderStatus) => void;
  scanUpdate: (update: RttyScanUpdate) => void;
  decoderEvent: (event: RttyDecoderEvent) => void;
}

/**
 * Owns RTTY transmit sessions and receive decoding while the RTTY engine mode
 * is active.
 *
 * Transmit streams AFSK through a deterministic playback session: typed text
 * is pushed into the encoder, at most {@link LOOKAHEAD_MS} of audio is queued
 * ahead of playback, and characters move from pending to committed to sent as
 * the sink consumes them. Any failure, an interruption by the transmission
 * coordinator, the owner disconnecting or the configured maximum duration ends
 * the transmission immediately (fail closed).
 */
export class RttyService extends EventEmitter<RttyServiceEvents> {
  private readonly codec: RttyCodecRuntime;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private session: TxSession | null = null;
  private sessionRun: Promise<void> | null = null;
  private deferredText = '';
  private deferredOwner: { clientId: string; label: string; operatorId?: string; messageId?: string | null } | null = null;
  private lastText: string | null = null;
  private txError: string | null = null;
  private txRevision = 0;
  private rx: RxState | null = null;
  private rxGeneration = 0;
  private rxSessionId = randomUUID();
  private rxSequence = 0;
  private rxError: string | null = null;
  private signal: RttySignal | null = null;
  private lastSignalEmit = 0;
  private history: HistoryChunk[] = [];
  private historySamples = 0;
  private historyRate = 0;
  private historySeq = 0;
  private historyGap = 0;
  private replayToken = 0;
  /** Set while a replay decoder catches up; the old decoder's text is then discarded. */
  private replay: { token: number } | null = null;
  private readonly counters = {
    samplesDecoded: 0,
    samplesLost: 0,
    overruns: 0,
    restarts: 0,
    replays: 0,
    lastReplayMs: null as number | null,
    txSessions: 0,
    txErrors: 0,
  };
  private readonly scan: RttyChannelScan;
  private readonly schedule: (callback: () => void, ms: number) => () => void;
  private repeat: RepeatState | null = null;
  private lastAnswerAt = 0;
  private recentQuality: Array<{ at: number; confidence: number }> = [];
  private smoothedSnr: number | null = null;
  private heldQuality = 0;
  private transcriptSnapshot: RttyReceivedCharacter[] = [];
  private readonly audioListener = (samples: Float32Array, sampleRate: number) => this.acceptAudio(samples, sampleRate);

  constructor(private readonly options: RttyServiceOptions) {
    super();
    this.codec = options.codec ?? rttyCodecRuntime;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.schedule = options.schedule ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    });
    this.scan = new RttyChannelScan(this.codec, this.now);
    this.scan.on('update', (update) => this.emit('scanUpdate', update));
  }

  /** Signal browser state. */
  getScanUpdate(): RttyScanUpdate {
    return this.scan.getUpdate();
  }

  // ===== lifecycle =====

  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.audioStream.on('audioData', this.audioListener);
    this.startDecoder();
    this.emitTxStatus();
  }

  async stop(reason: string): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.options.audioStream.off('audioData', this.audioListener);
    this.deferredText = '';
    this.deferredOwner = null;
    await this.abort(reason);
    await this.sessionRun?.catch(() => undefined);
    await this.stopDecoder();
    this.scan.stop();
    this.emit('scanUpdate', this.scan.getUpdate());
    this.clearHistory();
    this.signal = null;
    this.emitDecoderStatus();
    this.emitTxStatus();
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Re-publishes transmit availability after an external change (radio connection). */
  refreshAvailability(): void {
    this.emitTxStatus();
  }

  // ===== transmit =====

  getTxStatus(): RttyTxStatus {
    const session = this.session;
    const availability = this.txAvailability();
    const pendingText = session
      ? (session.encoder?.pendingText ?? session.pendingBeforeEncoder) + this.deferredText
      : this.deferredText;
    return {
      phase: this.txPhase,
      active: session !== null,
      sessionId: session?.sessionId ?? null,
      startedBy: session?.clientId ?? null,
      startedByLabel: session?.label ?? null,
      sentText: session?.sentText ?? '',
      committedText: session?.committed.map((item) => item.ch).join('') ?? '',
      pendingText,
      finishing: session?.finishRequested ?? false,
      typeAheadSupported: session ? session.streaming : true,
      messageId: session?.messageId ?? null,
      startedAt: session?.startedAt ?? null,
      lastText: this.lastText,
      repeat: this.repeat
        ? { messageId: this.repeat.messageId, intervalSec: this.repeat.intervalSec, nextRunAt: this.repeat.nextRunAt }
        : null,
      error: this.txError,
      available: availability.available,
      unavailableReason: availability.reason,
      revision: this.txRevision,
      updatedAt: this.now(),
    };
  }

  private txPhase: RttyTxStatus['phase'] = 'idle';

  /**
   * Appends text to the transmit buffer, starting a transmission when needed.
   *
   * Lower case is folded by the encoder. `{RX}` ends the transmission once
   * the text has been sent.
   */
  append(clientId: string, label: string, text: string, options: RttyAppendOptions = {}): void {
    if (options.start === false) {
      // Only extends the running stream; refused before anything else changes
      // (a refused stray key must not cancel a CQ loop either).
      const current = this.session;
      if (!current) throw new Error('RTTY_NOT_TRANSMITTING');
      if (current.aborted) throw new Error('RTTY_TX_ENDING');
      if (current.encoder && (!current.streaming || current.encoder.isFinishing)) throw new Error('RTTY_TX_ENDING');
    }
    if (this.repeat && !options.fromRepeat) this.cancelRepeat();
    const { text: cleaned, finish } = normalizeOutgoingText(text);
    const finishAfter = Boolean(options.finishAfter) || finish;
    const session = this.session;
    if (!session) {
      if (options.start === false) throw new Error('RTTY_NOT_TRANSMITTING');
      this.assertCanTransmit();
      this.startSession(clientId, label, cleaned, finishAfter, options.messageId ?? null, options.operatorId);
      return;
    }
    if (session.aborted) throw new Error('RTTY_TX_ENDING');
    // The newest typist owns the transmission (its disconnect stops it).
    session.clientId = clientId;
    session.label = label;
    if (options.operatorId && !session.operatorIds.includes(options.operatorId)) session.operatorIds.push(options.operatorId);
    const encoder = session.encoder;
    if (encoder && (!session.streaming || encoder.isFinishing)) {
      // `start: false` may only extend the running stream: queued text would key
      // up a new transmission later (fail closed for stray keys).
      if (options.start === false) throw new Error('RTTY_TX_ENDING');
      // Prepared audio cannot grow and a finishing stream is closing: queue the next transmission.
      this.queueDeferred(clientId, label, cleaned, options.operatorId, options.messageId);
      return;
    }
    if (options.messageId) session.messageId = options.messageId;
    if (encoder) {
      const result = encoder.pushText(cleaned);
      if (result.rejected) logger.debug('RTTY characters without ITA2 code skipped', { rejected: result.rejected });
    } else {
      session.pendingBeforeEncoder += cleaned;
    }
    if (finishAfter) this.requestFinish(session);
    this.emitTxStatus();
  }

  private queueDeferred(clientId: string, label: string, text: string, operatorId?: string, messageId?: string | null): void {
    if (this.deferredText.length + text.length > DEFERRED_TEXT_LIMIT) throw new Error('RTTY_BUFFER_FULL');
    this.deferredText += text;
    this.deferredOwner = {
      clientId,
      label,
      operatorId: operatorId ?? this.deferredOwner?.operatorId,
      messageId: messageId ?? this.deferredOwner?.messageId ?? null,
    };
    this.emitTxStatus();
  }

  /** True when `clientId` may edit or end the current transmission. */
  isOwner(clientId: string): boolean {
    return !this.session || this.session.clientId === clientId || this.deferredOwner?.clientId === clientId;
  }

  /** Removes up to `count` characters from the end of the editable buffer. */
  retract(count: number, clientId?: string): number {
    if (!Number.isInteger(count) || count <= 0) return 0;
    if (clientId !== undefined && !this.isOwner(clientId)) return 0;
    let removed = 0;
    if (this.deferredText.length > 0) {
      const fromDeferred = Math.min(count, this.deferredText.length);
      this.deferredText = this.deferredText.slice(0, this.deferredText.length - fromDeferred);
      removed += fromDeferred;
    }
    const session = this.session;
    if (session && removed < count) {
      if (session.encoder) {
        removed += session.encoder.retractUnsent(count - removed);
      } else {
        const take = Math.min(count - removed, session.pendingBeforeEncoder.length);
        session.pendingBeforeEncoder = session.pendingBeforeEncoder.slice(0, session.pendingBeforeEncoder.length - take);
        removed += take;
      }
    }
    if (removed > 0) this.emitTxStatus();
    return removed;
  }

  /** Ends the transmission once the buffer has been sent. */
  finish(clientId?: string): void {
    if (clientId !== undefined && !this.isOwner(clientId)) return;
    if (this.session) {
      this.requestFinish(this.session);
      this.emitTxStatus();
    }
  }

  /** Stops transmitting immediately. Text not yet sent is discarded. */
  async abort(reason: string): Promise<void> {
    this.deferredText = '';
    this.deferredOwner = null;
    this.cancelRepeat();
    const session = this.session;
    if (!session) {
      this.emitTxStatus();
      return;
    }
    await this.abortSession(session, reason, null);
  }

  /** Fail-closed hook for the client that owns the transmission. */
  async handleClientDisconnect(clientId: string): Promise<void> {
    if (this.repeat?.clientId === clientId) this.cancelRepeat();
    if (this.session?.clientId === clientId) {
      await this.abort('owner disconnected');
    } else if (this.deferredOwner?.clientId === clientId) {
      this.deferredText = '';
      this.deferredOwner = null;
      this.emitTxStatus();
    }
  }

  /**
   * Sends `request.text` now and again `intervalSec` after each transmission
   * ends, until a station answers (confident received text), the operator
   * sends anything else or stops, or the owning client disconnects.
   */
  startRepeat(request: RttyRepeatRequest): void {
    this.cancelRepeat();
    if (!request.text.trim()) throw new Error('RTTY message slot has no text');
    const repeat: RepeatState = {
      ...request,
      nextRunAt: null,
      cancelTimer: null,
      quietSince: this.now(),
      frequency: this.options.getFrequency(),
      runs: 1,
    };
    this.append(request.clientId, request.label, this.repeatText(repeat), {
      messageId: request.messageId,
      operatorId: request.operatorId,
      finishAfter: true,
      fromRepeat: true,
    });
    this.repeat = repeat;
    if (!this.session) this.scheduleRepeat(repeat);
    this.emitTxStatus();
  }

  /** Stops the automatic repeat (optionally only if it repeats `messageId`). */
  cancelRepeat(messageId?: string): void {
    const repeat = this.repeat;
    if (!repeat || (messageId && repeat.messageId !== messageId)) return;
    repeat.cancelTimer?.();
    this.repeat = null;
    this.emitTxStatus();
  }

  private repeatText(repeat: RepeatState): string {
    return `${this.session ? ' ' : '\n'}${repeat.text}\n`;
  }

  private scheduleRepeat(repeat: RepeatState): void {
    repeat.cancelTimer?.();
    repeat.quietSince = this.now();
    repeat.nextRunAt = this.now() + repeat.intervalSec * 1000;
    repeat.cancelTimer = this.schedule(() => this.runRepeat(repeat), repeat.intervalSec * 1000);
    this.emitTxStatus();
  }

  private runRepeat(repeat: RepeatState): void {
    if (this.repeat !== repeat) return;
    repeat.cancelTimer = null;
    const frequency = this.options.getFrequency();
    const moved = repeat.frequency !== null && (frequency === null || Math.round(frequency) !== Math.round(repeat.frequency));
    if (!this.running || this.session || this.deferredText || moved || repeat.runs >= MAX_REPEAT_RUNS
      || this.lastAnswerAt > repeat.quietSince) {
      // Someone answered, the operator took over or the radio moved: hand control back.
      this.cancelRepeat();
      return;
    }
    repeat.runs += 1;
    repeat.nextRunAt = null;
    try {
      this.append(repeat.clientId, repeat.label, this.repeatText(repeat), {
        messageId: repeat.messageId,
        operatorId: repeat.operatorId,
        finishAfter: true,
        fromRepeat: true,
      });
    } catch (error) {
      logger.warn('RTTY repeat could not transmit', { error: error instanceof Error ? error.message : String(error) });
      this.cancelRepeat();
    }
  }

  /** Received text of the current transcript, for a client that joins late. */
  getTranscriptSnapshot(): Extract<RttyDecoderEvent, { kind: 'characters' }> | null {
    if (this.transcriptSnapshot.length === 0) return null;
    return {
      kind: 'characters',
      sessionId: this.rxSessionId,
      // Last sequence included (-1: no live batch of this session yet).
      sequence: this.rxSequence - 1,
      characters: this.transcriptSnapshot.slice(),
      snapshot: true,
    };
  }

  /** Called when the radio frequency, mode or connection changed. */
  async handleOperatingStateChanged(reason: string): Promise<void> {
    // A waiting repeat must not key up on a frequency it was not started on.
    const repeat = this.repeat;
    if (repeat && repeat.frequency !== null) {
      const frequency = this.options.getFrequency();
      if (frequency === null || Math.round(frequency) !== Math.round(repeat.frequency)) this.cancelRepeat();
    }
    const session = this.session;
    if (!session) return;
    const frequency = this.options.getFrequency();
    if (session.expectedFrequency !== null
      && (frequency === null || Math.round(frequency) !== Math.round(session.expectedFrequency))) {
      await this.abortSession(session, reason, 'RTTY_FREQUENCY_CHANGED');
    }
  }

  private txAvailability(): { available: boolean; reason: string | null } {
    if (!this.running) return { available: false, reason: 'RTTY mode is not active' };
    if (this.options.isRadioReady && !this.options.isRadioReady()) {
      return { available: false, reason: 'RTTY_RADIO_DISCONNECTED' };
    }
    const codec = this.codec.getAvailability();
    if (!codec.available) return { available: false, reason: codec.reason ?? 'RTTY_NATIVE_UNAVAILABLE' };
    return { available: true, reason: null };
  }

  private assertCanTransmit(): void {
    const availability = this.txAvailability();
    if (!availability.available) throw new Error(availability.reason ?? 'RTTY_UNAVAILABLE');
  }

  private requestFinish(session: TxSession): void {
    session.finishRequested = true;
    session.encoder?.finish();
  }

  private startSession(
    clientId: string,
    label: string,
    text: string,
    finishAfter: boolean,
    messageId: string | null,
    operatorId?: string,
  ): void {
    const session: TxSession = {
      sessionId: randomUUID(),
      clientId,
      label,
      operatorIds: operatorId ? [operatorId] : [],
      messageId,
      startedAt: this.now(),
      expectedFrequency: this.options.getFrequency(),
      encoder: null,
      playback: null,
      leaseId: null,
      pendingBeforeEncoder: text,
      committed: [],
      sentText: '',
      consumedSamples: 0,
      streaming: true,
      finishRequested: finishAfter,
      aborted: false,
      abortError: null,
    };
    this.session = session;
    this.txError = null;
    this.txPhase = 'preparing';
    this.counters.txSessions += 1;
    this.emitTxStatus();
    // Receive is muted while a transmission session exists.
    this.emitDecoderStatus();
    this.sessionRun = this.runSession(session)
      .finally(() => {
        if (this.session === session) this.endSession(session);
      })
      .catch((error) => {
        logger.error('RTTY session cleanup failed', { error: error instanceof Error ? error.message : String(error) });
      });
  }

  private validateStart(session: TxSession): void {
    if (session.aborted || this.session !== session) throw new Error('RTTY_TX_CANCELLED');
    if (session.expectedFrequency === null) return;
    const frequency = this.options.getFrequency();
    if (frequency === null || Math.round(frequency) !== Math.round(session.expectedFrequency)) {
      throw new Error('RTTY_FREQUENCY_CHANGED');
    }
  }

  private async runSession(session: TxSession): Promise<void> {
    const config = this.options.getConfig();
    try {
      const codec = this.codec.load();
      const playback = this.options.audioStream.openDeterministicPlayback({
        playbackKind: 'rtty',
        injectIntoMonitor: true,
        onPlaybackChunk: (samples) => {
          if (this.session !== session) return;
          session.consumedSamples += samples.length;
          this.updateSentProgress(session);
        },
      });
      session.playback = playback;
      session.streaming = playback.preparation !== 'complete';
      const tones = resolveRttyAudioTones(config);
      const encoder = new codec.RttyEncoder(playback.sampleRate, {
        baud: config.baud,
        shiftHz: config.shiftHz,
        stopBits: config.stopBits,
        markHz: tones.markHz,
        spaceHz: tones.spaceHz,
        characterSet: config.characterSet,
        idle: config.idle,
      });
      session.encoder = encoder;
      if (session.pendingBeforeEncoder) encoder.pushText(session.pendingBeforeEncoder);
      session.pendingBeforeEncoder = '';
      if (session.finishRequested || !session.streaming) encoder.finish();
      if (session.aborted) throw new Error('RTTY_TX_CANCELLED');
      const maxMs = config.maxTransmitSeconds * 1000;
      if (!session.streaming) {
        // Prepared audio plays to the end once started, so check its length first.
        const characterMs = (6 + config.stopBits) / config.baud * 1000;
        const estimatedMs = (encoder.pendingLength + 4) * characterMs + 500;
        if (estimatedMs > maxMs) throw new Error('RTTY_MAX_DURATION');
      }

      const lookaheadSamples = playback.sampleRate * LOOKAHEAD_MS / 1000;
      const queuedSamples = () => playback.queuedAudioMs * playback.sampleRate / 1000;
      const fill = async (untilFinished: boolean) => {
        while (!encoder.isFinished && !session.aborted
          && (untilFinished || queuedSamples() < lookaheadSamples)) {
          const read = encoder.readSamples(playback.frameSamples);
          for (const item of read.rendered) session.committed.push({ ch: item.ch, endSample: item.endSample });
          if (read.samples.length > 0) await playback.write(read.samples);
        }
      };
      await fill(!session.streaming);
      this.validateStart(session);

      this.txPhase = 'waiting_lease';
      this.emitTxStatus();
      session.leaseId = await this.options.physicalTx.acquireLease({
        source: 'rtty',
        operatorIds: session.operatorIds,
        reason: 'RTTY transmission',
        playbackKind: 'rtty',
        deferActiveUntilAudio: true,
        assertPtt: session.expectedFrequency !== null,
        // Called by the coordinator while it owns the release: stop producing
        // audio only; the run loop observes the abort and cleans up.
        interrupt: () => this.markInterrupted(session),
        validateStart: () => this.validateStart(session),
      });
      this.validateStart(session);
      this.txPhase = 'on_air';
      this.emitTxStatus();
      await playback.start();
      this.options.physicalTx.markStreamingLeaseActive(session.leaseId);

      while (!encoder.isFinished && !session.aborted) {
        if (this.now() - session.startedAt > maxMs) {
          throw new Error('RTTY_MAX_DURATION');
        }
        await fill(false);
        this.emitTxStatus();
        await this.sleep(STREAM_TICK_MS);
      }
      if (session.aborted) throw new Error(session.abortError ?? 'RTTY_TX_CANCELLED');

      this.options.physicalTx.markStreamingLeaseDraining(session.leaseId);
      this.txPhase = 'draining';
      this.emitTxStatus();
      await this.withDeadline(playback.end(), session.startedAt + maxMs + 5_000, 'RTTY_MAX_DURATION');
      const leaseId = session.leaseId;
      session.leaseId = null;
      const result = await this.options.physicalTx.releaseLease(leaseId, 'RTTY transmission completed');
      if (!result.success || (session.expectedFrequency !== null && !result.physicalConfirmed)) {
        throw new Error(result.error ?? result.reason ?? 'RTTY_TX_RELEASE_FAILED');
      }
      session.consumedSamples = Number.MAX_SAFE_INTEGER;
      this.updateSentProgress(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = session.aborted && session.abortError === null;
      if (!cancelled) {
        this.counters.txErrors += 1;
        this.txError = session.abortError ?? (/^RTTY_[A-Z_]+/.test(message) ? message.match(/^RTTY_[A-Z_]+/)![0] : 'RTTY_TX_FAILED');
        logger.warn('RTTY transmission ended with an error', { error: message });
      }
      await this.stopTransmitting(session, message);
    }
  }

  private async withDeadline<T>(work: Promise<T>, deadline: number, error: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, deadline - this.now());
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(error)), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async stopTransmitting(session: TxSession, reason: string): Promise<void> {
    session.encoder?.abort();
    await session.playback?.abort(reason).catch(() => undefined);
    const leaseId = session.leaseId;
    session.leaseId = null;
    if (leaseId) {
      await this.options.physicalTx.forceInterruptLease(leaseId, `RTTY: ${reason}`).catch((error) => {
        logger.error('Failed to interrupt RTTY transmission lease', { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  private async markInterrupted(session: TxSession): Promise<void> {
    if (session.aborted) return;
    session.aborted = true;
    session.abortError = 'RTTY_TX_INTERRUPTED';
    session.encoder?.abort();
    await session.playback?.abort('physical transmission interrupted').catch(() => undefined);
  }

  private async abortSession(session: TxSession, reason: string, error: string | null): Promise<void> {
    if (session.aborted) return;
    session.aborted = true;
    session.abortError = error;
    logger.info('RTTY transmission aborted', { reason, error });
    await this.stopTransmitting(session, reason);
    await this.sessionRun?.catch(() => undefined);
  }

  private endSession(session: TxSession): void {
    session.encoder?.dispose();
    const sent = session.sentText.trim();
    if (sent) this.lastText = sent;
    this.session = null;
    this.sessionRun = null;
    this.txPhase = this.txError ? 'error' : 'idle';
    this.emitDecoderStatus();
    if (this.txError || session.aborted) {
      // Fail closed: nothing queued before a failure or a stop is sent later.
      this.deferredText = '';
      this.deferredOwner = null;
      this.cancelRepeat();
    } else if (this.repeat && !this.deferredText) {
      // With queued text, the repeat waits until that transmission has ended too.
      this.scheduleRepeat(this.repeat);
    }
    this.emitTxStatus();
    this.resumeDecoderAfterTransmit();
    if (this.deferredText && this.deferredOwner && this.running && !this.txError) {
      const { clientId, label, operatorId, messageId } = this.deferredOwner;
      const text = this.deferredText;
      this.deferredText = '';
      this.deferredOwner = null;
      try {
        // Text queued behind a running transmission was joined with a space; a new one starts on a new line.
        this.startSession(clientId, label, `\n${text.replace(/^[ \n]+/, '')}`, true, messageId ?? null, operatorId);
      } catch (error) {
        logger.warn('Queued RTTY text could not start', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private updateSentProgress(session: TxSession): void {
    let moved = '';
    while (session.committed.length > 0 && session.committed[0]!.endSample <= session.consumedSamples) {
      moved += session.committed.shift()!.ch;
    }
    if (!moved) return;
    session.sentText = (session.sentText + moved).slice(-SENT_TEXT_LIMIT);
    this.emitTxStatus();
  }

  private lastTxSignature = '';

  /** Publishes the transmit status when anything a client renders has changed. */
  private emitTxStatus(): void {
    const status = this.getTxStatus();
    const signature = [
      status.phase, status.active, status.sessionId, status.sentText.length, status.committedText,
      status.pendingText, status.finishing, status.typeAheadSupported, status.error, status.available,
      status.unavailableReason, status.lastText, status.startedBy, status.messageId,
      status.repeat ? `${status.repeat.messageId}@${status.repeat.nextRunAt ?? 'tx'}` : '',
    ].join('\u0000');
    if (signature === this.lastTxSignature) return;
    this.lastTxSignature = signature;
    this.txRevision += 1;
    this.emit('txStatus', { ...status, revision: this.txRevision });
  }

  // ===== receive =====

  getDecoderStatus(): RttyDecoderStatus {
    const availability = this.codec.getAvailability();
    let state: RttyDecoderStatus['state'];
    if (!this.running) state = 'disabled';
    else if (!availability.available) state = 'unavailable';
    else if (this.rxError) state = 'error';
    else if (this.session) state = 'muted';
    else state = 'listening';
    return {
      state,
      enabled: this.running,
      sessionId: this.rxSessionId,
      signal: this.signal,
      error: this.rxError ?? (availability.available ? null : availability.reason ?? null),
      updatedAt: this.now(),
    };
  }

  /** Starts a new transcript session; clients clear their view. */
  clearTranscript(): RttyDecoderStatus {
    this.rxSessionId = randomUUID();
    this.rxSequence = 0;
    this.transcriptSnapshot = [];
    if (this.rx) this.rx.characters = [];
    // Cleared text must not come back with a later re-decode.
    this.cancelReplay();
    this.clearHistory();
    this.emit('decoderEvent', { kind: 'reset', sessionId: this.rxSessionId, reason: 'cleared' });
    this.emitDecoderStatus();
    return this.getDecoderStatus();
  }

  /** Applies a saved configuration change to the running decoder. */
  async applyConfig(next: RttyConfig, previous: RttyConfig): Promise<void> {
    const rx = this.rx;
    if (!rx) {
      // A decoder that could not be created (e.g. rejected tones) is retried with the new settings.
      if (this.running) this.startDecoder();
      return;
    }
    this.scan.configure(next, rx.sampleRate);
    const rebuild = next.baud !== previous.baud || next.stopBits !== previous.stopBits
      || next.noiseBlanker !== previous.noiseBlanker;
    const redecode = REDECODE_FIELDS.some((field) => next[field] !== previous[field]) && this.history.length > 0;
    if (rebuild) {
      // A replay builds the new decoder from the history; otherwise start afresh.
      const outcome = redecode ? await this.redecodeHistory(next) : 'skipped';
      const stale = outcome === 'skipped' || (outcome === 'superseded' && !this.replay && this.rx === rx);
      if (stale) await this.restartDecoder('reconfigured');
      return;
    }
    const tonesAfter = resolveRttyAudioTones(next);
    // Compare with what the decoder actually listens on: a live preview may have moved it.
    if (rx.appliedMark !== tonesAfter.markHz || rx.appliedSpace !== tonesAfter.spaceHz) {
      try {
        rx.decoder.retune(tonesAfter.markHz, tonesAfter.spaceHz);
      } catch (error) {
        // Rejected synchronously (the engine validates tones first): rebuild so the error is visible.
        logger.warn('RTTY retune rejected', { error: error instanceof Error ? error.message : String(error) });
        await this.restartDecoder('reconfigured');
        return;
      }
      rx.appliedMark = tonesAfter.markHz;
      rx.appliedSpace = tonesAfter.spaceHz;
    }
    if (next.squelch !== previous.squelch) rx.decoder.setSquelch(next.squelch);
    if (next.afc !== previous.afc || next.usos !== previous.usos
      || next.characterSet !== previous.characterSet || next.autoReverse !== previous.autoReverse) {
      rx.decoder.updateSettings({
        afc: next.afc,
        usos: next.usos,
        characterSet: next.characterSet,
        autoReverse: next.autoReverse,
      });
    }
    if (redecode) await this.redecodeHistory(next);
  }

  /**
   * Decodes the recent receive history again with `config`. Text already
   * shown is never rewritten: a confident, different result is sent as a
   * separate replay block.
   *
   * A new decoder consumes the history, keeps consuming audio recorded while
   * it catches up, and then takes over as the live decoder. One continuous
   * decoder therefore covers the whole stream: nothing is lost or repeated at
   * the hand-over. The previous decoder's text during the catch-up is dropped.
   */
  async redecodeHistory(config: RttyConfig = this.options.getConfig()): Promise<ReplayOutcome> {
    const old = this.rx;
    if (!old || this.history.length === 0 || this.historyRate !== old.sampleRate) return 'skipped';
    let codec;
    try {
      codec = this.codec.load();
    } catch {
      return 'skipped';
    }
    const token = ++this.replayToken;
    this.flushCharacters(old);
    this.replay = { token };
    // Text after this time was never shown: the old decoder's output is dropped
    // during the catch-up and the replay decoder supplies it.
    const lastShownAt = this.transcriptSnapshot.reduce((latest, character) => Math.max(latest, character.at), -Infinity);
    const sampleRate = old.sampleRate;
    const generation = ++this.rxGeneration;
    const first = this.history[0]!;
    const replayFrom = Math.round(first.endTime - first.samples.length / sampleRate * 1000);
    const collected: RttyReceivedCharacter[] = [];
    const anchors: Array<{ endSample: number; time: number }> = [];
    const fold = { lastWasCarriageReturn: false };
    let live = false;
    let failure: string | null = null;
    // Characters decoded while the latest signal report showed a lock on both tones.
    let lockedOnSignal = false;
    let decodedCharacters = 0;
    let lockedCharacters = 0;
    const timeOf = (sample: number) => {
      const anchor = anchors.find((item) => item.endSample >= sample) ?? anchors[anchors.length - 1];
      return anchor ? Math.round(anchor.time - (anchor.endSample - sample) / sampleRate * 1000) : this.now();
    };
    const started = performance.now();
    let decoder: RttyDecoder;
    try {
      decoder = this.createReplayDecoder(codec, config, sampleRate, (event) => {
      if (live) {
        this.handleDecoderEvent(generation, event);
      } else if (event.type === 'character') {
        const ch = foldLineBreak(fold, event.ch);
        if (ch !== null) {
          collected.push({ ch, confidence: clamp01(event.confidence), at: timeOf(event.startSample) });
          if (ch.trim()) {
            decodedCharacters += 1;
            if (lockedOnSignal) lockedCharacters += 1;
          }
        }
      } else if (event.type === 'signal') {
        lockedOnSignal = event.locked && tonesBalanced(event.markDb, event.spaceDb);
      } else if (event.type === 'error') {
        failure = event.reason;
      }
      });
    } catch (error) {
      // Never leave the replay flag set: live text would be dropped from then on.
      if (this.replay?.token === token) this.replay = null;
      logger.warn('RTTY re-decode could not start', { error: error instanceof Error ? error.message : String(error) });
      return 'skipped';
    }
    const abandoned = () => !this.replay || this.replay.token !== token || this.rx !== old;
    let cursor = 0;
    let nextSeq = first.seq;
    try {
      for (;;) {
        if (abandoned() || failure) break;
        const pending = this.history.filter((chunk) => chunk.seq >= nextSeq);
        if (pending.length === 0) break;
        for (const chunk of pending) {
          if (chunk.gapBefore > 0) {
            decoder.markDiscontinuity(chunk.gapBefore);
            cursor += chunk.gapBefore;
          }
          while (!decoder.pushF32(chunk.samples)) await decoder.drain();
          cursor += chunk.samples.length;
          anchors.push({ endSample: cursor, time: chunk.endTime });
          nextSeq = chunk.seq + 1;
        }
        await decoder.drain();
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (abandoned() || failure) {
      if (failure) logger.warn('RTTY re-decode failed', { error: failure });
      if (this.replay?.token === token) this.replay = null;
      await decoder.dispose().catch(() => undefined);
      return failure && !abandoned() ? 'skipped' : 'superseded';
    }

    // Hand over synchronously: everything recorded so far has been fed.
    const tones = resolveRttyAudioTones(config);
    live = true;
    this.replay = null;
    if (old.flushTimer) clearTimeout(old.flushTimer);
    this.rx = {
      decoder,
      sampleRate,
      generation,
      chunk: old.chunk,
      chunkOffset: old.chunkOffset,
      backlog: [],
      draining: false,
      cursor,
      // Muted or lost samples not yet attached to a recorded chunk.
      pendingDropped: this.historyGap,
      anchors: anchors.slice(-TIME_ANCHOR_LIMIT),
      characters: [],
      flushTimer: null,
      lastWasCarriageReturn: fold.lastWasCarriageReturn,
      appliedMark: tones.markHz,
      appliedSpace: tones.spaceHz,
    };
    void old.decoder.dispose().catch(() => undefined);
    this.rxError = null;
    this.smoothedSnr = null;
    this.counters.replays += 1;
    this.counters.lastReplayMs = Math.round(performance.now() - started);
    // Never rewrite what the operator has read: show the replay as a separate
    // block, and only when it is a confident decode that says something new
    // (a mistuned or reversed replay decodes plausible-looking garbage).
    // Compare only the window the operator has already seen.
    const original = this.transcriptSnapshot.filter((character) => character.at >= replayFrom);
    const replayedWindow = collected.filter((character) => character.at <= lastShownAt);
    const meaningful = decodedCharacters >= REPLAY_MIN_CHARACTERS;
    const confident = meaningful && lockedCharacters / decodedCharacters >= REPLAY_MIN_LOCKED_RATIO;
    if (confident && wordSimilarity(textOf(original), textOf(replayedWindow)) < REPLAY_SAME_TEXT_SIMILARITY) {
      this.emit('decoderEvent', {
        kind: 'characters',
        sessionId: this.rxSessionId,
        sequence: this.rxSequence++,
        characters: collected,
        replay: true,
        replayFrom,
      });
      // The server's view (snapshot for late joiners, base of the next
      // comparison) takes the better text, so the same replay is not shown twice.
      this.rememberTranscript(this.transcriptSnapshot.filter((character) => character.at < replayFrom).concat(collected), true);
    } else {
      // Not shown: still deliver the text decoded after what was on screen,
      // which only the replay decoder has.
      const tail = collected.filter((character) => character.at > lastShownAt);
      const liveRx = this.rx;
      if (tail.length > 0 && liveRx) {
        liveRx.characters.push(...tail);
        this.flushCharacters(liveRx);
      }
    }
    return 'replayed';
  }

  private createReplayDecoder(
    codec: ReturnType<RttyCodecRuntime['load']>,
    config: RttyConfig,
    sampleRate: number,
    onEvent: (event: RttyDecodeEvent) => void,
  ): RttyDecoder {
    return new codec.RttyDecoder(sampleRate, this.decoderOptions(config, sampleRate, SIGNAL_EMIT_MS), onEvent);
  }

  private cancelReplay(): void {
    this.replayToken += 1;
    this.replay = null;
  }

  private startNewTranscript(reason: 'reconfigured' | 'restarted'): void {
    this.rxSessionId = randomUUID();
    this.rxSequence = 0;
    this.transcriptSnapshot = [];
    this.emit('decoderEvent', { kind: 'reset', sessionId: this.rxSessionId, reason });
  }

  private recordHistory(samples: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.historyRate) {
      this.clearHistory();
      this.historyRate = sampleRate;
    }
    this.history.push({ seq: this.historySeq++, samples, endTime: this.now(), gapBefore: this.historyGap });
    this.historyGap = 0;
    this.historySamples += samples.length;
    const limit = sampleRate * HISTORY_SECONDS;
    while (this.history.length > 1 && this.historySamples - this.history[0]!.samples.length >= limit) {
      this.historySamples -= this.history.shift()!.samples.length;
    }
  }

  private clearHistory(): void {
    this.history = [];
    this.historySamples = 0;
    this.historyGap = 0;
  }

  /** Counters for the diagnostics snapshot. */
  getTelemetry(): RttyServiceTelemetry {
    const rx = this.rx;
    return {
      rx: {
        state: this.getDecoderStatus().state,
        sampleRate: rx?.sampleRate ?? null,
        historySeconds: this.historyRate > 0 ? round1(this.historySamples / this.historyRate) : 0,
        samplesDecoded: this.counters.samplesDecoded,
        samplesLost: this.counters.samplesLost,
        overruns: this.counters.overruns,
        restarts: this.counters.restarts,
        replays: this.counters.replays,
        lastReplayMs: this.counters.lastReplayMs,
        backlogChunks: rx?.backlog.length ?? 0,
        nativeQueuedSamples: rx?.decoder.queuedSamples ?? 0,
        scannerChannels: this.scan.getUpdate().channels.length,
        scannerDroppedChunks: this.scan.getDroppedChunks(),
      },
      tx: {
        phase: this.getTxStatus().phase,
        sessions: this.counters.txSessions,
        errors: this.counters.txErrors,
        lastError: this.txError,
      },
    };
  }

  /** Moves the receiver without persisting (live tuning preview). */
  previewCenter(centerHz: number): void {
    const rx = this.rx;
    if (!rx) return;
    const config = { ...this.options.getConfig(), centerHz };
    const tones = resolveRttyAudioTones(config);
    try {
      rx.decoder.retune(tones.markHz, tones.spaceHz);
    } catch {
      // A preview outside the usable tone range is ignored; the receiver stays put.
      return;
    }
    rx.appliedMark = tones.markHz;
    rx.appliedSpace = tones.spaceHz;
  }

  private startDecoder(): void {
    if (!this.running || this.rx) return;
    let codec;
    try {
      codec = this.codec.load();
    } catch (error) {
      this.rxError = null;
      logger.warn('RTTY decoder unavailable', { error: error instanceof Error ? error.message : String(error) });
      this.emitDecoderStatus();
      return;
    }
    const config = this.options.getConfig();
    const tones = resolveRttyAudioTones(config);
    const sampleRate = this.options.audioStream.getInternalSampleRate();
    const generation = ++this.rxGeneration;
    try {
      const decoder = new codec.RttyDecoder(
        sampleRate,
        this.decoderOptions(config, sampleRate, SIGNAL_EMIT_MS),
        (event) => this.handleDecoderEvent(generation, event),
      );
      this.rx = {
        decoder,
        sampleRate,
        generation,
        chunk: new Float32Array(Math.max(1, Math.round(sampleRate * INPUT_CHUNK_MS / 1000))),
        chunkOffset: 0,
        backlog: [],
        draining: false,
        cursor: 0,
        pendingDropped: 0,
        anchors: [],
        characters: [],
        flushTimer: null,
        lastWasCarriageReturn: false,
        appliedMark: tones.markHz,
        appliedSpace: tones.spaceHz,
      };
      this.rxError = null;
      this.smoothedSnr = null;
      this.scan.configure(config, sampleRate);
    } catch (error) {
      this.rxError = error instanceof Error ? error.message : String(error);
      logger.error('Failed to create RTTY decoder', { error: this.rxError });
    }
    this.emitDecoderStatus();
  }

  private decoderOptions(config: RttyConfig, sampleRate: number, signalReportMs: number) {
    const tones = resolveRttyAudioTones(config);
    return {
      baud: config.baud,
      shiftHz: config.shiftHz,
      stopBits: config.stopBits,
      markHz: tones.markHz,
      spaceHz: tones.spaceHz,
      characterSet: config.characterSet,
      usos: config.usos,
      afc: config.afc,
      squelch: config.squelch,
      autoReverse: config.autoReverse,
      noiseBlanker: config.noiseBlanker,
      signalReportMs,
      queueCapacitySamples: sampleRate * NATIVE_QUEUE_SECONDS,
    };
  }

  private async stopDecoder(): Promise<void> {
    const rx = this.rx;
    this.rx = null;
    if (!rx) return;
    // A replay catches up with this decoder's stream; it cannot take over any more.
    if (this.replay) this.cancelReplay();
    this.historyGap += rx.chunkOffset;
    if (rx.flushTimer) clearTimeout(rx.flushTimer);
    this.flushCharacters(rx);
    await rx.decoder.dispose().catch(() => undefined);
  }

  private async restartDecoder(reason: 'reconfigured' | 'restarted', newTranscript = true): Promise<void> {
    await this.stopDecoder();
    if (reason === 'restarted') this.counters.restarts += 1;
    if (newTranscript) this.startNewTranscript(reason);
    this.startDecoder();
  }

  private acceptAudio(samples: Float32Array, sampleRate: number): void {
    const rx = this.rx;
    if (samples.length === 0) return;
    if (!rx) {
      this.historyGap += samples.length;
      return;
    }
    if (sampleRate !== rx.sampleRate) {
      this.historyGap += samples.length;
      void this.restartDecoder('restarted');
      return;
    }
    if (this.session) {
      // Receive is muted while transmitting; keep the timeline continuous.
      const backlogged = rx.backlog.reduce((sum, item) => sum + item.length, 0);
      rx.backlog.length = 0;
      rx.pendingDropped += samples.length + rx.chunkOffset + backlogged;
      this.historyGap += samples.length + rx.chunkOffset;
      rx.chunkOffset = 0;
      return;
    }
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, rx.chunk.length - rx.chunkOffset);
      rx.chunk.set(samples.subarray(offset, offset + count), rx.chunkOffset);
      offset += count;
      rx.chunkOffset += count;
      if (rx.chunkOffset === rx.chunk.length) {
        const ready = rx.chunk;
        rx.chunk = new Float32Array(ready.length);
        rx.chunkOffset = 0;
        this.recordHistory(ready, rx.sampleRate);
        this.scan.push(ready);
        this.enqueueInput(rx, ready);
      }
    }
  }

  private resumeDecoderAfterTransmit(): void {
    this.emitDecoderStatus();
  }

  private enqueueInput(rx: RxState, chunk: Float32Array): void {
    if (rx.draining || rx.backlog.length > 0) {
      this.queueBacklog(rx, chunk);
      return;
    }
    if (!this.pushChunk(rx, chunk)) {
      this.queueBacklog(rx, chunk);
      this.beginDrain(rx);
    }
  }

  private pushChunk(rx: RxState, chunk: Float32Array): boolean {
    if (rx.pendingDropped > 0) {
      rx.decoder.markDiscontinuity(rx.pendingDropped);
      rx.cursor += rx.pendingDropped;
      rx.pendingDropped = 0;
    }
    if (!rx.decoder.pushF32(chunk)) return false;
    rx.cursor += chunk.length;
    this.counters.samplesDecoded += chunk.length;
    rx.anchors.push({ endSample: rx.cursor, time: this.now() });
    if (rx.anchors.length > TIME_ANCHOR_LIMIT) rx.anchors.shift();
    return true;
  }

  private queueBacklog(rx: RxState, chunk: Float32Array): void {
    const maxChunks = Math.max(1, Math.floor(JS_BACKLOG_MS / INPUT_CHUNK_MS));
    if (rx.backlog.length >= maxChunks) {
      const dropped = rx.backlog.reduce((sum, item) => sum + item.length, 0) + chunk.length;
      rx.backlog.length = 0;
      rx.pendingDropped += dropped;
      this.counters.overruns += 1;
      this.counters.samplesLost += dropped;
      logger.warn('RTTY decoder input overrun', { dropped });
      return;
    }
    rx.backlog.push(chunk);
  }

  private beginDrain(rx: RxState): void {
    if (rx.draining) return;
    rx.draining = true;
    void rx.decoder.drain().then(() => {
      if (this.rx !== rx) return;
      rx.draining = false;
      while (rx.backlog.length > 0) {
        if (!this.pushChunk(rx, rx.backlog[0]!)) {
          this.beginDrain(rx);
          return;
        }
        rx.backlog.shift();
      }
    }).catch((error) => this.failDecoder(rx, error));
  }

  private failDecoder(rx: RxState, error: unknown): void {
    if (this.rx !== rx) return;
    this.rxError = error instanceof Error ? error.message : String(error);
    logger.error('RTTY decoder failed; restarting', { error: this.rxError });
    this.emitDecoderStatus();
    setTimeout(() => {
      if (this.running && this.rx === rx) void this.restartDecoder('restarted');
    }, DECODER_RESTART_DELAY_MS);
  }

  private handleDecoderEvent(generation: number, event: RttyDecodeEvent): void {
    const rx = this.rx;
    if (!rx || rx.generation !== generation) return;
    if (event.type === 'character') {
      this.acceptCharacter(rx, event.ch, event.confidence, event.startSample);
      return;
    }
    if (event.type === 'signal') {
      // The decoder's raw lock flag also looks good on a strong but mistuned
      // signal (one tone in a filter, the other missed): additionally require
      // both tones, recently decoded text and an AFC inside its range.
      const config = this.options.getConfig();
      const afcLimited = config.afc && Math.abs(event.frequencyOffsetHz) >= AFC_RANGE_HZ * 0.9;
      // Idle diddles produce no characters: keep the last quality while the
      // decoder stays locked on both tones instead of decaying to unlocked.
      const measured = this.recentDecodeQuality();
      const bothTones = tonesBalanced(event.markDb, event.spaceDb);
      let quality = measured ?? 0;
      if (measured !== null) this.heldQuality = measured;
      else if (event.locked && bothTones && !afcLimited) quality = this.heldQuality;
      else this.heldQuality = 0;
      // The modem reports a calibrated SNR in 3 kHz (duty-weighted over both
      // tones), or its floor before the first measurement, which is skipped.
      if (event.snrDb > SNR_MIN_DB) {
        const rawSnr = Math.min(SNR_MAX_DB, event.snrDb);
        this.smoothedSnr = this.smoothedSnr === null ? rawSnr : this.smoothedSnr + SNR_SMOOTHING * (rawSnr - this.smoothedSnr);
      }
      this.signal = {
        locked: event.locked && !afcLimited && bothTones && quality >= LOCK_QUALITY,
        // SNR_MIN_DB means "not measured yet"; clients hide it.
        snrDb: round1(this.smoothedSnr ?? SNR_MIN_DB),
        markDb: round1(event.markDb),
        spaceDb: round1(event.spaceDb),
        frequencyOffsetHz: round1(event.frequencyOffsetHz),
        reversed: event.reversed,
        afcLimited,
        quality: round2(quality),
      };
      const now = this.now();
      if (now - this.lastSignalEmit >= SIGNAL_EMIT_MS) {
        this.lastSignalEmit = now;
        this.emitDecoderStatus();
      }
      return;
    }
    if (event.type === 'error') this.failDecoder(rx, new Error(event.reason));
  }

  private acceptCharacter(rx: RxState, ch: string, confidence: number, startSample: number): void {
    const output = foldLineBreak(rx, ch);
    if (output === null) return;
    const character = { ch: output, confidence: clamp01(confidence), at: this.sampleTime(rx, startSample) };
    // The replay decoder covers this audio and is about to take over.
    if (this.replay) return;
    if (output.trim()) {
      this.recentQuality.push({ at: character.at, confidence: character.confidence });
      if (this.recentQuality.length > 32) this.recentQuality.shift();
      if (character.confidence >= ANSWER_CONFIDENCE) {
        this.lastAnswerAt = Math.max(this.lastAnswerAt, this.now());
        // Someone answers while the loop waits: stop it now, not at the next run.
        if (this.repeat && this.repeat.nextRunAt !== null && this.lastAnswerAt > this.repeat.quietSince) this.cancelRepeat();
      }
    }
    rx.characters.push(character);
    if (!rx.flushTimer) {
      rx.flushTimer = setTimeout(() => {
        rx.flushTimer = null;
        this.flushCharacters(rx);
      }, CHARACTER_FLUSH_MS);
    }
  }

  private sampleTime(rx: RxState, sample: number): number {
    const anchor = rx.anchors.find((item) => item.endSample >= sample) ?? rx.anchors[rx.anchors.length - 1];
    if (!anchor) return this.now();
    return Math.round(anchor.time - (anchor.endSample - sample) / rx.sampleRate * 1000);
  }

  /** Mean confidence of recent characters, or null when too few were decoded. */
  private recentDecodeQuality(): number | null {
    const since = this.now() - QUALITY_WINDOW_MS;
    const recent = this.recentQuality.filter((item) => item.at >= since);
    if (recent.length < QUALITY_MIN_CHARACTERS) return null;
    return recent.reduce((sum, item) => sum + item.confidence, 0) / recent.length;
  }

  private rememberTranscript(characters: RttyReceivedCharacter[], replace = false): void {
    this.transcriptSnapshot = replace ? characters.slice(-TRANSCRIPT_SNAPSHOT_LIMIT) : this.transcriptSnapshot.concat(characters);
    if (this.transcriptSnapshot.length > TRANSCRIPT_SNAPSHOT_LIMIT) {
      this.transcriptSnapshot = this.transcriptSnapshot.slice(-TRANSCRIPT_SNAPSHOT_LIMIT);
    }
  }

  private flushCharacters(rx: RxState): void {
    if (rx.characters.length === 0) return;
    const characters = rx.characters;
    rx.characters = [];
    this.rememberTranscript(characters);
    this.emit('decoderEvent', {
      kind: 'characters',
      sessionId: this.rxSessionId,
      sequence: this.rxSequence++,
      characters,
    });
  }

  private emitDecoderStatus(): void {
    this.emit('decoderStatus', this.getDecoderStatus());
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Both tones above the noise and close in level: the tones sit on an RTTY signal. */
function tonesBalanced(markDb: number, spaceDb: number): boolean {
  const weak = Math.min(markDb, spaceDb);
  return weak >= LOCK_MIN_TONE_DB && Math.max(markDb, spaceDb) - weak <= LOCK_MAX_TONE_IMBALANCE_DB;
}

function textOf(characters: RttyReceivedCharacter[]): string {
  return characters.map((character) => character.ch).join('');
}

/** Jaccard similarity of the word sets of two texts (1 = same words). */
export function wordSimilarity(a: string, b: string): number {
  const words = (text: string) => new Set(text.toUpperCase().split(/\s+/).filter((word) => word.length > 1));
  const left = words(a);
  const right = words(b);
  if (left.size === 0 && right.size === 0) return 1;
  let common = 0;
  for (const word of left) if (right.has(word)) common += 1;
  return common / (left.size + right.size - common);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Displays line breaks once whether the sender uses CR, LF or CR LF; null drops the character. */
function foldLineBreak(state: { lastWasCarriageReturn: boolean }, ch: string): string | null {
  if (ch === '\r') {
    state.lastWasCarriageReturn = true;
    return '\n';
  }
  if (ch === '\n' && state.lastWasCarriageReturn) {
    state.lastWasCarriageReturn = false;
    return null;
  }
  state.lastWasCarriageReturn = false;
  return ch;
}

/**
 * Normalises operator text for transmission: line breaks become `\n` (sent as
 * CR LF) and `{RX}` is removed and requests the end of the transmission.
 */
export function normalizeOutgoingText(text: string): { text: string; finish: boolean } {
  let finish = false;
  const withoutRx = text.replace(/\{RX\}/gi, () => {
    finish = true;
    return '';
  });
  return { text: withoutRx.replace(/\r\n?/g, '\n').toUpperCase(), finish };
}
