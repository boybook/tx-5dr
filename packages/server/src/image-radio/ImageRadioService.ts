import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EventEmitter } from 'eventemitter3';
import type {
  ImageFamily,
  ImageFaxReceiveProfile,
  ImageFaxCalibrationPoint,
  FaxCalibrationCommandResult,
  FaxCalibrationResetCommand,
  FaxCalibrationSetCommand,
  ImagePaperBoundary,
  ImagePaperSaveCommand,
  ImagePixelFormat,
  ImageReceiveProfile,
  ImageRadioStatus,
  ImageRxEvent,
  ImageSstvReceiveProfile,
  SstvTxStatus,
  SstvTxCommandResult,
  SstvTxEnvelopeSnapshot,
  SstvTxStartCommand,
} from '@tx5dr/contracts';
import { sanitizeCallsignInput } from '@tx5dr/contracts';
import type { FaxDecodeEvent, FaxDecoder, SstvDecodeEvent, SstvDecoder, SstvEncoder, SstvMode } from 'rasterwave-node';

import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import { createLogger } from '../utils/logger.js';
import { ImageArtifactStore } from './ImageArtifactStore.js';
import { ImageHistoryStore } from './ImageHistoryStore.js';
import { rasterwaveRuntime, type RasterwaveRuntime } from './RasterwaveRuntime.js';
import type { PhysicalTxCoordinator } from '../transmission/PhysicalTxCoordinator.js';
import type { DeterministicPlaybackSession } from '../audio/AudioStreamManager.js';
import { ImagePaperSpool, type PaperManifest } from './ImagePaperSpool.js';
import type { PaperRangeSnapshot } from './ImagePaperSpool.js';

const logger = createLogger('ImageRadioService');
const INPUT_CHUNK_MS = 100;
const NATIVE_QUEUE_SECONDS = 2;
const JS_BACKLOG_MS = 500;
const ROW_FLUSH_MS = 75;
const DEFAULT_SSTV_RECEIVE_PROFILE: ImageSstvReceiveProfile = { family: 'sstv', strategy: 'auto' };
const DEFAULT_FAX_FALLBACK: Extract<ImageFaxReceiveProfile, { strategy: 'manual' }> = {
  family: 'fax', strategy: 'manual', ioc: 'ioc576', lpm: 120,
  modulation: 'fm', centerHz: 1900, deviationHz: 400,
};
const DEFAULT_FAX_RECEIVE_PROFILE: ImageFaxReceiveProfile = { family: 'fax', strategy: 'auto' };

interface ImageRadioServiceEvents {
  status: (status: ImageRadioStatus) => void;
  rxEvent: (event: ImageRxEvent) => void;
  txStatus: (status: SstvTxStatus) => void;
}

type DecoderInstance = SstvDecoder | FaxDecoder;

interface PendingRow {
  rowIndex: number;
  width: number;
  rowRevision: number;
  completeness?: 'provisional' | 'final';
  pixelFormat: ImagePixelFormat;
  pixels: Uint8Array;
}

interface TxPreviewState {
  decoder: SstvDecoder | null;
  baseLine: number;
  mode: SstvMode;
  width: number;
  backlog: Float32Array[];
  backlogSamples: number;
  maxBacklogSamples: number;
  draining: boolean;
  drainPromise: Promise<void> | null;
  pendingDiscontinuitySamples: number;
  sampleRate: number;
  failed: boolean;
  started: boolean;
  playedSamples: number;
  rasterEndSample: number;
}

interface ActiveSstvTx {
  sessionId: string;
  operatorId: string;
  revision: number;
  playback: DeterministicPlaybackSession;
  encoder: SstvEncoder;
  leaseId?: string;
  receiveSuspended: boolean;
  preview?: TxPreviewState;
  interruptedReceiveCapture: boolean;
  envelope: SstvTxEnvelopeSnapshot;
}

export class ImageRadioService extends EventEmitter<ImageRadioServiceEvents> {
  private family: ImageFamily | null = null;
  private sstvReceiveProfile: ImageSstvReceiveProfile = DEFAULT_SSTV_RECEIVE_PROFILE;
  private faxReceiveProfile: ImageFaxReceiveProfile = DEFAULT_FAX_RECEIVE_PROFILE;
  private serviceState: ImageRadioStatus['serviceState'] = 'stopped';
  private rxState: ImageRadioStatus['rxState'] = 'off';
  private sstvCaptureActive = false;
  private decoder: DecoderInstance | null = null;
  private generation = 0;
  private inputSampleRate = 12_000;
  private inputChunk = new Float32Array(1_200);
  private inputChunkOffset = 0;
  private readonly backlog: Float32Array[] = [];
  private draining = false;
  private pendingDiscontinuitySamples = 0;
  private discontinuities = 0;
  private readonly pendingArtifactWrites = new Set<Promise<unknown>>();
  private pendingRows: PendingRow[] = [];
  private rowFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly audioListener = (samples: Float32Array, sampleRate: number) => this.acceptAudio(samples, sampleRate);
  private txStatus: SstvTxStatus = {
    phase: 'idle', revision: 0, samplesEmitted: 0, estimatedTotalSamples: 0,
  };
  private readonly txResults = new Map<string, SstvTxCommandResult>();
  private readonly saveResults = new Map<string, { artifactId: string }>();
  private readonly calibrationResults = new Map<string, FaxCalibrationCommandResult>();
  private activeTx: ActiveSstvTx | null = null;
  private readonly paper: ImagePaperSpool;
  private nativeLineOffset = 0;
  private lastFirstAvailableLine = 0;
  private skipNextInitialBoundary = false;

  constructor(
    private readonly audioStream: AudioStreamManager,
    private readonly artifacts: ImageArtifactStore,
    private readonly history: ImageHistoryStore,
    private readonly physicalTx: PhysicalTxCoordinator,
    private readonly getFrequency: () => number,
    private readonly getRadioMode: () => string | undefined,
    private readonly getOperatorCallsign: (operatorId: string) => string | undefined = () => undefined,
    private readonly runtime: RasterwaveRuntime = rasterwaveRuntime,
    paperSpool?: ImagePaperSpool,
  ) {
    super();
    this.paper = paperSpool ?? new ImagePaperSpool(path.join(tmpdir(), `tx5dr-image-paper-${randomUUID()}`));
  }

