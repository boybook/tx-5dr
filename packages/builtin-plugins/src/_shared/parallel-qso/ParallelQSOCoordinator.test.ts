import { describe, expect, it } from 'vitest';
import type {
  ParsedFT8Message,
  QSOFailureInfo,
  QueuedStrategyObservationMeta,
  StrategyDecisionMetaV2,
  StrategyQSOCompletionEffect,
  StrategyQSOCompletionSettlement,
  StreamPhysicalReceipt,
} from '@tx5dr/plugin-api';
import { ParallelQSOCoordinator } from './ParallelQSOCoordinator.js';
import type {
  ParallelQSOQueueEntry,
  ProtocolLane,
  ProtocolLaneDecision,
  ProtocolLaneSnapshot,
} from './ProtocolLane.js';

interface TestEntryData {
  text: string;
  state?: string;
  complete?: boolean;
  fail?: boolean;
  release?: 'remove-entry' | 'retain-entry';
  keepPendingAfterDeactivate?: boolean;
  keepObserveAfterDeactivate?: boolean;
}

interface TestLaneCheckpoint {
  active?: ParallelQSOQueueEntry<TestEntryData>;
  lifecycleEpoch: number;
  physicalReceipts: StreamPhysicalReceipt[];
  settlements: StrategyQSOCompletionSettlement[];
  observed: number;
  pending: boolean;
  observeOnly: boolean;
  decisionMutations: number;
}

function completion(callsign: string, lifecycleEpoch: number): StrategyQSOCompletionEffect {
  return {
    lifecycleEpoch,
    record: {
      id: `qso-${callsign}`,
      callsign,
      frequency: 14_074_000,
      mode: 'FT8',
      startTime: 1,
      endTime: 2,
      messageHistory: [],
      myCallsign: 'BG5DRB',
    },
  };
}

class TestProtocolLane implements ProtocolLane<TestEntryData> {
  readonly physicalReceipts: StreamPhysicalReceipt[] = [];
  readonly settlements: StrategyQSOCompletionSettlement[] = [];
  private active?: ParallelQSOQueueEntry<TestEntryData>;
  private lifecycleEpoch = 0;
  private observed = 0;
  private pending = false;
  private observeOnly = false;
  private decisionGate?: Promise<void>;
  private decisionError?: Error;
  private decisionMutations = 0;

  constructor(
    readonly streamId: string,
    readonly audioFrequencyHz: number,
  ) {}

  activate(entry: Readonly<ParallelQSOQueueEntry<TestEntryData>>) {
    if (this.active) return { accepted: false };
    this.active = structuredClone(entry);
    this.lifecycleEpoch += 1;
    return { accepted: true };
  }

  deactivate(): void {
    this.pending = this.active?.data.keepPendingAfterDeactivate === true;
    this.observeOnly = this.active?.data.keepObserveAfterDeactivate === true;
    this.active = undefined;
  }

  hasPendingWork(): boolean {
    return this.active !== undefined || this.pending;
  }

  shouldObserve(): boolean {
    return this.observeOnly;
  }

  observe(_messages: ParsedFT8Message[], _meta: QueuedStrategyObservationMeta): boolean {
    if (!this.active) return false;
    this.observed += 1;
    return true;
  }

  async decide(
    _messages: ParsedFT8Message[],
    _meta: StrategyDecisionMetaV2,
  ): Promise<ProtocolLaneDecision<TestEntryData>> {
    if (this.decisionError) throw this.decisionError;
    await this.decisionGate;
    if (!this.active) return {};
    this.decisionMutations += 1;
    const failure: QSOFailureInfo | undefined = this.active.data.fail ? {
      targetCallsign: this.active.callsign,
      reason: 'timeout',
      stage: 'TX1',
    } : undefined;
    return {
      qsoCompletion: this.active.data.complete
        ? completion(this.active.callsign, this.lifecycleEpoch)
        : undefined,
      qsoFailure: failure,
      release: this.active.data.release ? {
        disposition: this.active.data.release,
        reason: failure ? 'failed' : 'complete',
      } : undefined,
    };
  }

