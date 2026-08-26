import type { ParsedFT8Message } from '@tx5dr/contracts';
import type { QSOFailureInfo } from '../../hooks.js';
import type {
  StrategyDecisionMetaV2,
  StrategyQSOCompletionEffect,
  StrategyQSOCompletionSettlement,
  StrategyStreamSnapshot,
  StreamPhysicalReceipt,
  QueuedStrategyObservationMeta,
} from '../../runtime.js';

export interface ParallelQSOQueueEntry<TData> {
  entryId: string;
  targetKey: string;
  callsign: string;
  requestedTransmitCycle?: 0 | 1;
  data: TData;
}

export interface ProtocolLaneIdentity {
  streamId: string;
  laneIndex: number;
}

export interface ProtocolLaneActivation {
  accepted: boolean;
}

export interface ProtocolLaneRelease {
  disposition: 'remove-entry' | 'retain-entry';
  reason: string;
}

export interface ProtocolLaneDecision<TData = unknown> {
  qsoCompletion?: StrategyQSOCompletionEffect;
  qsoFailure?: QSOFailureInfo;
  release?: ProtocolLaneRelease;
  entryData?: TData;
  queueChanged?: boolean;
}

export type ProtocolLaneSnapshot = Omit<
  StrategyStreamSnapshot,
  'streamId' | 'audioFrequencyHz'
>;

/** One stable RF stream that can host successive protocol sessions. */
export interface ProtocolLane<TData> {
  readonly streamId: string;
  readonly audioFrequencyHz: number;

  activate(entry: Readonly<ParallelQSOQueueEntry<TData>>): ProtocolLaneActivation;
  deactivate(reason: string): void;
  hasPendingWork(): boolean;
  shouldObserve?(): boolean;

  observe?(messages: ParsedFT8Message[], meta: QueuedStrategyObservationMeta): boolean;
  decide(
    messages: ParsedFT8Message[],
    meta: StrategyDecisionMetaV2,
  ): ProtocolLaneDecision<TData> | Promise<ProtocolLaneDecision<TData>>;

  getTransmitText(): string | null;
  getSnapshot(): ProtocolLaneSnapshot | null;
  setUserState?(stateId: string): boolean;
  invokeAction?(
    actionId: string,
    payload?: unknown,
  ): import('../../runtime.js').StrategyActionResult | void | Promise<import('../../runtime.js').StrategyActionResult | void>;

  checkpoint(): unknown;
  restore(checkpoint: unknown): void;
  onPhysicalSuccess?(receipt: StreamPhysicalReceipt): void;
  settleQSOCompletion?(settlement: StrategyQSOCompletionSettlement): boolean | void;
  reset(reason?: string): void;
}