  getStatus(): ImageRadioStatus {
    const availability = this.runtime.getAvailability();
    return {
      serviceState: availability.available ? this.serviceState : 'unavailable',
      family: this.family,
      receiveProfile: this.currentReceiveProfile(),
      rxState: this.rxState,
      rxCaptureActive: this.family === 'sstv' && this.sstvCaptureActive,
      capability: {
        available: availability.available,
        reason: availability.reason,
        sstv: { rx: true, tx: true },
        fax: { rx: true, tx: false },
      },
      currentSession: this.paper.getSession(),
      tx: this.txStatus,
      nativeQueuedSamples: Math.max(0, Math.round(this.decoder?.queuedSamples ?? this.activeTx?.preview?.decoder?.queuedSamples ?? 0)),
      jsBacklogSamples: this.backlog.reduce((sum, chunk) => sum + chunk.length, 0) + (this.activeTx?.preview?.backlogSamples ?? 0),
      discontinuities: this.discontinuities,
      updatedAt: Date.now(),
    };
  }

  getPaperManifest(): PaperManifest | null { return this.paper.getManifest(); }

  renderPaperSegment(boundaryId: string): Promise<Buffer> {
    return this.paper.renderSegment(boundaryId, (snapshot) => this.correctFaxSnapshot(snapshot));
  }

  async start(family: ImageFamily): Promise<void> {
    if (this.family === family && this.serviceState === 'ready') {
      this.emitStatus();
      return;
    }
    await this.stop('mode_changed');
    await this.paper.initialize();
    await this.paper.reset();
    this.nativeLineOffset = 0;
    this.lastFirstAvailableLine = 0;
    this.family = family;
    this.sstvCaptureActive = false;
    this.serviceState = 'starting';
    this.rxState = 'searching';
    this.generation += 1;
    this.emitStatus();
    try {
      await this.artifacts.initialize();
      this.createDecoder(family, this.generation);
      this.audioStream.on('audioData', this.audioListener);
      this.serviceState = 'ready';
      this.rxState = 'searching';
      this.emitStatus();
    } catch (error) {
      this.serviceState = 'unavailable';
      this.rxState = 'error';
      logger.error('Failed to start image radio decoder', { family, error: error instanceof Error ? error.message : String(error) });
      this.emitStatus();
    }
  }

  async configureSstvReceive(profile: ImageSstvReceiveProfile): Promise<ImageRadioStatus> {
    if (profile.strategy === 'manual') {
      const supported = this.runtime.load().sstvModes().some((item) => item.mode === profile.mode);
      if (!supported) throw new Error('IMAGE_MODE_INVALID');
    }
    this.sstvReceiveProfile = profile.strategy === 'auto'
      ? DEFAULT_SSTV_RECEIVE_PROFILE
      : { family: 'sstv', strategy: 'manual', mode: profile.mode };
    if (this.family === 'sstv' && !this.activeTx) {
      await this.restartDecoder();
    } else {
      this.emitStatus();
    }
    return this.getStatus();
  }

  async configureFaxReceive(profile: ImageFaxReceiveProfile): Promise<ImageRadioStatus> {
    this.faxReceiveProfile = profile.strategy === 'auto'
      ? DEFAULT_FAX_RECEIVE_PROFILE
      : { ...profile };
    if (this.family === 'fax') await this.restartDecoder();
    else this.emitStatus();
    return this.getStatus();
  }

  private createDecoder(family: ImageFamily, generation: number): void {
    const native = this.runtime.load();
    this.inputSampleRate = this.audioStream.getInternalSampleRate();
    this.inputChunk = new Float32Array(Math.max(1, Math.round(this.inputSampleRate * INPUT_CHUNK_MS / 1000)));
    if (family === 'sstv') {
      const profile = this.sstvReceiveProfile;
      this.decoder = new native.SstvDecoder(this.inputSampleRate, {
        outputMode: 'continuousPaper', fallbackMode: 'robot36',
        manualMode: profile.strategy === 'manual' ? profile.mode as SstvMode : undefined,
        detectVis: true, detectSyncTiming: true,
        queueCapacitySamples: this.inputSampleRate * NATIVE_QUEUE_SECONDS,
      }, (event) => this.handleSstvEvent(generation, event));
      return;
    }
    const profile = this.faxReceiveProfile.strategy === 'manual' ? this.faxReceiveProfile : DEFAULT_FAX_FALLBACK;
    this.decoder = new native.FaxDecoder(this.inputSampleRate, {
      outputMode: 'continuousPaper', continuousAuto: this.faxReceiveProfile.strategy === 'auto',
      clockRecovery: 'auto',
      ioc: profile.ioc, lpm: profile.lpm,
      modulation: { kind: profile.modulation, centerHz: profile.centerHz, deviationHz: profile.deviationHz },
      queueCapacitySamples: this.inputSampleRate * NATIVE_QUEUE_SECONDS,
    }, (event) => this.handleFaxEvent(generation, event));
  }

  private async restartDecoder(): Promise<void> {
    const family = this.family;
    if (!family) return;
    this.audioStream.off('audioData', this.audioListener);
    this.flushRows();
    const previous = this.decoder;
    this.decoder = null;
    this.generation += 1;
    this.paper.setGeneration(this.generation);
    this.nativeLineOffset = this.paper.getSession()?.receivedLines ?? 0;
    this.backlog.length = 0;
    this.inputChunkOffset = 0;
    this.draining = false;
    this.pendingDiscontinuitySamples = 0;
    this.sstvCaptureActive = false;
    if (previous) {
      await previous.finish().catch(() => undefined);
      await previous.dispose().catch(() => undefined);
    }
    this.serviceState = 'starting';
    this.emitStatus();
    this.createDecoder(family, this.generation);
    this.audioStream.on('audioData', this.audioListener);
    this.serviceState = 'ready';
    this.rxState = 'receiving';
    this.emitStatus();
  }

  async stop(reason = 'stopped'): Promise<void> {
    void reason;
    this.generation += 1;
    this.audioStream.off('audioData', this.audioListener);
    this.flushRows();
    const decoder = this.decoder;
    this.decoder = null;
    this.backlog.length = 0;
    this.inputChunkOffset = 0;
    this.draining = false;
    this.pendingDiscontinuitySamples = 0;
    this.sstvCaptureActive = false;
    if (decoder) {
      await decoder.finish().catch(() => undefined);
      await decoder.dispose().catch(() => undefined);
    }
    await Promise.allSettled([...this.pendingArtifactWrites]);
    await this.paper.reset();
    this.family = null;
    this.serviceState = 'stopped';
    this.rxState = 'off';
    this.emitStatus();
  }

  reset(): void {
    if (!this.decoder) return;
    this.sstvCaptureActive = false;
    if (!this.decoder.reset()) {
      this.pendingDiscontinuitySamples += this.inputChunk.length;
      return;
    }
    this.rxState = 'receiving';
    this.emitStatus();
  }

  markSignalLost(): void {
    if (this.family !== 'fax' || !this.decoder) return;
    (this.decoder as FaxDecoder).markSignalLost();
  }

