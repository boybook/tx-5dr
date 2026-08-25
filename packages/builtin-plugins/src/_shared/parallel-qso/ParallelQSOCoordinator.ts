import type {
  ParsedFT8Message,
  QSOFailureInfo,
  StrategyDecisionMetaV2,
  StrategyQSOCompletionEffect,
  StrategyQSOCompletionSettlement,
  StrategyStreamSnapshot,
  StrategyTransmission,
  StreamPhysicalReceipt,
  QueuedStrategyObservationMeta,
} from '@tx5dr/plugin-api';
import type {
  ParallelQSOQueueEntry,
  ProtocolLane,
  ProtocolLaneIdentity,
} from './ProtocolLane.js';

export type ParallelQueueMutationReason =
  | 'queue_full'
  | 'invalid_target'
  | 'entry_not_found'
  | 'active_entry'
  | 'version_conflict';

export interface ParallelQueueMutationResult<TData> {
  outcome: 'accepted' | 'duplicate' | 'rejected';
  reason?: ParallelQueueMutationReason;
  version: number;
  entry?: ParallelQSOQueueEntry<TData>;
  affectedStreamIds: string[];
}

export interface ParallelQueueEntrySnapshot<TData> {
  entry: ParallelQSOQueueEntry<TData>;
  active: boolean;
  streamId?: string;
  audioFrequencyHz?: number;
}

export interface ParallelQueueSnapshot<TData> {
  version: number;
  maxActiveStreams: number;
  activeEntryIds: string[];
  entries: ParallelQueueEntrySnapshot<TData>[];
}

export interface ParallelQSOFillOptions<TData> {
  currentTransmitCycle: 0 | 1;
  isEligible?: (
    entry: Readonly<ParallelQSOQueueEntry<TData>>,
  ) => boolean | Promise<boolean>;
}

export interface ParallelQSOActivateEntryOptions {
  currentTransmitCycle: 0 | 1;
  streamId: string;
}

export interface ParallelQSOFillResult {
  activatedEntryIds: string[];
  rejectedEntryIds: string[];
  requestedTransmitCycle?: 0 | 1;
}

export interface ParallelQSOReleasedEntry {
  streamId: string;
  entryId: string;
  disposition: 'remove-entry' | 'retain-entry';
  reason: string;
}

export interface ParallelQSODecisionResult {
  transmissions: StrategyTransmission[];
  qsoCompletions: StrategyQSOCompletionEffect[];
  qsoFailures: QSOFailureInfo[];
  streams: StrategyStreamSnapshot[];
  activeEntryIds: string[];
  releasedEntries: ParallelQSOReleasedEntry[];
}

export interface ParallelQSOCoordinatorCheckpoint<TData> {
  version: number;
  nextEntrySequence: number;
  maxStreams: number;
  entries: ParallelQSOQueueEntry<TData>[];
  bindings: Array<{
    streamId: string;
    entryId: string;
    transmitCycle: 0 | 1;
  }>;
  lanes: Array<{
    streamId: string;
    checkpoint: unknown;
  }>;
}

export interface ParallelQSOCoordinatorOptions<TData> {
  maxSupportedStreams: number;
  initialMaxStreams: number;
  createLane(identity: ProtocolLaneIdentity): ProtocolLane<TData>;
  maxQueueSize?: number;
  entryIdPrefix?: string;
}

