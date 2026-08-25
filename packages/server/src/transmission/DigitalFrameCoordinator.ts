import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'eventemitter3';
import type {
  FrameLease,
  FramePhase,
  TransmissionIntent,
  TransmissionIntentSource,
} from './TransmissionIntent.js';
import { buildTrackId, normalizeStreamId } from './TransmissionIntent.js';

export interface TransmissionIntentRequest {
  operatorId: string;
  streamId?: string;
  source: TransmissionIntentSource;
  reason: string;
  text?: string;
  audioFrequencyHz?: number;
  decisionEpoch: number;
}

export interface PrepareDigitalFrameRequest {
  slotId: string;
  intents: TransmissionIntentRequest[];
  participantOperatorIds?: string[];
  participantTrackIds?: string[];
  nowMs?: number;
  slotEndMs?: number;
  expectedDurationMs?: number;
  playbackStartMs?: number;
}

export type FramePreparationAction = 'encode' | 'restart-current' | 'defer-next-slot';

export interface PreparedDigitalFrame {
  action: FramePreparationAction;
  frame: FrameLease | null;
  intents: TransmissionIntent[];
  reason?: string;
}

export interface PreparedParticipantRemoval {
  action: 'replace-current' | 'stop-physical' | 'deferred' | 'not-found';
  replacedFrame: FrameLease | null;
  frame: FrameLease | null;
  remainingOperatorIds: string[];
  remainingTrackIds: string[];
  reason: string;
}

export interface EncodeResultIdentity {
  frameId: string;
  operatorId: string;
  streamId?: string;
  decisionEpoch: number;
  revision: number;
}

export interface DigitalFrameCoordinatorEvents {
  frameChanged: (frame: FrameLease, reason: string) => void;
  staleCallbackDiscarded: (data: EncodeResultIdentity & { reason: string }) => void;
  terminal: (frame: FrameLease, reason: string) => void;
}

interface MutableFrame extends FrameLease {
  intents: Map<string, TransmissionIntent>;
  expectedEncodeTracks: Set<string>;
  completedEncodeTracks: Set<string>;
  preparationAction: FramePreparationAction;
  slotEndMs?: number;
  expectedDurationMs?: number;
  playbackStartMs?: number;
  replacesFrameId?: string;
}

const CANDIDATE_PHASES = new Set<FramePhase>(['requested', 'encoding', 'ready', 'prepared']);
const LIVE_PHASES = new Set<FramePhase>(['committed', 'on_air', 'draining']);

export class DigitalFrameCoordinator extends EventEmitter<DigitalFrameCoordinatorEvents> {
  private readonly frames = new Map<string, MutableFrame>();
  private readonly physicalFrameBySlot = new Map<string, string>();
  private readonly candidateFrameBySlot = new Map<string, string>();
  private readonly slotRevisions = new Map<string, number>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly physicalStartBudgetMs: number;
  private readonly tailHoldMs: number;
  private readonly maxRetainedFrames: number;
  private readonly terminalFrameIds: string[] = [];
  private staleCallbackDiscardCount = 0;

  constructor(options: {
    now?: () => number;
    idFactory?: () => string;
    physicalStartBudgetMs?: number;
    tailHoldMs?: number;
    maxRetainedFrames?: number;
  } = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.physicalStartBudgetMs = options.physicalStartBudgetMs ?? 300;
    this.tailHoldMs = options.tailHoldMs ?? 500;
    this.maxRetainedFrames = options.maxRetainedFrames ?? 256;
  }