  async startSstvTx(command: SstvTxStartCommand): Promise<SstvTxCommandResult> {
    const previous = this.txResults.get(command.requestId);
    if (previous) return previous;
    const reject = (errorCode: string): SstvTxCommandResult => {
      const result = { requestId: command.requestId, accepted: false, errorCode };
      this.txResults.set(command.requestId, result);
      logger.info('SSTV transmit request rejected', {
        requestId: command.requestId,
        errorCode,
        rxState: this.rxState,
        rxCaptureActive: this.sstvCaptureActive,
        txPhase: this.txStatus.phase,
        physicalTxPhase: this.physicalTx.getSnapshot().phase,
      });
      return result;
    };
    if (this.family !== 'sstv' || this.serviceState !== 'ready') return reject('IMAGE_NOT_IN_SSTV_MODE');
    if (this.sstvCaptureActive && command.interruptActiveCapture !== true) return reject('IMAGE_RX_CAPTURE_CONFIRM_REQUIRED');
    if (this.activeTx || this.physicalTx.getSnapshot().phase !== 'idle') return reject('PHYSICAL_TX_BUSY');
    if (Math.round(this.getFrequency()) !== Math.round(command.expectedFrequency)) return reject('IMAGE_FREQUENCY_CHANGED');

    const callsign = sanitizeCallsignInput(this.getOperatorCallsign(command.operatorId));
    if (command.envelope.stationIdMode !== 'none' && !callsign) {
      return reject('IMAGE_TX_CALLSIGN_REQUIRED');
    }
    if (command.envelope.stationIdMode !== 'none' && callsign && !/^[A-Z0-9/]{1,16}$/.test(callsign)) {
      return reject('IMAGE_TX_CALLSIGN_UNSUPPORTED');
    }
    const envelope: SstvTxEnvelopeSnapshot = {
      enhancedPreamble: command.envelope.enhancedPreamble,
      stationIdMode: command.envelope.stationIdMode,
      callsign: command.envelope.stationIdMode === 'none' ? undefined : callsign,
      postImageGapMs: 500,
      endGuardMs: 300,
      cwWpm: 20,
      cwToneHz: 800,
    };

    const native = this.runtime.load();
    const modeInfo = native.sstvModes().find((item) => item.mode === command.mode);
    if (!modeInfo) return reject('IMAGE_MODE_INVALID');
    const source = await this.artifacts.readRgbPixels(command.artifactId).catch(() => null);
    if (!source || source.artifact.direction !== 'tx' || source.artifact.operatorId !== command.operatorId
      || source.artifact.width !== modeInfo.width || source.artifact.height !== modeInfo.height) {
      return reject('IMAGE_ARTIFACT_INVALID');
    }

    const interruptedReceiveCapture = this.sstvCaptureActive;
    const sessionId = randomUUID();
    const playback = this.audioStream.openDeterministicPlayback({
      playbackKind: 'sstv',
      onPlaybackChunk: (samples, sampleRate) => this.acceptTxPreviewAudio(sessionId, samples, sampleRate),
    });
    const stationId = envelope.stationIdMode === 'none'
      ? { kind: 'none' as const }
      : envelope.stationIdMode === 'fsk'
        ? { kind: 'fsk' as const, callsign: envelope.callsign! }
        : { kind: 'cw' as const, callsign: envelope.callsign!, wpm: envelope.cwWpm, toneHz: envelope.cwToneHz };
    const encoder = new native.SstvEncoder(source.pixels, command.mode as SstvMode, playback.sampleRate, {
      includeVisHeader: true,
      enhancedPreamble: envelope.enhancedPreamble,
      stationId,
      postImageGapMs: envelope.postImageGapMs,
      endGuardMs: envelope.endGuardMs,
    });
    this.activeTx = {
      sessionId, operatorId: command.operatorId, revision: 0, playback, encoder,
      receiveSuspended: false, interruptedReceiveCapture, envelope,
    };
    if (interruptedReceiveCapture) this.sstvCaptureActive = false;
    this.updateTx({
      phase: 'preparing', sessionId, requestId: command.requestId, operatorId: command.operatorId,
      artifactId: command.artifactId, mode: command.mode, revision: 0, samplesEmitted: 0,
      estimatedTotalSamples: encoder.progress.estimatedTotalSamples,
      encoderStage: encoder.progress.stage,
      envelope,
    });
    const accepted = { requestId: command.requestId, accepted: true, sessionId };
    this.txResults.set(command.requestId, accepted);
    void this.runSstvTx(command, playback, encoder, sessionId);
    return accepted;
  }

  async cancelSstvTx(command: { operatorId: string; sessionId: string; expectedRevision: number }): Promise<boolean> {
    const active = this.activeTx;
    if (!active || active.sessionId !== command.sessionId || active.operatorId !== command.operatorId || active.revision !== command.expectedRevision) return false;
    await active.playback.abort('SSTV transmission cancelled');
    if (active.leaseId && this.physicalTx.getSnapshot().leaseId === active.leaseId) {
      await this.physicalTx.forceInterrupt('SSTV transmission cancelled');
    }
    this.updateTx({ ...this.txStatus, phase: 'cancelled', revision: active.revision + 1 });
    return true;
  }

  private acceptAudio(samples: Float32Array, sampleRate: number): void {
    if (!this.decoder || this.serviceState !== 'ready' || samples.length === 0 || (this.txStatus.phase !== 'idle' && this.txStatus.phase !== 'completed' && this.txStatus.phase !== 'cancelled' && this.txStatus.phase !== 'error')) return;
    if (sampleRate !== this.inputSampleRate) {
      this.registerDiscontinuity(samples.length, 'sample_rate_changed');
      return;
    }
    let sourceOffset = 0;
    while (sourceOffset < samples.length) {
      const count = Math.min(samples.length - sourceOffset, this.inputChunk.length - this.inputChunkOffset);
      this.inputChunk.set(samples.subarray(sourceOffset, sourceOffset + count), this.inputChunkOffset);
      sourceOffset += count;
      this.inputChunkOffset += count;
      if (this.inputChunkOffset === this.inputChunk.length) {
        const ready = this.inputChunk;
        this.inputChunk = new Float32Array(ready.length);
        this.inputChunkOffset = 0;
        this.enqueueInput(ready);
      }
    }
  }

  private enqueueInput(chunk: Float32Array): void {
    const decoder = this.decoder;
    if (!decoder) return;
    if (this.draining || this.backlog.length > 0) {
      this.queueBacklog(chunk);
      return;
    }
    if (this.pendingDiscontinuitySamples > 0 && !this.sendDiscontinuity()) {
      this.queueBacklog(chunk);
      this.beginDrain();
      return;
    }
    if (!decoder.pushF32(chunk)) {
      this.queueBacklog(chunk);
      this.beginDrain();
    }
  }