interface ActiveBinding {
  entryId: string;
  transmitCycle: 0 | 1;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTransmitCycle(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

/** Protocol-neutral queue and stable-lane scheduler for built-in strategies. */
export class ParallelQSOCoordinator<TData> {
  private readonly lanes: ProtocolLane<TData>[];
  private readonly lanesByStreamId = new Map<string, ProtocolLane<TData>>();
  private readonly maxSupportedStreams: number;
  private readonly maxQueueSize: number;
  private readonly entryIdPrefix: string;
  private entries: ParallelQSOQueueEntry<TData>[] = [];
  private bindings = new Map<string, ActiveBinding>();
  private version = 0;
  private nextEntrySequence = 0;
  private maxStreams: number;

  constructor(options: ParallelQSOCoordinatorOptions<TData>) {
    if (!Number.isInteger(options.maxSupportedStreams) || options.maxSupportedStreams < 1) {
      throw new Error('maxSupportedStreams must be a positive integer');
    }
    this.maxSupportedStreams = options.maxSupportedStreams;
    this.maxQueueSize = options.maxQueueSize ?? 64;
    this.entryIdPrefix = options.entryIdPrefix?.trim() || 'queue';
    this.maxStreams = this.validateMaxStreams(options.initialMaxStreams);
    this.lanes = Array.from({ length: this.maxSupportedStreams }, (_, laneIndex) => {
      const expectedStreamId = `stream-${laneIndex + 1}`;
      const lane = options.createLane({ streamId: expectedStreamId, laneIndex });
      if (lane.streamId !== expectedStreamId) {
        throw new Error(`Protocol lane returned unexpected streamId: ${lane.streamId}`);
      }
      if (!Number.isFinite(lane.audioFrequencyHz) || lane.audioFrequencyHz < 0) {
        throw new Error(`Protocol lane ${lane.streamId} returned an invalid audio frequency`);
      }
      this.lanesByStreamId.set(lane.streamId, lane);
      return lane;
    });
  }

  getMaxStreams(): number {
    return this.maxStreams;
  }

  setMaxStreams(maxStreams: number): void {
    const next = this.validateMaxStreams(maxStreams);
    if (next === this.maxStreams) return;
    this.maxStreams = next;
    this.bumpVersion();
  }

  enqueue(input: {
    targetKey: string;
    callsign: string;
    requestedTransmitCycle?: 0 | 1;
    data: TData;
  }): ParallelQueueMutationResult<TData> {
    const targetKey = input.targetKey.trim();
    const callsign = input.callsign.trim();
    if (!targetKey || !callsign
        || (input.requestedTransmitCycle !== undefined
          && !isTransmitCycle(input.requestedTransmitCycle))) {
      return this.mutationResult('rejected', 'invalid_target');
    }
    const duplicate = this.entries.find((entry) => entry.targetKey === targetKey);
    if (duplicate) return this.mutationResult('duplicate', undefined, duplicate);
    if (this.entries.length >= this.maxQueueSize) {
      return this.mutationResult('rejected', 'queue_full');
    }

    const entry: ParallelQSOQueueEntry<TData> = {
      entryId: `${this.entryIdPrefix}-${++this.nextEntrySequence}`,
      targetKey,
      callsign,
      requestedTransmitCycle: input.requestedTransmitCycle,
      data: clone(input.data),
    };
    this.entries.push(entry);
    this.bumpVersion();
    return this.mutationResult('accepted', undefined, entry);
  }

  reorder(
    entryId: string,
    beforeEntryId: string | null,
    expectedVersion: number,
  ): ParallelQueueMutationResult<TData> {
    if (expectedVersion !== this.version) {
      return this.mutationResult('rejected', 'version_conflict');
    }
    if (this.findStreamIdForEntry(entryId)) {
      return this.mutationResult('rejected', 'active_entry');
    }
    const from = this.entries.findIndex((entry) => entry.entryId === entryId);
    if (from < 0) return this.mutationResult('rejected', 'entry_not_found');
    if (beforeEntryId === entryId) return this.mutationResult('accepted');
    if (beforeEntryId && this.findStreamIdForEntry(beforeEntryId)) {
      return this.mutationResult('rejected', 'active_entry');
    }
    if (beforeEntryId && !this.entries.some((entry) => entry.entryId === beforeEntryId)) {
      return this.mutationResult('rejected', 'entry_not_found');
    }

    const waitingBefore = this.waitingEntries().map((entry) => entry.entryId);
    const waiting = this.waitingEntries().filter((entry) => entry.entryId !== entryId);
    const entry = this.entries[from]!;
    const target = beforeEntryId
      ? waiting.findIndex((candidate) => candidate.entryId === beforeEntryId)
      : waiting.length;
    waiting.splice(target < 0 ? waiting.length : target, 0, entry);
    const activeEntries = this.entries.filter((candidate) => (
      this.findStreamIdForEntry(candidate.entryId) !== undefined
    ));
    this.entries = [...activeEntries, ...waiting];
    const waitingAfter = this.waitingEntries().map((candidate) => candidate.entryId);
    if (JSON.stringify(waitingAfter) !== JSON.stringify(waitingBefore)) this.bumpVersion();
    return this.mutationResult('accepted');
  }

  remove(entryId: string, expectedVersion: number): ParallelQueueMutationResult<TData> {
    if (expectedVersion !== this.version) {
      return this.mutationResult('rejected', 'version_conflict');
    }
    const entry = this.entries.find((candidate) => candidate.entryId === entryId);
    if (!entry) return this.mutationResult('rejected', 'entry_not_found');
    const streamId = this.findStreamIdForEntry(entryId);
    if (streamId) this.releaseBinding(streamId, 'queue entry removed', true);
    this.entries = this.entries.filter((candidate) => candidate.entryId !== entryId);
    this.bumpVersion();
    return this.mutationResult('accepted', undefined, entry, streamId ? [streamId] : []);
  }

  clear(expectedVersion: number): ParallelQueueMutationResult<TData> {
    if (expectedVersion !== this.version) {
      return this.mutationResult('rejected', 'version_conflict');
    }
    if (this.entries.length === 0
        && this.bindings.size === 0
        && !this.lanes.some((lane) => lane.hasPendingWork() || lane.shouldObserve?.() === true)) {
      return this.mutationResult('accepted');
    }
    const affectedStreamIds = this.lanes
      .filter((lane) => (
        this.bindings.has(lane.streamId)
        || lane.hasPendingWork()
        || lane.shouldObserve?.() === true
      ))
      .map((lane) => lane.streamId);
    this.entries = [];
    this.bindings.clear();
    for (const lane of this.lanes) lane.reset('queue cleared');
    this.bumpVersion();
    return this.mutationResult('accepted', undefined, undefined, affectedStreamIds);
  }

  updateEntry(entryId: string, update: (data: TData) => boolean): boolean {
    const entry = this.entries.find((candidate) => candidate.entryId === entryId);
    if (!entry || update(entry.data) !== true) return false;
    this.bumpVersion();
    return true;
  }

  setRequestedTransmitCycle(entryId: string, cycle: 0 | 1): boolean {
    const entry = this.entries.find((candidate) => candidate.entryId === entryId);
    if (!entry || entry.requestedTransmitCycle === cycle) return false;
    entry.requestedTransmitCycle = cycle;
    this.bumpVersion();
    return true;
  }

  markChanged(): void {
    this.bumpVersion();
  }

  releaseEntry(
    entryId: string,
    options: { removeEntry: boolean; reason: string; resetLane?: boolean },
  ): string | undefined {
    const streamId = this.findStreamIdForEntry(entryId);
    if (!streamId) return undefined;
    this.releaseBinding(streamId, options.reason, options.resetLane === true);
    if (options.removeEntry) {
      this.entries = this.entries.filter((entry) => entry.entryId !== entryId);
    }
    this.bumpVersion();
    return streamId;
  }

  getEntry(entryId: string): ParallelQSOQueueEntry<TData> | undefined {
    const entry = this.entries.find((candidate) => candidate.entryId === entryId);
    return entry ? clone(entry) : undefined;
  }

  findEntryByTargetKey(targetKey: string): ParallelQSOQueueEntry<TData> | undefined {
    const entry = this.entries.find((candidate) => candidate.targetKey === targetKey);
    return entry ? clone(entry) : undefined;
  }

  getQueueSnapshot(): ParallelQueueSnapshot<TData> {
    const active = this.getActiveStreamIds().flatMap((streamId) => {
      const binding = this.bindings.get(streamId);
      const lane = this.lanesByStreamId.get(streamId);
      const entry = binding
        ? this.entries.find((candidate) => candidate.entryId === binding.entryId)
        : undefined;
      return binding && lane && entry ? [{
        entry: clone(entry),
        active: true,
        streamId,
        audioFrequencyHz: lane.audioFrequencyHz,
      }] : [];
    });
    const activeEntryIds = new Set(active.map((row) => row.entry.entryId));
    const waiting = this.entries
      .filter((entry) => !activeEntryIds.has(entry.entryId))
      .map((entry) => ({ entry: clone(entry), active: false }));
    return {
      version: this.version,
      maxActiveStreams: this.maxStreams,
      activeEntryIds: active.map((row) => row.entry.entryId),
      entries: [...active, ...waiting],
    };
  }

  async fillAvailableLanes(options: ParallelQSOFillOptions<TData>): Promise<ParallelQSOFillResult> {
    const activeCount = this.bindings.size;
    const capacity = Math.max(0, this.maxStreams - activeCount);
    if (capacity === 0) return { activatedEntryIds: [], rejectedEntryIds: [] };

    const eligibleLanes = this.lanes
      .slice(0, this.maxStreams)
      .filter((lane) => !this.bindings.has(lane.streamId) && !lane.hasPendingWork());
    if (eligibleLanes.length === 0) return { activatedEntryIds: [], rejectedEntryIds: [] };

    const activeCycles = new Set(Array.from(this.bindings.values(), (binding) => binding.transmitCycle));
    if (activeCycles.size > 1) throw new Error('Active protocol lanes use incompatible transmit cycles');
    let selectedCycle = activeCycles.values().next().value as 0 | 1 | undefined;
    const selected: Array<{ entry: ParallelQSOQueueEntry<TData>; lane: ProtocolLane<TData> }> = [];

    for (const entry of this.waitingEntries()) {
      if (selected.length >= Math.min(capacity, eligibleLanes.length)) break;
      if (options.isEligible && !await options.isEligible(clone(entry))) continue;
      if (entry.requestedTransmitCycle !== undefined) {
        if (selectedCycle !== undefined && entry.requestedTransmitCycle !== selectedCycle) continue;
        selectedCycle ??= entry.requestedTransmitCycle;
      }
      selected.push({ entry, lane: eligibleLanes[selected.length]! });
    }

    const transmitCycle = selectedCycle ?? options.currentTransmitCycle;
    const activatedEntryIds: string[] = [];
    const rejectedEntryIds: string[] = [];
    for (const { entry, lane } of selected) {
      const activation = lane.activate(clone(entry));
      if (!activation.accepted) {
        rejectedEntryIds.push(entry.entryId);
        continue;
      }
      this.bindings.set(lane.streamId, { entryId: entry.entryId, transmitCycle });
      activatedEntryIds.push(entry.entryId);
    }
    if (activatedEntryIds.length > 0) this.bumpVersion();
    return {
      activatedEntryIds,
      rejectedEntryIds,
      requestedTransmitCycle: activeCount === 0
        && activatedEntryIds.length > 0
        && selected.some(({ entry }) => entry.requestedTransmitCycle !== undefined)
        ? transmitCycle
        : undefined,
    };
  }

  activateEntry(
    entryId: string,
    options: ParallelQSOActivateEntryOptions,
  ): ParallelQSOFillResult {
    const entry = this.entries.find((candidate) => candidate.entryId === entryId);
    const lane = this.lanesByStreamId.get(options.streamId);
    const laneIndex = lane ? this.lanes.indexOf(lane) : -1;
    if (!entry
        || !lane
        || laneIndex < 0
        || laneIndex >= this.maxStreams
        || this.bindings.size >= this.maxStreams
        || this.findStreamIdForEntry(entryId)
        || this.bindings.has(lane.streamId)
        || lane.hasPendingWork()) {
      return { activatedEntryIds: [], rejectedEntryIds: [] };
    }

    const activeCycles = new Set(Array.from(this.bindings.values(), (binding) => binding.transmitCycle));
    if (activeCycles.size > 1) throw new Error('Active protocol lanes use incompatible transmit cycles');
    const activeCycle = activeCycles.values().next().value as 0 | 1 | undefined;
    if (activeCycle !== undefined
        && entry.requestedTransmitCycle !== undefined
        && entry.requestedTransmitCycle !== activeCycle) {
      return { activatedEntryIds: [], rejectedEntryIds: [] };
    }
    const transmitCycle = activeCycle ?? entry.requestedTransmitCycle ?? options.currentTransmitCycle;
    const activation = lane.activate(clone(entry));
    if (!activation.accepted) {
      return { activatedEntryIds: [], rejectedEntryIds: [entryId] };
    }
    this.bindings.set(lane.streamId, { entryId, transmitCycle });
    this.bumpVersion();
    return {
      activatedEntryIds: [entryId],
      rejectedEntryIds: [],
      requestedTransmitCycle: activeCycles.size === 0 && entry.requestedTransmitCycle !== undefined
        ? transmitCycle
        : undefined,
    };
  }

  observe(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean {
    let changed = false;
    for (const lane of this.workingLanes()) {
      if (lane.observe?.(messages, meta) === true) changed = true;
    }
    if (changed) this.bumpVersion();
    return changed;
  }

  async decide(
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMetaV2,
  ): Promise<ParallelQSODecisionResult> {
    const lanes = this.workingLanes();
    const settledDecisions = await Promise.allSettled(lanes.map(async (lane) => ({
      lane,
      decision: await lane.decide(messages, meta),
    })));
    const rejectedDecision = settledDecisions.find((result) => result.status === 'rejected');
    if (rejectedDecision?.status === 'rejected') throw rejectedDecision.reason;
    const decisions = settledDecisions.map((result) => {
      if (result.status !== 'fulfilled') throw result.reason;
      return result.value;
    });
    const qsoCompletions: StrategyQSOCompletionEffect[] = [];
    const qsoFailures: QSOFailureInfo[] = [];
    const releasedEntries: ParallelQSOReleasedEntry[] = [];
    let queueChanged = false;

    for (const { lane, decision } of decisions) {
      const binding = this.bindings.get(lane.streamId);
      if (binding && decision.entryData !== undefined) {
        const entry = this.entries.find((candidate) => candidate.entryId === binding.entryId);
        if (entry) entry.data = clone(decision.entryData);
      }
      if (decision.qsoCompletion) {
        qsoCompletions.push({ ...clone(decision.qsoCompletion), streamId: lane.streamId });
      }
      if (decision.qsoFailure) qsoFailures.push(clone(decision.qsoFailure));
      if (decision.queueChanged || decision.entryData !== undefined) queueChanged = true;
      if (!decision.release) continue;
      if (!binding) continue;
      releasedEntries.push({
        streamId: lane.streamId,
        entryId: binding.entryId,
        disposition: decision.release.disposition,
        reason: decision.release.reason,
      });
      this.releaseBinding(lane.streamId, decision.release.reason, false);
      if (decision.release.disposition === 'remove-entry') {
        this.entries = this.entries.filter((entry) => entry.entryId !== binding.entryId);
      }
      queueChanged = true;
    }
    if (queueChanged) this.bumpVersion();
    return {
      transmissions: this.getTransmissions(),
      qsoCompletions,
      qsoFailures,
      streams: this.getStreams(),
      activeEntryIds: this.getQueueSnapshot().activeEntryIds,
      releasedEntries,
    };
  }

  getTransmissions(): StrategyTransmission[] {
    return this.lanes.flatMap((lane) => {
      const text = lane.getTransmitText();
      if (text === null || text.trim().length === 0) return [];
      return [{ streamId: lane.streamId, text, audioFrequencyHz: lane.audioFrequencyHz }];
    });
  }

  getStreams(): StrategyStreamSnapshot[] {
    return this.lanes.flatMap((lane) => {
      const snapshot = lane.getSnapshot();
      return snapshot ? [{
        ...clone(snapshot),
        streamId: lane.streamId,
        audioFrequencyHz: lane.audioFrequencyHz,
      }] : [];
    });
  }

  onPhysicalReceipts(receipts: StreamPhysicalReceipt[]): string[] {
    const handled: string[] = [];
    for (const receipt of receipts) {
      const lane = this.lanesByStreamId.get(receipt.streamId);
      if (!lane?.onPhysicalSuccess) continue;
      lane.onPhysicalSuccess(clone(receipt));
      handled.push(receipt.streamId);
    }
    return handled;
  }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): boolean {
    if (!settlement.streamId) return false;
    const lane = this.lanesByStreamId.get(settlement.streamId);
    if (!lane?.settleQSOCompletion) return false;
    if (lane.settleQSOCompletion(clone(settlement)) === true) this.bumpVersion();
    return true;
  }

  checkpoint(): ParallelQSOCoordinatorCheckpoint<TData> {
    return clone({
      version: this.version,
      nextEntrySequence: this.nextEntrySequence,
      maxStreams: this.maxStreams,
      entries: this.entries,
      bindings: this.getActiveStreamIds().map((streamId) => ({
        streamId,
        entryId: this.bindings.get(streamId)!.entryId,
        transmitCycle: this.bindings.get(streamId)!.transmitCycle,
      })),
      lanes: this.lanes.map((lane) => ({
        streamId: lane.streamId,
        checkpoint: lane.checkpoint(),
      })),
    });
  }

  restore(checkpoint: ParallelQSOCoordinatorCheckpoint<TData>): void {
    this.validateCheckpoint(checkpoint);
    this.version = checkpoint.version;
    this.nextEntrySequence = checkpoint.nextEntrySequence;
    this.maxStreams = checkpoint.maxStreams;
    this.entries = clone(checkpoint.entries);
    this.bindings = new Map(checkpoint.bindings.map((binding) => [binding.streamId, {
      entryId: binding.entryId,
      transmitCycle: binding.transmitCycle,
    }]));
    for (const laneState of checkpoint.lanes) {
      this.lanesByStreamId.get(laneState.streamId)!.restore(clone(laneState.checkpoint));
    }
  }

  reset(reason?: string): void {
    this.entries = [];
    this.bindings.clear();
    this.version = 0;
    this.nextEntrySequence = 0;
    for (const lane of this.lanes) lane.reset(reason);
  }

  private workingLanes(): ProtocolLane<TData>[] {
    return this.lanes.filter((lane) => (
      this.bindings.has(lane.streamId)
      || lane.hasPendingWork()
      || lane.shouldObserve?.() === true
    ));
  }

  private waitingEntries(): ParallelQSOQueueEntry<TData>[] {
    const activeEntryIds = new Set(Array.from(this.bindings.values(), (binding) => binding.entryId));
    return this.entries.filter((entry) => !activeEntryIds.has(entry.entryId));
  }

  private getActiveStreamIds(): string[] {
    return this.lanes
      .filter((lane) => this.bindings.has(lane.streamId))
      .map((lane) => lane.streamId);
  }

  private findStreamIdForEntry(entryId: string): string | undefined {
    return this.getActiveStreamIds().find((streamId) => this.bindings.get(streamId)?.entryId === entryId);
  }

  private releaseBinding(streamId: string, reason: string, resetLane: boolean): void {
    const lane = this.lanesByStreamId.get(streamId);
    if (!lane) return;
    this.bindings.delete(streamId);
    if (resetLane) lane.reset(reason);
    else lane.deactivate(reason);
  }

  private mutationResult(
    outcome: ParallelQueueMutationResult<TData>['outcome'],
    reason?: ParallelQueueMutationReason,
    entry?: ParallelQSOQueueEntry<TData>,
    affectedStreamIds: string[] = [],
  ): ParallelQueueMutationResult<TData> {
    return {
      outcome,
      reason,
      version: this.version,
      entry: entry ? clone(entry) : undefined,
      affectedStreamIds,
    };
  }

  private bumpVersion(): void {
    this.version += 1;
  }

  private validateMaxStreams(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > this.maxSupportedStreams) {
      throw new Error(`maxStreams must be an integer from 1 to ${this.maxSupportedStreams}`);
    }
    return value;
  }

  private validateCheckpoint(checkpoint: ParallelQSOCoordinatorCheckpoint<TData>): void {
    if (!checkpoint || typeof checkpoint !== 'object'
        || !Number.isInteger(checkpoint.version) || checkpoint.version < 0
        || !Number.isInteger(checkpoint.nextEntrySequence) || checkpoint.nextEntrySequence < 0
        || !Array.isArray(checkpoint.entries)
        || !Array.isArray(checkpoint.bindings)
        || !Array.isArray(checkpoint.lanes)) {
      throw new Error('Invalid parallel QSO coordinator checkpoint');
    }
    this.validateMaxStreams(checkpoint.maxStreams);
    const entryIds = new Set(checkpoint.entries.map((entry) => entry.entryId));
    if (entryIds.size !== checkpoint.entries.length) {
      throw new Error('Parallel QSO checkpoint contains duplicate entry IDs');
    }
    const bindingStreams = new Set<string>();
    const bindingEntries = new Set<string>();
    for (const binding of checkpoint.bindings) {
      if (!this.lanesByStreamId.has(binding.streamId)
          || !entryIds.has(binding.entryId)
          || !isTransmitCycle(binding.transmitCycle)
          || bindingStreams.has(binding.streamId)
          || bindingEntries.has(binding.entryId)) {
        throw new Error('Parallel QSO checkpoint contains an invalid active binding');
      }
      bindingStreams.add(binding.streamId);
      bindingEntries.add(binding.entryId);
    }
    if (checkpoint.lanes.length !== this.lanes.length
        || checkpoint.lanes.some((lane, index) => lane.streamId !== this.lanes[index]!.streamId)) {
      throw new Error('Parallel QSO checkpoint lane identities do not match this coordinator');
    }
  }
}