  prepareFrame(request: PrepareDigitalFrameRequest): PreparedDigitalFrame {
    if (request.intents.length === 0) {
      return { action: 'defer-next-slot', frame: null, intents: [], reason: 'no intents' };
    }
    const physical = this.getMutablePhysicalFrame(request.slotId);
    const candidate = this.getMutableCandidateFrame(request.slotId);
    const predecessor = physical ?? (candidate && LIVE_PHASES.has(candidate.phase) ? candidate : null);
    const nowMs = request.nowMs ?? this.now();
    const action = this.resolvePreparationAction(predecessor, candidate, request, nowMs);
    const intents = request.intents.map((intent) =>
      this.materializeIntent(intent, request.slotId, predecessor?.frameId),
    );
    if (action === 'defer-next-slot') {
      return {
        action,
        frame: predecessor ? this.snapshot(predecessor) : candidate ? this.snapshot(candidate) : null,
        intents,
        reason: predecessor?.phase === 'draining'
          ? 'current frame is draining'
          : 'insufficient slot budget for a complete replacement frame',
      };
    }

    if (candidate && candidate.frameId !== predecessor?.frameId && CANDIDATE_PHASES.has(candidate.phase)) {
      candidate.superseded = true;
      this.cancelFrameInternal(candidate, 'superseded before handover');
    }

    const participantOperatorIds = Array.from(new Set([
      ...(request.participantOperatorIds ?? []),
      ...request.intents.map((intent) => intent.operatorId),
    ]));
    const participantTrackIds = Array.from(new Set([
      ...(request.participantTrackIds ?? []),
      ...intents.map((intent) => intent.trackId),
    ]));
    const revision = this.nextSlotRevision(request.slotId);
    const frame: MutableFrame = {
      frameId: this.idFactory(),
      slotId: request.slotId,
      participantOperatorIds,
      participantTrackIds,
      decisionEpoch: Math.max(...intents.map((intent) => intent.decisionEpoch)),
      revision,
      phase: 'requested',
      terminalEmitted: false,
      superseded: false,
      intents: new Map(intents.map((intent) => [intent.trackId, intent])),
      expectedEncodeTracks: new Set(intents.map((intent) => intent.trackId)),
      completedEncodeTracks: new Set(),
      preparationAction: action,
      slotEndMs: request.slotEndMs,
      expectedDurationMs: request.expectedDurationMs,
      playbackStartMs: request.playbackStartMs,
      replacesFrameId: predecessor?.frameId,
    };
    this.frames.set(frame.frameId, frame);
    this.candidateFrameBySlot.set(frame.slotId, frame.frameId);
    this.emitChanged(frame, action === 'restart-current' ? 'replacement candidate requested' : 'frame requested');
    return { action, frame: this.snapshot(frame), intents };
  }

  beginEncoding(frameId: string): FrameLease | null {
    return this.transition(frameId, new Set(['requested']), 'encoding', 'encoding started');
  }

  acceptEncodeResult(identity: EncodeResultIdentity): boolean {
    const frame = this.frames.get(identity.frameId);
    const trackId = buildTrackId(identity.operatorId, identity.streamId);
    const intent = frame?.intents.get(trackId);
    const staleReason = this.getEncodeStaleReason(frame, intent, identity);
    if (staleReason) {
      this.staleCallbackDiscardCount += 1;
      this.emit('staleCallbackDiscarded', { ...identity, reason: staleReason });
      return false;
    }
    const current = frame as MutableFrame;
    current.completedEncodeTracks.add(trackId);
    if (Array.from(current.expectedEncodeTracks)
      .every((candidateTrackId) => current.completedEncodeTracks.has(candidateTrackId))) {
      current.phase = 'ready';
      this.emitChanged(current, 'all expected encodes completed');
    }
    return true;
  }

  failEncodeResult(identity: EncodeResultIdentity, reason: string): FrameLease | null {
    const frame = this.frames.get(identity.frameId);
    const intent = frame?.intents.get(buildTrackId(identity.operatorId, identity.streamId));
    const staleReason = this.getEncodeStaleReason(frame, intent, identity);
    if (staleReason) {
      this.staleCallbackDiscardCount += 1;
      this.emit('staleCallbackDiscarded', { ...identity, reason: staleReason });
      return null;
    }
    this.cancelFrameInternal(frame as MutableFrame, reason);
    return this.snapshot(frame as MutableFrame);
  }