  private queueBacklog(chunk: Float32Array): void {
    const maxChunks = Math.max(1, Math.floor(JS_BACKLOG_MS / INPUT_CHUNK_MS));
    if (this.backlog.length >= maxChunks) {
      const dropped = this.backlog.reduce((sum, item) => sum + item.length, 0) + chunk.length;
      this.backlog.length = 0;
      this.registerDiscontinuity(dropped, 'input_overrun');
      return;
    }
    this.backlog.push(chunk);
  }

  private beginDrain(): void {
    if (this.draining || !this.decoder) return;
    this.draining = true;
    const generation = this.generation;
    void this.decoder.drain().then(() => {
      if (generation !== this.generation || !this.decoder) return;
      this.draining = false;
      if (this.pendingDiscontinuitySamples > 0 && !this.sendDiscontinuity()) {
        this.beginDrain();
        return;
      }
      while (this.backlog.length > 0) {
        const next = this.backlog[0];
        if (!this.decoder.pushF32(next)) {
          this.beginDrain();
          return;
        }
        this.backlog.shift();
      }
      this.emitStatus();
    }).catch((error) => this.failDecoder(error));
  }

  private sendDiscontinuity(): boolean {
    if (!this.decoder || this.pendingDiscontinuitySamples <= 0) return true;
    const dropped = this.pendingDiscontinuitySamples;
    const accepted = this.family === 'sstv'
      ? (this.decoder as SstvDecoder).markDiscontinuity(dropped)
      : this.decoder.reset();
    if (accepted) this.pendingDiscontinuitySamples = 0;
    return accepted;
  }

  private registerDiscontinuity(samples: number, reason: string): void {
    void reason;
    if (this.family === 'sstv') this.sstvCaptureActive = false;
    this.pendingDiscontinuitySamples += samples;
    this.discontinuities += 1;
    this.emitStatus();
  }

  private handleSstvEvent(generation: number, event: SstvDecodeEvent): void {
    if (generation !== this.generation || this.family !== 'sstv') return;
    if (event.type === 'modeCandidate') {
      this.rxState = 'acquiring';
      this.emit('rxEvent', { type: 'signalDetected', family: 'sstv', confidence: event.confidence, candidates: event.candidates, timestamp: Date.now() });
      this.emitStatus();
    } else if (event.type === 'rasterBoundary') {
      if (event.trusted) this.sstvCaptureActive = true;
      else if (event.boundaryKind === 'protocolEnd' || event.boundaryKind === 'discontinuity' || event.boundaryKind === 'reset') this.sstvCaptureActive = false;
      this.acceptBoundary({
        nativeBoundaryId: event.boundaryId, nativeLineIndex: event.lineIndex,
        codecMode: event.mode, width: event.width, pixelFormat: 'rgb8',
        kind: event.boundaryKind, trusted: event.trusted,
        detection: event.detection, nominalHeight: event.nominalHeight,
      });
    } else if (event.type === 'rasterLineReady') {
      this.acceptPaperRow(event.lineIndex, event.pixels.length / 3, event.revision, event.pixels, event.completeness);
    } else if (event.type === 'transmissionCompleted') {
      this.sstvCaptureActive = false;
      this.trackArtifactWrite(this.savePaperRange(
        this.nativeLineOffset + event.startLine,
        this.nativeLineOffset + event.endLine,
        'protocolEnd', true,
      ));
    } else if (event.type === 'protocolObserved') {
      const width = this.runtime.load().sstvModes().find((mode) => mode.mode === event.mode)?.width ?? this.paper.getSession()?.width ?? 320;
      this.acceptProtocolMarker(event.mode, 'rgb8', width, event.detection);
    } else if (event.type === 'error') {
      this.failDecoder(new Error(event.reason));
    }
  }

  private handleFaxEvent(generation: number, event: FaxDecodeEvent): void {
    if (generation !== this.generation || this.family !== 'fax') return;
    if (event.type === 'aptDetected') {
      this.rxState = 'acquiring';
      this.emit('rxEvent', { type: 'signalDetected', family: 'fax', confidence: 1, candidates: [event.ioc], timestamp: Date.now() });
      this.emitStatus();
    } else if (event.type === 'rasterBoundary') {
      this.acceptBoundary({
        nativeBoundaryId: event.boundaryId, nativeLineIndex: event.lineIndex,
        codecMode: `${event.ioc}/${event.lpm}/${event.modulation}`,
        width: event.width, pixelFormat: 'gray8', kind: event.boundaryKind,
        trusted: event.trusted, detection: event.boundaryKind,
      });
    } else if (event.type === 'rasterLineReady') {
      this.acceptPaperRow(event.lineIndex, event.width, 0, event.pixels, 'final');
    } else if (event.type === 'clockCalibration') {
      this.acceptFaxCalibration(event.boundaryId, {
        revision: event.revision, referenceLine: this.nativeLineOffset + event.referenceLine,
        phasePixels: event.phasePixels, clockPpm: event.clockPpm,
        confidence: event.confidence, source: event.source, status: event.status,
      });
    } else if (event.type === 'transmissionCompleted') {
      this.trackArtifactWrite(this.savePaperRange(
        this.nativeLineOffset + event.startLine,
        this.nativeLineOffset + event.endLine,
        'protocolEnd', true,
      ));
    } else if (event.type === 'protocolObserved') {
      this.acceptProtocolMarker(`${event.ioc}/${event.lpm}/${event.modulation}`, 'gray8', event.width, 'aptPhasing');
    } else if (event.type === 'error') {
      this.failDecoder(new Error(event.reason));
    }
  }

  private acceptFaxCalibration(nativeBoundaryId: number, point: ImageFaxCalibrationPoint): void {
    const boundaryId = `${this.generation}:${nativeBoundaryId}`;
    const calibration = this.paper.addFaxCalibrationPoint(boundaryId, point);
    const session = this.paper.getSession();
    if (!calibration || !session) return;
    this.emit('rxEvent', {
      type: 'faxCalibration', sessionId: session.sessionId, generation: this.generation,
      revision: session.revision, calibration,
    });
    this.emitStatus();
  }

