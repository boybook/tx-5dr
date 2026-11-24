import type { FrameMessage, SlotInfo, WSSelectedFrame } from '@tx5dr/contracts';
import type { QueuedStrategyMutationResult } from '@tx5dr/plugin-api';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { OperatorCallResult } from '../plugin/types.js';

type LastMessage = { message: FrameMessage; slotInfo: SlotInfo };

/** Queue rejection reasons to their `radio:operator.queueErrors.*` keys. */
const QUEUE_ERROR_KEYS: Record<string, string> = {
  queue_full: 'queueFull',
  invalid_target: 'invalidTarget',
  entry_not_found: 'entryNotFound',
  entry_not_retryable: 'entryNotRetryable',
  active_entry: 'activeEntry',
  version_conflict: 'versionConflict',
};

export function getQueueRejectionMessageKey(reason: string | undefined): string | undefined {
  const key = reason ? QUEUE_ERROR_KEYS[reason] : undefined;
  return key ? `radio:operator.queueErrors.${key}` : undefined;
}

export function getCallRejectionMessageKey(reason: string): string {
  return `radio:operator.callRejection.${reason}`;
}

export type OperatorTargetSelection =
  | { status: 'called' | 'queued' }
  | { status: 'rejected'; reason: string; userMessageKey?: string };

/**
 * Taking a heard station as an operator's QSO target, shared by every client
 * channel: the main WebSocket's call and queue commands and the logbook
 * page's target selection. One path keeps them answering alike.
 */
export class OperatorTargetCommandService {
  constructor(private readonly engine: DigitalRadioEngine) {}

  /** The picked frame as the strategy's last message from the station. */
  buildSelectedFrameLastMessage(selectedFrame: WSSelectedFrame | undefined): LastMessage | undefined {
    if (!selectedFrame) return undefined;
    const currentMode = this.engine.getStatus().currentMode;
    return {
      message: {
        message: selectedFrame.message,
        snr: selectedFrame.snr,
        dt: selectedFrame.dt,
        freq: selectedFrame.freq,
        confidence: 1,
      } as FrameMessage,
      slotInfo: {
        id: `manual-${selectedFrame.slotStartMs}`,
        startMs: selectedFrame.slotStartMs,
        phaseMs: 0,
        driftMs: 0,
        cycleNumber: Math.floor(selectedFrame.slotStartMs / currentMode.slotMs) % 2,
        utcSeconds: Math.floor(selectedFrame.slotStartMs / 1000),
        mode: currentMode.name,
      } as SlotInfo,
    };
  }

  /** Direct call; without a picked frame the station's latest decode is answered. */
  async requestCall(operatorId: string, callsign: string, selectedFrame?: WSSelectedFrame): Promise<OperatorCallResult> {
    const operator = this.engine.operatorManager.getOperator(operatorId);
    if (!operator) {
      throw new Error(`Operator ${operatorId} does not exist`);
    }
    const lastMessage = this.buildSelectedFrameLastMessage(selectedFrame)
      ?? this.engine.getSlotPackManager().getLastMessageFromCallsign(callsign, operatorId);
    const result = await this.engine.pluginManager.requestCall(operatorId, callsign, lastMessage, {
      submitCurrentFrame: true,
      source: 'operator-edit',
      reason: 'UI requestCall updated operator context',
    });
    this.engine.operatorManager.emitOperatorStatusUpdate(operatorId);
    return result;
  }

  enqueue(
    operatorId: string,
    callsign: string,
    selectedFrame: WSSelectedFrame | undefined,
    startIfIdle: boolean,
  ): Promise<QueuedStrategyMutationResult> {
    return this.engine.pluginManager.enqueueQueueTarget(operatorId, {
      callsign,
      lastMessage: this.buildSelectedFrameLastMessage(selectedFrame),
    }, { startIfIdle });
  }

  /**
   * Takes the station the way the operator's strategy takes targets, as a
   * double click in the decode table does: a queue entry for a target-queue
   * strategy (started at once unless the strategy waits for the operator),
   * otherwise a direct call.
   */
  async selectTarget(operatorId: string, callsign: string, selectedFrame: WSSelectedFrame): Promise<OperatorTargetSelection> {
    if (!this.engine.operatorManager.getOperator(operatorId)) {
      return { status: 'rejected', reason: 'unavailable', userMessageKey: getCallRejectionMessageKey('unavailable') };
    }
    const pluginManager = this.engine.pluginManager;
    if (pluginManager.hasTargetQueue(operatorId)) {
      const startIfIdle = pluginManager.getTargetQueueActivation(operatorId) !== 'operator-toggle';
      const result = await this.enqueue(operatorId, callsign, selectedFrame, startIfIdle);
      if (result.outcome === 'rejected') {
        const reason = result.reason ?? 'queue_command_rejected';
        return { status: 'rejected', reason, userMessageKey: getQueueRejectionMessageKey(result.reason) };
      }
      return { status: 'queued' };
    }
    const result = await this.requestCall(operatorId, callsign, selectedFrame);
    if (result.outcome === 'rejected') {
      return { status: 'rejected', reason: result.reason, userMessageKey: getCallRejectionMessageKey(result.reason) };
    }
    if (result.outcome === 'superseded') {
      // Another command for this operator took over before this one ran.
      return { status: 'rejected', reason: 'superseded' };
    }
    return { status: 'called' };
  }
}