  prepareFrameForHandover(
    frameId: string,
    participantOperatorIds?: string[],
    participantTrackIds?: string[],
  ): FrameLease | null {
    const frame = this.frames.get(frameId);
    if (!frame || frame.phase !== 'ready') return frame ? this.snapshot(frame) : null;
    if (participantOperatorIds) frame.participantOperatorIds = Array.from(new Set(participantOperatorIds));
    if (participantTrackIds) frame.participantTrackIds = Array.from(new Set(participantTrackIds));
    frame.phase = 'prepared';
    this.emitChanged(frame, 'immutable mixed frame prepared');
    return this.snapshot(frame);
  }

  commitFrame(frameId: string): FrameLease | null {
    return this.transition(frameId, new Set(['prepared']), 'committed', 'physical handover committed');
  }

  markOnAir(frameId: string): FrameLease | null {
    const frame = this.frames.get(frameId);
    if (!frame || frame.phase !== 'committed') return frame ? this.snapshot(frame) : null;
    frame.phase = 'on_air';
    const predecessor = frame.replacesFrameId ? this.frames.get(frame.replacesFrameId) : undefined;
    this.physicalFrameBySlot.set(frame.slotId, frame.frameId);
    if (this.candidateFrameBySlot.get(frame.slotId) === frame.frameId) {
      this.candidateFrameBySlot.delete(frame.slotId);
    }
    this.emitChanged(frame, 'physical PTT and audio confirmed');
    if (predecessor && predecessor.frameId !== frame.frameId
      && predecessor.phase !== 'terminal' && predecessor.phase !== 'cancelled') {
      predecessor.superseded = true;
      this.terminalize(predecessor, 'physical lease handed over to replacement');
    }
    return this.snapshot(frame);
  }

  markDraining(frameId: string): FrameLease | null {
    return this.transition(frameId, new Set(['on_air']), 'draining', 'audio drain started');
  }

  completeFrame(frameId: string, reason: string): FrameLease | null {
    const frame = this.frames.get(frameId);
    if (!frame) return null;
    if (frame.phase === 'terminal' || frame.phase === 'cancelled') return this.snapshot(frame);
    if (CANDIDATE_PHASES.has(frame.phase)) this.cancelFrameInternal(frame, reason);
    else this.terminalize(frame, reason);
    return this.snapshot(frame);
  }

  cancelFrame(frameId: string, reason: string): FrameLease | null {
    const frame = this.frames.get(frameId);
    if (!frame || !CANDIDATE_PHASES.has(frame.phase)) return frame ? this.snapshot(frame) : null;
    this.cancelFrameInternal(frame, reason);
    return this.snapshot(frame);
  }

  deferFrame(frameId: string, reason: string): FrameLease | null {
    const frame = this.frames.get(frameId);
    if (!frame || (!CANDIDATE_PHASES.has(frame.phase) && frame.phase !== 'committed')) {
      return frame ? this.snapshot(frame) : null;
    }
    this.cancelFrameInternal(frame, reason);
    return this.snapshot(frame);
  }

  requestStrategyStop(operatorId: string, reason: string): 'cancelled' | 'deferred' | 'not-found' {
    const frame = this.findLatestFrameForOperator(operatorId);
    if (!frame) return 'not-found';
    if (CANDIDATE_PHASES.has(frame.phase)) {
      this.cancelFrameInternal(frame, reason);
      return 'cancelled';
    }
    return 'deferred';
  }