  setFaxCalibration(command: FaxCalibrationSetCommand): FaxCalibrationCommandResult {
    const previous = this.calibrationResults.get(command.requestId);
    if (previous) return previous;
    const reject = (errorCode: string): FaxCalibrationCommandResult => {
      const result = { requestId: command.requestId, accepted: false, errorCode };
      this.calibrationResults.set(command.requestId, result);
      return result;
    };
    const session = this.paper.getSession();
    if (this.family !== 'fax' || !session || session.sessionId !== command.sessionId) return reject('FAX_CALIBRATION_SESSION_CHANGED');
    const current = this.paper.getFaxCalibration(command.boundaryId);
    if (!current) return reject('FAX_CALIBRATION_SEGMENT_NOT_FOUND');
    if (command.expectedRevision !== current.revision) return reject('FAX_CALIBRATION_REVISION_CONFLICT');
    const boundary = this.paper.getManifest()?.boundaries.find((candidate) => candidate.boundaryId === command.boundaryId);
    if (!boundary || Math.abs(command.phasePixels) > boundary.width / 2) return reject('FAX_CALIBRATION_PHASE_OUT_OF_RANGE');
    const calibration = this.paper.setFaxCalibration({
      boundaryId: command.boundaryId, autoEnabled: command.autoEnabled,
      phasePixels: command.phasePixels, clockPpm: command.clockPpm,
    });
    if (!calibration) return reject('FAX_CALIBRATION_SEGMENT_NOT_FOUND');
    const result = { requestId: command.requestId, accepted: true, calibration };
    this.calibrationResults.set(command.requestId, result);
    this.emitFaxCalibration(calibration);
    return result;
  }

  resetFaxCalibration(command: FaxCalibrationResetCommand): FaxCalibrationCommandResult {
    const previous = this.calibrationResults.get(command.requestId);
    if (previous) return previous;
    const session = this.paper.getSession();
    if (this.family !== 'fax' || !session || session.sessionId !== command.sessionId) {
      const result = { requestId: command.requestId, accepted: false, errorCode: 'FAX_CALIBRATION_SESSION_CHANGED' };
      this.calibrationResults.set(command.requestId, result);
      return result;
    }
    const current = this.paper.getFaxCalibration(command.boundaryId);
    if (!current || command.expectedRevision !== current.revision) {
      const result = { requestId: command.requestId, accepted: false, errorCode: current ? 'FAX_CALIBRATION_REVISION_CONFLICT' : 'FAX_CALIBRATION_SEGMENT_NOT_FOUND' };
      this.calibrationResults.set(command.requestId, result);
      return result;
    }
    const calibration = this.paper.resetFaxCalibration(command.boundaryId)!;
    const result = { requestId: command.requestId, accepted: true, calibration };
    this.calibrationResults.set(command.requestId, result);
    this.emitFaxCalibration(calibration);
    return result;
  }

  private emitFaxCalibration(calibration: NonNullable<FaxCalibrationCommandResult['calibration']>): void {
    const session = this.paper.getSession();
    if (!session) return;
    this.emit('rxEvent', {
      type: 'faxCalibration', sessionId: session.sessionId, generation: this.generation,
      revision: session.revision, calibration,
    });
    this.emitStatus();
  }

  private async correctFaxSnapshot(snapshot: PaperRangeSnapshot): Promise<Uint8Array> {
    if (snapshot.family !== 'fax' || snapshot.pixelFormat !== 'gray8' || !snapshot.calibration) return snapshot.pixels;
    const calibration = snapshot.calibration;
    return this.runtime.load().correctFaxPaper(
      snapshot.pixels, snapshot.width, snapshot.height, snapshot.startLine,
      calibration.autoEnabled ? calibration.autoPoints : [],
      { phasePixels: calibration.manualPhasePixels, clockPpm: calibration.manualClockPpm },
    );
  }

  private currentReceiveProfile(): ImageReceiveProfile | null {
    if (this.family === 'sstv') return this.sstvReceiveProfile;
    if (this.family === 'fax') return this.faxReceiveProfile;
    return null;
  }

  private acceptBoundary(input: {
    nativeBoundaryId: number; nativeLineIndex: number; codecMode: string; width: number;
    pixelFormat: ImagePixelFormat; kind: string; trusted: boolean; detection?: string; nominalHeight?: number;
  }): void {
    const lineIndex = this.nativeLineOffset + input.nativeLineIndex;
    if (this.skipNextInitialBoundary) {
      this.skipNextInitialBoundary = false;
      if (input.kind === 'initial' && input.nativeLineIndex === 0) {
        this.rxState = 'receiving';
        this.emitStatus();
        return;
      }
    }
    const existing = this.paper.getSession();
    const kind = existing && input.kind === 'initial' ? 'manualMode' : input.kind as ImagePaperBoundary['kind'];
    const boundary: ImagePaperBoundary = {
      boundaryId: `${this.generation}:${input.nativeBoundaryId}`,
      lineIndex, kind, trusted: input.trusted,
      codecMode: input.codecMode, width: input.width, pixelFormat: input.pixelFormat,
      timestamp: Date.now(), detection: input.detection, nominalHeight: input.nominalHeight,
      source: 'rx',
    };
    this.commitPaperBoundary(boundary);
  }

  private commitPaperBoundary(boundary: ImagePaperBoundary): void {
    this.flushPendingRowsNow();
    const existing = this.paper.getSession();
    if (!existing) {
      const session = this.paper.start(this.family ?? 'sstv', this.generation, boundary);
      this.emit('rxEvent', { type: 'paperStarted', session, pixelFormat: boundary.pixelFormat });
    } else {
      this.paper.addBoundary(boundary);
    }
    const session = this.paper.getSession()!;
    this.emit('rxEvent', { type: 'boundary', sessionId: session.sessionId, generation: this.generation, revision: session.revision, boundary });
    const calibration = this.family === 'fax' ? this.paper.getFaxCalibration(boundary.boundaryId) : null;
    if (calibration) this.emit('rxEvent', {
      type: 'faxCalibration', sessionId: session.sessionId, generation: this.generation,
      revision: session.revision, calibration,
    });
    this.rxState = 'receiving';
    this.emitStatus();
  }

  private acceptProtocolMarker(codecMode: string, pixelFormat: ImagePixelFormat, width: number, detection: string): void {
    const session = this.paper.getSession();
    if (!session) return;
    const boundary: ImagePaperBoundary = {
      boundaryId: `${this.generation}:observed:${randomUUID()}`,
      lineIndex: session.receivedLines, kind: 'protocolObserved', trusted: false,
      codecMode, width, pixelFormat, timestamp: Date.now(), detection, source: 'rx',
    };
    this.paper.addMarker(boundary);
    const updated = this.paper.getSession()!;
    this.emit('rxEvent', { type: 'boundary', sessionId: updated.sessionId, generation: this.generation, revision: updated.revision, boundary });
  }

  private acceptPaperRow(nativeLineIndex: number, width: number, rowRevision: number, pixels: Uint8Array, completeness: 'provisional' | 'final'): void {
    const rowIndex = this.nativeLineOffset + nativeLineIndex;
    const pixelFormat = this.family === 'fax' ? 'gray8' : 'rgb8';
    this.appendPaperRow(rowIndex, width, pixelFormat, rowRevision, pixels, completeness);
  }