  getTransmitText(): string | null {
    return this.active?.data.text ?? null;
  }

  getSnapshot(): ProtocolLaneSnapshot | null {
    if (!this.active) return null;
    return {
      currentState: this.active.data.state ?? 'calling',
      targetCallsign: this.active.callsign,
      qsoLifecycleEpoch: this.lifecycleEpoch,
    };
  }

  checkpoint(): TestLaneCheckpoint {
    return structuredClone({
      active: this.active,
      lifecycleEpoch: this.lifecycleEpoch,
      physicalReceipts: this.physicalReceipts,
      settlements: this.settlements,
      observed: this.observed,
      pending: this.pending,
      observeOnly: this.observeOnly,
      decisionMutations: this.decisionMutations,
    });
  }

  restore(checkpoint: unknown): void {
    const state = structuredClone(checkpoint) as TestLaneCheckpoint;
    this.active = state.active;
    this.lifecycleEpoch = state.lifecycleEpoch;
    this.physicalReceipts.splice(0, this.physicalReceipts.length, ...state.physicalReceipts);
    this.settlements.splice(0, this.settlements.length, ...state.settlements);
    this.observed = state.observed;
    this.pending = state.pending;
    this.observeOnly = state.observeOnly;
    this.decisionMutations = state.decisionMutations;
  }

  onPhysicalSuccess(receipt: StreamPhysicalReceipt): void {
    this.physicalReceipts.push(structuredClone(receipt));
  }

  settleQSOCompletion(settlement: StrategyQSOCompletionSettlement): void {
    this.settlements.push(structuredClone(settlement));
  }

  reset(): void {
    this.active = undefined;
    this.lifecycleEpoch = 0;
    this.physicalReceipts.length = 0;
    this.settlements.length = 0;
    this.observed = 0;
    this.pending = false;
    this.observeOnly = false;
    this.decisionMutations = 0;
    this.decisionGate = undefined;
    this.decisionError = undefined;
  }

  setDecisionGate(gate: Promise<void>): void { this.decisionGate = gate; }
  setDecisionError(error: Error): void { this.decisionError = error; }
  getDecisionMutations(): number { return this.decisionMutations; }
}

function createCoordinator(initialMaxStreams = 3) {
  const lanes: TestProtocolLane[] = [];
  const coordinator = new ParallelQSOCoordinator<TestEntryData>({
    maxSupportedStreams: 5,
    initialMaxStreams,
    createLane({ streamId, laneIndex }) {
      const lane = new TestProtocolLane(streamId, 1_000 + laneIndex * 100);
      lanes.push(lane);
      return lane;
    },
  });
  return { coordinator, lanes };
}

function enqueue(
  coordinator: ParallelQSOCoordinator<TestEntryData>,
  callsign: string,
  data: Partial<TestEntryData> = {},
  requestedTransmitCycle?: 0 | 1,
) {
  return coordinator.enqueue({
    targetKey: callsign,
    callsign,
    requestedTransmitCycle,
    data: { text: `${callsign} BG5DRB OL32`, ...data },
  });
}

const decisionMeta: StrategyDecisionMetaV2 = {
  epoch: 1,
  source: 'slot-auto',
  isReDecision: false,
  signal: new AbortController().signal,
};