  prepareParticipantRemoval(frameId: string, operatorId: string, reason: string): PreparedParticipantRemoval {
    const source = this.frames.get(frameId);
    if (!source || !source.participantOperatorIds.includes(operatorId)) {
      return {
        action: 'not-found',
        replacedFrame: source ? this.snapshot(source) : null,
        frame: null,
        remainingOperatorIds: source?.participantOperatorIds ?? [],
        remainingTrackIds: source?.participantTrackIds ?? [],
        reason: 'operator is not part of the physical frame',
      };
    }
    const remainingTrackIds = source.participantTrackIds.filter((trackId) => (
      source.intents.get(trackId)?.operatorId !== operatorId
    ));
    const remainingOperatorIds = Array.from(new Set(
      remainingTrackIds.flatMap((trackId) => source.intents.get(trackId)?.operatorId ?? []),
    ));
    if (remainingTrackIds.length === 0) {
      return {
        action: 'stop-physical',
        replacedFrame: this.snapshot(source),
        frame: null,
        remainingOperatorIds,
        remainingTrackIds,
        reason,
      };
    }
    if (!LIVE_PHASES.has(source.phase) || source.phase === 'draining') {
      return {
        action: 'deferred',
        replacedFrame: this.snapshot(source),
        frame: null,
        remainingOperatorIds,
        remainingTrackIds,
        reason: `physical frame phase is ${source.phase}`,
      };
    }
    const pending = this.getMutableCandidateFrame(source.slotId);
    if (pending && pending.frameId !== source.frameId && CANDIDATE_PHASES.has(pending.phase)) {
      pending.superseded = true;
      this.cancelFrameInternal(pending, 'superseded by explicit participant removal');
    }
    const intents = remainingTrackIds
      .map((trackId) => source.intents.get(trackId))
      .filter((intent): intent is TransmissionIntent => Boolean(intent))
      .map((intent) => this.materializeIntent({
        operatorId: intent.operatorId!,
        streamId: intent.streamId,
        source: intent.source,
        reason,
        text: intent.text,
        audioFrequencyHz: intent.audioFrequencyHz,
        decisionEpoch: intent.decisionEpoch,
      }, source.slotId, source.frameId));
    if (intents.length !== remainingTrackIds.length) {
      return {
        action: 'deferred',
        replacedFrame: this.snapshot(source),
        frame: null,
        remainingOperatorIds,
        remainingTrackIds,
        reason: 'one or more retained participants have no transmission intent',
      };
    }
    const replacement: MutableFrame = {
      frameId: this.idFactory(),
      slotId: source.slotId,
      participantOperatorIds: remainingOperatorIds,
      participantTrackIds: remainingTrackIds,
      decisionEpoch: Math.max(...intents.map((intent) => intent.decisionEpoch)),
      revision: this.nextSlotRevision(source.slotId),
      phase: 'ready',
      terminalEmitted: false,
      superseded: false,
      intents: new Map(intents.map((intent) => [intent.trackId, intent])),
      expectedEncodeTracks: new Set(),
      completedEncodeTracks: new Set(),
      preparationAction: 'restart-current',
      slotEndMs: source.slotEndMs,
      expectedDurationMs: source.expectedDurationMs,
      playbackStartMs: source.playbackStartMs,
      replacesFrameId: source.frameId,
    };
    this.frames.set(replacement.frameId, replacement);
    this.candidateFrameBySlot.set(replacement.slotId, replacement.frameId);
    this.emitChanged(replacement, 'participant removal replacement ready');
    return {
      action: 'replace-current',
      replacedFrame: this.snapshot(source),
      frame: this.snapshot(replacement),
      remainingOperatorIds,
      remainingTrackIds,
      reason,
    };
  }

  getFrame(frameId: string): FrameLease | null {
    const frame = this.frames.get(frameId);
    return frame ? this.snapshot(frame) : null;
  }

  getSlotEndMs(frameId: string): number | undefined {
    return this.frames.get(frameId)?.slotEndMs;
  }

  getCurrentFrameForSlot(slotId: string): FrameLease | null {
    const frame = this.getMutableCandidateFrame(slotId) ?? this.getMutablePhysicalFrame(slotId);
    return frame ? this.snapshot(frame) : null;
  }

  getPhysicalFrameForSlot(slotId: string): FrameLease | null {
    const frame = this.getMutablePhysicalFrame(slotId);
    return frame ? this.snapshot(frame) : null;
  }

  getCandidateFrameForSlot(slotId: string): FrameLease | null {
    const frame = this.getMutableCandidateFrame(slotId);
    return frame ? this.snapshot(frame) : null;
  }

  getCurrentFrameForOperator(operatorId: string): FrameLease | null {
    const frame = this.findLatestFrameForOperator(operatorId);
    return frame ? this.snapshot(frame) : null;
  }

  cancelPreCommitFramesOutsideSlot(slotId: string, reason: string): FrameLease[] {
    const cancelled: FrameLease[] = [];
    for (const frame of this.frames.values()) {
      if (frame.slotId === slotId || !CANDIDATE_PHASES.has(frame.phase)) continue;
      this.cancelFrameInternal(frame, reason);
      cancelled.push(this.snapshot(frame));
    }
    return cancelled;
  }