  private appendPaperRow(rowIndex: number, width: number, pixelFormat: ImagePixelFormat, rowRevision: number, pixels: Uint8Array, completeness: 'provisional' | 'final'): void {
    if (!this.paper.appendRow({ lineIndex: rowIndex, width, pixelFormat, revision: rowRevision, pixels })) return;
    const currentSession = this.paper.getSession();
    if (currentSession && currentSession.firstAvailableLine > this.lastFirstAvailableLine) {
      this.lastFirstAvailableLine = currentSession.firstAvailableLine;
      const marker = this.paper.getManifest()?.boundaries.find((boundary) => boundary.kind === 'truncated');
      if (marker) this.emit('rxEvent', { type: 'boundary', sessionId: currentSession.sessionId, generation: this.generation, revision: currentSession.revision, boundary: marker });
    }
    this.pendingRows.push({ rowIndex, width, rowRevision, completeness, pixelFormat, pixels: new Uint8Array(pixels) });
    if (this.pendingRows.length >= 8) this.flushRows();
    else if (!this.rowFlushTimer) this.rowFlushTimer = setTimeout(() => this.flushRows(), ROW_FLUSH_MS);
  }

  private flushRows(): void {
    if (this.rowFlushTimer) clearTimeout(this.rowFlushTimer);
    this.rowFlushTimer = null;
    const session = this.paper.getSession();
    if (!session || this.pendingRows.length === 0) return;
    const rows = this.pendingRows.splice(0, 8);
    this.emit('rxEvent', {
      type: 'rows', sessionId: session.sessionId, generation: this.generation,
      revision: session.revision, pixelFormat: rows[0].pixelFormat,
      rows: rows.map((row) => ({ rowIndex: row.rowIndex, width: row.width, rowRevision: row.rowRevision, completeness: row.completeness, dataBase64: Buffer.from(row.pixels).toString('base64') })),
    });
    if (this.pendingRows.length > 0) this.rowFlushTimer = setTimeout(() => this.flushRows(), 0);
  }

  private flushPendingRowsNow(): void {
    while (this.pendingRows.length > 0) this.flushRows();
  }

  async saveCurrentPaper(command: ImagePaperSaveCommand): Promise<{ artifactId: string }> {
    const previous = this.saveResults.get(command.requestId);
    if (previous) return previous;
    const session = this.paper.getSession();
    if (!session) throw new Error('IMAGE_PAPER_EMPTY');
    if (command.expectedRevision > session.revision) throw new Error('IMAGE_PAPER_REVISION_CONFLICT');
    const range = this.paper.latestManualRange();
    if (!range) throw new Error('IMAGE_PAPER_EMPTY');
    const result = await this.savePaperRange(range.startLine, range.endLine, 'manual', false, command.operatorId);
    if (!result) throw new Error('IMAGE_PAPER_SAVE_FAILED');
    const response = { artifactId: result };
    this.saveResults.set(command.requestId, response);
    return response;
  }

  private async savePaperRange(startLine: number, endLine: number, saveReason: 'manual' | 'protocolEnd', complete: boolean, operatorId?: string): Promise<string | null> {
    const session = this.paper.getSession();
    if (!session) return null;
    try {
      const snapshot = await this.paper.snapshotRange(startLine, endLine);
      if (snapshot.source !== 'rx') throw new Error('IMAGE_PAPER_RANGE_NOT_RECEIVED');
      const correctedPixels = await this.correctFaxSnapshot(snapshot);
      const artifact = await this.artifacts.save({
        family: snapshot.family, direction: 'rx', operatorId,
        codecMode: snapshot.codecMode, pixelFormat: snapshot.pixelFormat,
        width: snapshot.width, height: snapshot.height, pixels: correctedPixels,
        frequency: this.getFrequency(), radioMode: this.getRadioMode(),
        complete: complete && !snapshot.truncated, saveReason,
        captureStartedAt: snapshot.startedAt, captureEndedAt: snapshot.endedAt,
        truncated: snapshot.truncated,
        faxCalibration: snapshot.calibration,
      });
      try {
        await this.history.recordReceived(artifact);
      } catch (error) {
        await this.artifacts.delete(artifact.id).catch(() => undefined);
        throw error;
      }
      const current = this.paper.getSession();
      if (current) this.emit('rxEvent', {
        type: 'captureSaved', sessionId: current.sessionId, generation: this.generation,
        revision: current.revision, artifactId: artifact.id, previewUrl: artifact.imageUrl,
        saveReason, complete: artifact.complete, startLine, endLine,
      });
      return artifact.id;
    } catch (error) {
      logger.error('Failed to persist paper capture', { error: error instanceof Error ? error.message : String(error) });
      this.serviceState = 'degraded';
      this.emitStatus();
      return null;
    }
  }

  private failDecoder(error: unknown): void {
    logger.error('Image decoder failed', { error: error instanceof Error ? error.message : String(error) });
    this.serviceState = 'degraded';
    this.rxState = 'error';
    this.sstvCaptureActive = false;
    this.emitStatus();
  }

  private trackArtifactWrite(operation: Promise<unknown>): void {
    this.pendingArtifactWrites.add(operation);
    void operation.finally(() => this.pendingArtifactWrites.delete(operation));
  }

  private async suspendReceiveForLocalTx(sessionId: string): Promise<void> {
    const active = this.activeTx;
    if (!active || active.sessionId !== sessionId || active.receiveSuspended) return;
    active.receiveSuspended = true;
    const decoder = this.decoder;
    this.decoder = null;
    const interruptedCapture = active.interruptedReceiveCapture;
    this.sstvCaptureActive = false;
    this.inputChunkOffset = 0;
    this.backlog.length = 0;
    this.draining = false;
    this.pendingDiscontinuitySamples = 0;
    if (decoder) {
      await decoder.drain().catch((error) => {
        logger.warn('Failed to drain SSTV receive decoder before local transmit', error);
      });
      this.flushRows();
    }
    this.generation += 1;
    this.paper.setGeneration(this.generation);
    if (decoder) {
      await decoder.finish().catch(() => undefined);
      await decoder.dispose().catch(() => undefined);
    }
    this.discontinuities += 1;
    if (interruptedCapture) {
      const session = this.paper.getSession();
      if (session?.width && session.codecMode) {
        this.commitPaperBoundary({
          boundaryId: `tx:${sessionId}:rx-interrupted`, lineIndex: session.receivedLines,
          kind: 'discontinuity', trusted: false, codecMode: session.codecMode,
          width: session.width, pixelFormat: 'rgb8', timestamp: Date.now(),
          detection: 'local_transmit_interrupt', source: 'rx', txSessionId: sessionId,
        });
      }
    }
  }