describe('ParallelQSOCoordinator', () => {
  it('assigns stable streams in queue order and keeps incompatible cycles waiting', async () => {
    const { coordinator } = createCoordinator();
    const first = enqueue(coordinator, 'JA1AAA', {}, 1).entry!;
    const incompatible = enqueue(coordinator, 'JA2BBB', {}, 0).entry!;
    const flexible = enqueue(coordinator, 'JA3CCC').entry!;

    const fill = await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });

    expect(fill).toEqual({
      activatedEntryIds: [first.entryId, flexible.entryId],
      rejectedEntryIds: [],
      requestedTransmitCycle: 1,
    });
    expect(coordinator.getTransmissions()).toEqual([
      { streamId: 'stream-1', text: 'JA1AAA BG5DRB OL32', audioFrequencyHz: 1_000 },
      { streamId: 'stream-2', text: 'JA3CCC BG5DRB OL32', audioFrequencyHz: 1_100 },
    ]);
    expect(coordinator.getQueueSnapshot()).toMatchObject({
      activeEntryIds: [first.entryId, flexible.entryId],
      entries: [
        { entry: { callsign: 'JA1AAA' }, streamId: 'stream-1', active: true },
        { entry: { callsign: 'JA3CCC' }, streamId: 'stream-2', active: true },
        { entry: { entryId: incompatible.entryId, callsign: 'JA2BBB' }, active: false },
      ],
    });
  });

  it('shrinks without preempting active lanes and reuses the lowest stable stream', async () => {
    const { coordinator } = createCoordinator();
    const entries = ['JA1AAA', 'JA2BBB', 'JA3CCC', 'JA4DDD']
      .map((callsign) => enqueue(coordinator, callsign).entry!);
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    coordinator.setMaxStreams(1);

    expect(coordinator.getQueueSnapshot().activeEntryIds).toEqual(entries.slice(0, 3).map((entry) => entry.entryId));
    expect(await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 })).toMatchObject({
      activatedEntryIds: [],
    });

    coordinator.releaseEntry(entries[0]!.entryId, { removeEntry: true, reason: 'done' });
    coordinator.releaseEntry(entries[1]!.entryId, { removeEntry: true, reason: 'done' });
    expect(await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 })).toMatchObject({
      activatedEntryIds: [],
    });
    coordinator.releaseEntry(entries[2]!.entryId, { removeEntry: true, reason: 'done' });

    const refill = await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    expect(refill.activatedEntryIds).toEqual([entries[3]!.entryId]);
    expect(coordinator.getQueueSnapshot().entries[0]).toMatchObject({
      streamId: 'stream-1',
      entry: { entryId: entries[3]!.entryId },
    });
  });

  it('does not assign a new target to an unbound lane with protocol-owned pending work', async () => {
    const { coordinator, lanes } = createCoordinator(2);
    const leaseOwner = enqueue(coordinator, 'JA1AAA', {
      keepPendingAfterDeactivate: true,
    }).entry!;
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    coordinator.releaseEntry(leaseOwner.entryId, { removeEntry: true, reason: 'lease retained' });
    const next = enqueue(coordinator, 'JA2BBB').entry!;
    const waiting = enqueue(coordinator, 'JA3CCC').entry!;

    const fill = await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });

    expect(fill.activatedEntryIds).toEqual([next.entryId]);
    expect(coordinator.getQueueSnapshot()).toMatchObject({
      activeEntryIds: [next.entryId],
      entries: [
        { streamId: 'stream-2', entry: { entryId: next.entryId } },
        { active: false, entry: { entryId: waiting.entryId } },
      ],
    });
    expect(lanes[0]!.hasPendingWork()).toBe(true);

    const cleared = coordinator.clear(coordinator.getQueueSnapshot().version);
    expect(cleared.affectedStreamIds).toEqual(['stream-1', 'stream-2']);
    expect(lanes[0]!.hasPendingWork()).toBe(false);
  });

  it('clears a lane that only remains observable after its queue entry is gone', async () => {
    const { coordinator, lanes } = createCoordinator(1);
    const entry = enqueue(coordinator, 'JA1AAA', {
      keepObserveAfterDeactivate: true,
    }).entry!;
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    coordinator.releaseEntry(entry.entryId, { removeEntry: true, reason: 'lease retained' });
    expect(lanes[0]!.hasPendingWork()).toBe(false);
    expect(lanes[0]!.shouldObserve()).toBe(true);

    const beforeVersion = coordinator.getQueueSnapshot().version;
    const cleared = coordinator.clear(beforeVersion);

    expect(cleared.affectedStreamIds).toEqual(['stream-1']);
    expect(cleared.version).toBe(beforeVersion + 1);
    expect(lanes[0]!.shouldObserve()).toBe(false);
  });

  it('aggregates lane effects and releases only the lanes that requested it', async () => {
    const { coordinator } = createCoordinator();
    const completed = enqueue(coordinator, 'JA1AAA', {
      complete: true,
      release: 'remove-entry',
    }).entry!;
    const failed = enqueue(coordinator, 'JA2BBB', {
      fail: true,
      release: 'retain-entry',
    }).entry!;
    const active = enqueue(coordinator, 'JA3CCC').entry!;
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });

    const result = await coordinator.decide([], decisionMeta);

    expect(result.qsoCompletions).toMatchObject([{
      streamId: 'stream-1',
      record: { callsign: 'JA1AAA' },
    }]);
    expect(result.qsoFailures).toEqual([expect.objectContaining({ targetCallsign: 'JA2BBB' })]);
    expect(result.releasedEntries).toEqual([
      {
        streamId: 'stream-1',
        entryId: completed.entryId,
        disposition: 'remove-entry',
        reason: 'complete',
      },
      {
        streamId: 'stream-2',
        entryId: failed.entryId,
        disposition: 'retain-entry',
        reason: 'failed',
      },
    ]);
    expect(result.transmissions).toEqual([
      { streamId: 'stream-3', text: 'JA3CCC BG5DRB OL32', audioFrequencyHz: 1_200 },
    ]);
    expect(result.activeEntryIds).toEqual([active.entryId]);
    expect(coordinator.getQueueSnapshot().entries).toMatchObject([
      { entry: { entryId: active.entryId }, active: true },
      { entry: { entryId: failed.entryId }, active: false },
    ]);
  });

  it('routes identical physical messages and settlements by stream identity', async () => {
    const { coordinator, lanes } = createCoordinator(2);
    enqueue(coordinator, 'JA1AAA', { text: 'SAME MESSAGE' });
    enqueue(coordinator, 'JA2BBB', { text: 'SAME MESSAGE' });
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    const receipt: StreamPhysicalReceipt = {
      streamId: 'stream-2',
      text: 'SAME MESSAGE',
      audioFrequencyHz: 1_100,
      frameId: 'frame-1',
      revision: 2,
      physicalConfirmed: true,
    };

    expect(coordinator.onPhysicalReceipts([receipt])).toEqual(['stream-2']);
    expect(lanes[0]!.physicalReceipts).toHaveLength(0);
    expect(lanes[1]!.physicalReceipts).toEqual([receipt]);

    expect(coordinator.settleQSOCompletion({
      streamId: 'stream-1',
      lifecycleEpoch: 1,
      recordId: 'record-1',
      status: 'committed',
    })).toBe(true);
    expect(lanes[0]!.settlements).toHaveLength(1);
    expect(lanes[1]!.settlements).toHaveLength(0);
    expect(coordinator.settleQSOCompletion({
      lifecycleEpoch: 1,
      recordId: 'record-legacy',
      status: 'committed',
    })).toBe(false);
  });

  it('restores queue, lane, concurrency and protocol state from a cloneable checkpoint', async () => {
    const { coordinator } = createCoordinator(2);
    const first = enqueue(coordinator, 'JA1AAA').entry!;
    enqueue(coordinator, 'JA2BBB');
    enqueue(coordinator, 'JA3CCC');
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    const observationMeta: QueuedStrategyObservationMeta = {
      slotInfo: {
        id: 'slot-1',
        startMs: 0,
        utcSeconds: 0,
        phaseMs: 0,
        driftMs: 0,
        cycleNumber: 0,
        mode: 'FT8',
      },
      source: 'slot-auto',
      signal: new AbortController().signal,
    };
    coordinator.observe([], observationMeta);
    const checkpoint = structuredClone(coordinator.checkpoint());
    const beforeQueue = coordinator.getQueueSnapshot();
    const beforeStreams = coordinator.getStreams();

    coordinator.setMaxStreams(1);
    coordinator.remove(first.entryId, coordinator.getQueueSnapshot().version);
    coordinator.clear(coordinator.getQueueSnapshot().version);
    coordinator.restore(checkpoint);

    expect(coordinator.getQueueSnapshot()).toEqual(beforeQueue);
    expect(coordinator.getStreams()).toEqual(beforeStreams);
    expect(coordinator.getMaxStreams()).toBe(2);
    expect(() => structuredClone(coordinator.checkpoint())).not.toThrow();
  });

  it('waits for every lane to settle before an error can trigger checkpoint restore', async () => {
    const { coordinator, lanes } = createCoordinator(2);
    enqueue(coordinator, 'JA1AAA');
    enqueue(coordinator, 'JA2BBB');
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    const checkpoint = coordinator.checkpoint();
    let releaseDelayedLane!: () => void;
    const delayedLane = new Promise<void>((resolve) => { releaseDelayedLane = resolve; });
    lanes[0]!.setDecisionError(new Error('lane failed'));
    lanes[1]!.setDecisionGate(delayedLane);

    let rejected = false;
    const pending = coordinator.decide([], decisionMeta).catch((error) => {
      rejected = true;
      throw error;
    });
    await Promise.resolve();
    expect(rejected).toBe(false);
    expect(lanes[1]!.getDecisionMutations()).toBe(0);

    releaseDelayedLane();
    await expect(pending).rejects.toThrow('lane failed');
    expect(lanes[1]!.getDecisionMutations()).toBe(1);
    coordinator.restore(checkpoint);
    expect(lanes[1]!.getDecisionMutations()).toBe(0);
    await Promise.resolve();
    expect(lanes[1]!.getDecisionMutations()).toBe(0);
  });

  it('serializes optimistic queue mutations and keeps active rows immutable', async () => {
    const { coordinator } = createCoordinator(1);
    const first = enqueue(coordinator, 'JA1AAA').entry!;
    const secondResult = enqueue(coordinator, 'JA2BBB');
    const second = secondResult.entry!;
    expect(enqueue(coordinator, 'JA2BBB').outcome).toBe('duplicate');
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });

    expect(coordinator.reorder(first.entryId, null, coordinator.getQueueSnapshot().version)).toMatchObject({
      outcome: 'rejected',
      reason: 'active_entry',
    });
    expect(coordinator.reorder(second.entryId, null, secondResult.version)).toMatchObject({
      outcome: 'rejected',
      reason: 'version_conflict',
    });
    const currentVersion = coordinator.getQueueSnapshot().version;
    expect(coordinator.reorder(second.entryId, null, currentVersion)).toMatchObject({
      outcome: 'accepted',
      version: currentVersion,
    });
  });

  it('only observes lanes with an active binding or protocol-owned pending work', async () => {
    const { coordinator, lanes } = createCoordinator(2);
    enqueue(coordinator, 'JA1AAA');
    await coordinator.fillAvailableLanes({ currentTransmitCycle: 0 });
    const meta: QueuedStrategyObservationMeta = {
      slotInfo: {
        id: 'slot-1',
        startMs: 0,
        utcSeconds: 0,
        phaseMs: 0,
        driftMs: 0,
        cycleNumber: 0,
        mode: 'FT8',
      },
      source: 'slot-auto',
      signal: new AbortController().signal,
    };

    expect(coordinator.observe([], meta)).toBe(true);
    expect((lanes[0]!.checkpoint() as TestLaneCheckpoint).observed).toBe(1);
    expect((lanes[1]!.checkpoint() as TestLaneCheckpoint).observed).toBe(0);
  });
});