  cancelAllPreCommitFrames(reason: string): FrameLease[] {
    const cancelled: FrameLease[] = [];
    for (const frame of this.frames.values()) {
      if (!CANDIDATE_PHASES.has(frame.phase)) continue;
      this.cancelFrameInternal(frame, reason);
      cancelled.push(this.snapshot(frame));
    }
    return cancelled;
  }

  getIntentRequests(frameId: string): TransmissionIntentRequest[] {
    const frame = this.frames.get(frameId);
    if (!frame) return [];
    return Array.from(frame.intents.values()).map((intent) => ({
      operatorId: intent.operatorId!,
      streamId: intent.streamId,
      source: intent.source,
      reason: intent.reason,
      text: intent.text,
      audioFrequencyHz: intent.audioFrequencyHz,
      decisionEpoch: intent.decisionEpoch,
    }));
  }

  getStaleCallbackDiscardCount(): number {
    return this.staleCallbackDiscardCount;
  }

  getPreparationAction(frameId: string): FramePreparationAction | null {
    return this.frames.get(frameId)?.preparationAction ?? null;
  }

  hasCompleteFrameBudget(frameId: string, nowMs: number, actualDurationMs: number): boolean {
    const frame = this.frames.get(frameId);
    if (!frame?.slotEndMs) return true;
    const expectedRemaining = frame.expectedDurationMs === undefined
      ? 0
      : Math.max(0, frame.expectedDurationMs - this.getPlaybackOffset(frame, nowMs));
    const durationMs = Math.max(expectedRemaining, actualDurationMs);
    return frame.slotEndMs - nowMs >= durationMs + this.physicalStartBudgetMs + this.tailHoldMs;
  }

  getPlaybackOffsetMs(frameId: string, nowMs: number): number {
    const frame = this.frames.get(frameId);
    return frame ? this.getPlaybackOffset(frame, nowMs) : 0;
  }

  getIntentText(frameId: string, operatorId: string, streamId?: string): string | undefined {
    return this.frames.get(frameId)?.intents.get(buildTrackId(operatorId, streamId))?.text;
  }

  getReplacedFrameId(frameId: string): string | undefined {
    return this.frames.get(frameId)?.replacesFrameId;
  }

  private resolvePreparationAction(
    predecessor: MutableFrame | null,
    candidate: MutableFrame | null,
    request: PrepareDigitalFrameRequest,
    nowMs: number,
  ): FramePreparationAction {
    if (!predecessor) {
      if (!candidate || CANDIDATE_PHASES.has(candidate.phase)) return 'encode';
      predecessor = candidate;
    }
    if (predecessor.phase === 'draining') return 'defer-next-slot';
    if (candidate && candidate.frameId !== predecessor.frameId && candidate.phase === 'committed') {
      return 'defer-next-slot';
    }
    if (request.expectedDurationMs === undefined || request.slotEndMs === undefined) {
      return 'defer-next-slot';
    }
    const requiredMs = Math.max(0, request.expectedDurationMs - this.getPlaybackOffset(predecessor, nowMs))
      + this.physicalStartBudgetMs
      + this.tailHoldMs;
    return request.slotEndMs - nowMs >= requiredMs ? 'restart-current' : 'defer-next-slot';
  }

  private getEncodeStaleReason(
    frame: MutableFrame | undefined,
    intent: TransmissionIntent | undefined,
    identity: EncodeResultIdentity,
  ): string | null {
    if (!frame) return 'frame not found';
    if (frame.phase !== 'encoding') return `frame phase is ${frame.phase}`;
    if (frame.revision !== identity.revision) return 'frame revision changed';
    if (!intent || intent.decisionEpoch !== identity.decisionEpoch) return 'decision epoch changed';
    return null;
  }