  private startLocalTxPreview(
    sessionId: string,
    mode: SstvMode,
    width: number,
    sampleRate: number,
    rasterEndSample: number,
  ): void {
    const active = this.activeTx;
    if (!active || active.sessionId !== sessionId || this.family !== 'sstv') return;
    const baseLine = this.paper.getSession()?.receivedLines ?? 0;
    this.commitPaperBoundary({
      boundaryId: `tx:${sessionId}:start`, lineIndex: baseLine,
      kind: 'localTxStart', trusted: false, codecMode: mode,
      width, pixelFormat: 'rgb8', timestamp: Date.now(), detection: 'local_tx',
      source: 'localTx', txSessionId: sessionId,
    });
    const preview: TxPreviewState = {
      decoder: null, baseLine, mode, width, sampleRate,
      backlog: [], backlogSamples: 0, maxBacklogSamples: Math.max(1, Math.round(sampleRate * JS_BACKLOG_MS / 1000)),
      draining: false, drainPromise: null, pendingDiscontinuitySamples: 0,
      failed: false, started: true, playedSamples: 0, rasterEndSample,
    };
    active.preview = preview;
    try {
      const native = this.runtime.load();
      preview.decoder = new native.SstvDecoder(sampleRate, {
        outputMode: 'continuousPaper', fallbackMode: mode, manualMode: mode,
        detectVis: true, detectSyncTiming: true,
        queueCapacitySamples: sampleRate * NATIVE_QUEUE_SECONDS,
      }, (event) => this.handleLocalTxPreviewEvent(sessionId, event));
    } catch (error) {
      preview.failed = true;
      logger.warn('Failed to start local SSTV transmit preview decoder', error);
    }
  }

  private acceptTxPreviewAudio(sessionId: string, samples: Float32Array, sampleRate: number): void {
    const preview = this.activeTx?.sessionId === sessionId ? this.activeTx.preview : undefined;
    if (!preview || preview.failed || !preview.decoder || sampleRate !== preview.sampleRate || samples.length === 0) return;
    const chunkStart = preview.playedSamples;
    preview.playedSamples += samples.length;
    if (chunkStart >= preview.rasterEndSample) return;
    samples = samples.subarray(0, Math.min(samples.length, preview.rasterEndSample - chunkStart));
    if (samples.length === 0) return;
    if (!preview.draining && preview.backlog.length === 0) {
      try {
        if (preview.decoder.pushF32(samples)) return;
      } catch (error) {
        this.failLocalTxPreview(preview, error);
        return;
      }
    }
    if (preview.backlogSamples + samples.length > preview.maxBacklogSamples) {
      preview.pendingDiscontinuitySamples += preview.backlogSamples + samples.length;
      preview.backlog.length = 0;
      preview.backlogSamples = 0;
    } else {
      preview.backlog.push(new Float32Array(samples));
      preview.backlogSamples += samples.length;
    }
    this.beginLocalTxPreviewDrain(preview);
  }

  private beginLocalTxPreviewDrain(preview: TxPreviewState): void {
    if (preview.draining || preview.failed || !preview.decoder) return;
    preview.draining = true;
    const decoder = preview.decoder;
    preview.drainPromise = (async () => {
      try {
        for (;;) {
          await decoder.drain();
          if (preview.pendingDiscontinuitySamples > 0) {
            if (!decoder.markDiscontinuity(preview.pendingDiscontinuitySamples)) continue;
            preview.pendingDiscontinuitySamples = 0;
          }
          let blocked = false;
          while (preview.backlog.length > 0) {
            const chunk = preview.backlog[0];
            if (!decoder.pushF32(chunk)) {
              blocked = true;
              break;
            }
            preview.backlog.shift();
            preview.backlogSamples -= chunk.length;
          }
          if (!blocked && preview.backlog.length === 0) break;
        }
      } catch (error) {
        this.failLocalTxPreview(preview, error);
      } finally {
        preview.draining = false;
        preview.drainPromise = null;
      }
    })();
  }

  private handleLocalTxPreviewEvent(sessionId: string, event: SstvDecodeEvent): void {
    const preview = this.activeTx?.sessionId === sessionId ? this.activeTx.preview : undefined;
    if (!preview || preview.failed) return;
    if (event.type === 'rasterLineReady') {
      this.appendPaperRow(preview.baseLine + event.lineIndex, event.pixels.length / 3, 'rgb8', event.revision, event.pixels, event.completeness);
    } else if (event.type === 'error') {
      this.failLocalTxPreview(preview, new Error(event.reason));
    }
  }

  private failLocalTxPreview(preview: TxPreviewState, error: unknown): void {
    if (preview.failed) return;
    preview.failed = true;
    preview.backlog.length = 0;
    preview.backlogSamples = 0;
    logger.warn('Local SSTV transmit preview stopped; physical transmit continues', error);
  }

  private async finishLocalTxPreviewAndResume(sessionId: string, outcome: 'completed' | 'interrupted'): Promise<void> {
    const active = this.activeTx;
    if (!active || active.sessionId !== sessionId) return;
    const preview = active.preview;
    if (!preview && !active.receiveSuspended) return;
    if (preview?.decoder) {
      if (preview.drainPromise) await preview.drainPromise.catch(() => undefined);
      if (!preview.failed && (preview.backlog.length > 0 || preview.pendingDiscontinuitySamples > 0)) {
        this.beginLocalTxPreviewDrain(preview);
        if (preview.drainPromise) await preview.drainPromise.catch(() => undefined);
      }
      if (!preview.failed) await preview.decoder.finish().catch((error) => this.failLocalTxPreview(preview, error));
      this.flushRows();
      await preview.decoder.dispose().catch(() => undefined);
      preview.decoder = null;
    }
    active.preview = undefined;

    if (this.family !== 'sstv' || this.serviceState !== 'ready') {
      active.receiveSuspended = false;
      return;
    }

    this.generation += 1;
    this.paper.setGeneration(this.generation);
    this.nativeLineOffset = this.paper.getSession()?.receivedLines ?? 0;
    if (preview?.started) {
      const receiveMode = this.sstvReceiveProfile.strategy === 'manual' ? this.sstvReceiveProfile.mode as SstvMode : 'robot36';
      let receiveWidth = preview.width;
      try {
        receiveWidth = this.runtime.load().sstvModes().find((item) => item.mode === receiveMode)?.width ?? receiveWidth;
      } catch (error) {
        logger.warn('Failed to resolve restored SSTV mode width after local transmit', error);
      }
      this.commitPaperBoundary({
        boundaryId: `tx:${sessionId}:end`, lineIndex: this.nativeLineOffset,
        kind: 'localTxEnd', trusted: false, codecMode: receiveMode,
        width: receiveWidth, pixelFormat: 'rgb8', timestamp: Date.now(),
        detection: preview.failed ? 'local_tx_preview_failed' : 'local_tx', source: 'rx',
        txSessionId: sessionId, txOutcome: outcome,
      });
      this.skipNextInitialBoundary = true;
    }
    if (active.receiveSuspended && this.family === 'sstv' && this.serviceState === 'ready') {
      try {
        this.createDecoder('sstv', this.generation);
        this.rxState = 'receiving';
      } catch (error) {
        this.failDecoder(error);
      }
    }
    active.receiveSuspended = false;
    this.emitStatus();
  }

  private async runSstvTx(
    command: SstvTxStartCommand,
    playback: DeterministicPlaybackSession,
    encoder: SstvEncoder,
    sessionId: string,
  ): Promise<void> {
    let leaseId: string | undefined;
    let historyId: string | undefined;
    let historyWrite: Promise<boolean> | undefined;
    let previewFinalized = false;
    let previewOutcome: 'completed' | 'interrupted' = 'interrupted';
    try {
      const primeSamples = Math.ceil(playback.sampleRate * 0.3);
      while (!encoder.isFinished && playback.queuedAudioMs * playback.sampleRate / 1000 < primeSamples) {
        await playback.write(await encoder.readSamples(playback.frameSamples));
      }
      this.updateTx({ ...this.txStatus, phase: 'waiting_for_lease', revision: this.txStatus.revision + 1 });
      leaseId = await this.physicalTx.acquireLease({
        source: 'sstv', operatorIds: [command.operatorId], reason: `SSTV ${command.mode}`,
        playbackKind: 'sstv', deferActiveUntilAudio: true,
        interrupt: () => playback.abort('physical SSTV lease interrupted'),
        validateStart: () => {
          if (Math.round(this.getFrequency()) !== Math.round(this.artifacts.get(command.artifactId)?.frequency ?? -1)) {
            throw new Error('IMAGE_FREQUENCY_CHANGED');
          }
        },
      });
      if (this.activeTx?.sessionId !== sessionId) throw new Error('SSTV transmission superseded');
      this.activeTx.leaseId = leaseId;
      this.updateTx({ ...this.txStatus, phase: 'keying', revision: this.txStatus.revision + 1 });
      await this.suspendReceiveForLocalTx(sessionId);
      const modeInfo = this.runtime.load().sstvModes().find((item) => item.mode === command.mode);
      if (modeInfo) {
        this.startLocalTxPreview(
          sessionId,
          command.mode as SstvMode,
          modeInfo.width,
          playback.sampleRate,
          encoder.progress.rasterEndSample,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      await playback.start();
      this.physicalTx.markStreamingLeaseActive(leaseId);
      const startedAt = Date.now();
      historyId = randomUUID();
      const artifact = this.artifacts.get(command.artifactId);
      historyWrite = artifact
        ? this.history.recordTransmitStarted({
          id: historyId,
          artifact,
          operatorId: command.operatorId,
          sessionId,
          startedAt,
          envelope: this.activeTx!.envelope,
          sampleRate: playback.sampleRate,
          estimatedTotalSamples: encoder.progress.estimatedTotalSamples,
        })
          .then(() => true)
          .catch((error) => {
            logger.error('Failed to persist SSTV transmit history', { sessionId, error: error instanceof Error ? error.message : String(error) });
            return false;
          })
        : Promise.resolve(false);
      this.updateTx({ ...this.txStatus, phase: 'on_air', historyId, revision: this.txStatus.revision + 1, startedAt });

      while (!encoder.isFinished) {
        await playback.write(await encoder.readSamples(playback.frameSamples));
        const progress = encoder.progress;
        if (this.activeTx) this.activeTx.revision += 1;
        this.updateTx({
          ...this.txStatus, revision: this.activeTx?.revision ?? this.txStatus.revision + 1,
          samplesEmitted: progress.samplesEmitted,
          estimatedTotalSamples: progress.estimatedTotalSamples,
          currentRow: progress.currentRow,
          encoderStage: progress.stage,
        });
      }
      this.physicalTx.markStreamingLeaseDraining(leaseId);
      this.updateTx({ ...this.txStatus, phase: 'draining', revision: this.txStatus.revision + 1 });
      await playback.end();
      const result = await this.physicalTx.releaseLease(leaseId, 'SSTV transmission completed');
      if (!result.success || !result.physicalConfirmed) throw new Error(result.error ?? result.reason);
      if (historyId && await historyWrite) {
        await this.history.finishTransmit(historyId, 'completed').catch((error) => {
          logger.error('Failed to complete SSTV transmit history', { sessionId, error: error instanceof Error ? error.message : String(error) });
        });
      }
      previewOutcome = 'completed';
      try {
        await this.finishLocalTxPreviewAndResume(sessionId, 'completed');
        previewFinalized = true;
      } catch (previewError) {
        logger.warn('Failed to finish local SSTV transmit preview after successful transmit', previewError);
      }
      this.updateTx({ ...this.txStatus, phase: 'completed', revision: this.txStatus.revision + 1 });
    } catch (error) {
      await playback.abort(error instanceof Error ? error.message : 'SSTV transmission failed');
      if (leaseId && this.physicalTx.getSnapshot().leaseId === leaseId) await this.physicalTx.forceInterrupt('SSTV transmission failed');
      const errorCode = this.txStatus.phase === 'cancelled' ? 'IMAGE_TX_CANCELLED' : this.runtime.errorCode(error);
      if (historyId && await historyWrite) {
        await this.history.finishTransmit(historyId, 'interrupted', errorCode).catch((historyError) => {
          logger.error('Failed to interrupt SSTV transmit history', { sessionId, error: historyError instanceof Error ? historyError.message : String(historyError) });
        });
      }
      try {
        await this.finishLocalTxPreviewAndResume(sessionId, 'interrupted');
        previewFinalized = true;
      } catch (previewError) {
        logger.warn('Failed to finish local SSTV transmit preview after transmit error', previewError);
      }
      this.updateTx({
        ...this.txStatus,
        phase: this.txStatus.phase === 'cancelled' ? 'cancelled' : this.physicalTx.getSnapshot().phase === 'unknown' ? 'ptt_unknown' : 'error',
        revision: this.txStatus.revision + 1,
        errorCode,
      });
      logger.error('SSTV transmission failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!previewFinalized) {
        await this.finishLocalTxPreviewAndResume(sessionId, previewOutcome).catch((error) => {
          logger.warn('Failed to finish local SSTV transmit preview', error);
        });
      }
      await encoder.dispose().catch(() => undefined);
      if (this.activeTx?.sessionId === sessionId) this.activeTx = null;
    }
  }

  private updateTx(status: SstvTxStatus): void {
    this.txStatus = status;
    const activeTx = this.activeTx;
    if (activeTx && activeTx.sessionId === status.sessionId) activeTx.revision = status.revision;
    this.emit('txStatus', status);
    this.emitStatus();
  }

  private emitStatus(): void { this.emit('status', this.getStatus()); }
}