  private materializeIntent(
    request: TransmissionIntentRequest,
    slotId: string,
    replacesFrameId?: string,
  ): TransmissionIntent {
    return {
      operatorId: request.operatorId,
      streamId: normalizeStreamId(request.streamId),
      trackId: buildTrackId(request.operatorId, request.streamId),
      source: request.source,
      reason: request.reason,
      slotId,
      text: request.text,
      audioFrequencyHz: request.audioFrequencyHz,
      decisionEpoch: request.decisionEpoch,
      replacesFrameId,
    };
  }

  private transition(
    frameId: string,
    allowed: Set<FramePhase>,
    next: FramePhase,
    reason: string,
  ): FrameLease | null {
    const frame = this.frames.get(frameId);
    if (!frame || !allowed.has(frame.phase)) return frame ? this.snapshot(frame) : null;
    frame.phase = next;
    this.emitChanged(frame, reason);
    return this.snapshot(frame);
  }

  private cancelFrameInternal(frame: MutableFrame, reason: string): void {
    if (frame.phase === 'cancelled' || frame.phase === 'terminal') return;
    frame.phase = 'cancelled';
    this.emitChanged(frame, reason);
    this.emitTerminalOnce(frame, reason);
    this.releaseIndexes(frame);
    this.retainTerminalFrame(frame);
  }

  private terminalize(frame: MutableFrame, reason: string): void {
    if (frame.phase === 'terminal' || frame.phase === 'cancelled') return;
    frame.phase = 'terminal';
    this.emitChanged(frame, reason);
    this.emitTerminalOnce(frame, reason);
    this.releaseIndexes(frame);
    this.retainTerminalFrame(frame);
  }

  private releaseIndexes(frame: MutableFrame): void {
    if (this.candidateFrameBySlot.get(frame.slotId) === frame.frameId) {
      this.candidateFrameBySlot.delete(frame.slotId);
    }
    if (this.physicalFrameBySlot.get(frame.slotId) === frame.frameId) {
      this.physicalFrameBySlot.delete(frame.slotId);
    }
  }

  private emitTerminalOnce(frame: MutableFrame, reason: string): void {
    if (frame.terminalEmitted) return;
    frame.terminalEmitted = true;
    this.emit('terminal', this.snapshot(frame), reason);
  }

  private emitChanged(frame: MutableFrame, reason: string): void {
    this.emit('frameChanged', this.snapshot(frame), reason);
  }

  private retainTerminalFrame(frame: MutableFrame): void {
    this.terminalFrameIds.push(frame.frameId);
    while (this.terminalFrameIds.length > this.maxRetainedFrames) {
      const expired = this.terminalFrameIds.shift();
      if (expired) this.frames.delete(expired);
    }
  }

  private nextSlotRevision(slotId: string): number {
    const revision = (this.slotRevisions.get(slotId) ?? 0) + 1;
    this.slotRevisions.set(slotId, revision);
    return revision;
  }

  private getMutablePhysicalFrame(slotId: string): MutableFrame | null {
    const frameId = this.physicalFrameBySlot.get(slotId);
    return frameId ? this.frames.get(frameId) ?? null : null;
  }

  private getMutableCandidateFrame(slotId: string): MutableFrame | null {
    const frameId = this.candidateFrameBySlot.get(slotId);
    return frameId ? this.frames.get(frameId) ?? null : null;
  }

  private findLatestFrameForOperator(operatorId: string): MutableFrame | null {
    return Array.from(this.frames.values()).reverse().find((frame) =>
      frame.participantOperatorIds.includes(operatorId)
      && frame.phase !== 'terminal'
      && frame.phase !== 'cancelled') ?? null;
  }

  private getPlaybackOffset(frame: MutableFrame, nowMs: number): number {
    return frame.playbackStartMs === undefined ? 0 : Math.max(0, nowMs - frame.playbackStartMs);
  }

  private snapshot(frame: MutableFrame): FrameLease {
    return {
      frameId: frame.frameId,
      slotId: frame.slotId,
      participantOperatorIds: [...frame.participantOperatorIds],
      participantTrackIds: [...frame.participantTrackIds],
      decisionEpoch: frame.decisionEpoch,
      revision: frame.revision,
      phase: frame.phase,
      terminalEmitted: frame.terminalEmitted,
      superseded: frame.superseded,
    };
  }
}
