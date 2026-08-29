import type {
  AssistedQueueRow,
  AssistedQueueSnapshot,
  OperatorStatus,
  PluginStatus,
  WSSelectedFrame,
} from '@tx5dr/contracts';
import { extractBaseCallsign } from '@tx5dr/core';

export const ASSISTED_QUEUE_STRATEGY_ID = 'assisted-qso-queue';
export const QUEUE_VISIBLE_ROW_COUNT = 3;
export const QUEUE_ROW_HEIGHT_PX = 28;
export const QUEUE_BODY_HEIGHT_PX = QUEUE_VISIBLE_ROW_COUNT * QUEUE_ROW_HEIGHT_PX;

export type OperatorTargetAction = 'enqueue-and-start' | 'enqueue-only' | 'request-call';

interface OperatorTargetService {
  enqueueQueueTarget(
    operatorId: string,
    callsign: string,
    selectedFrame?: WSSelectedFrame,
    options?: { startIfIdle?: boolean },
  ): void;
  sendRequestCall(operatorId: string, callsign: string, selectedFrame?: WSSelectedFrame): void;
}

export function isTargetQueueStrategy(
  operator: OperatorStatus | undefined,
  plugins: PluginStatus[] = [],
): boolean {
  if (!operator) return false;
  if (operator.strategy.name === ASSISTED_QUEUE_STRATEGY_ID) return true;
  return plugins.some((plugin) =>
    plugin.name === operator.strategy.name && plugin.strategyFeatures?.targetQueue === 1,
  );
}

export function resolveOperatorTargetAction(
  operator: OperatorStatus | undefined,
  plugins: PluginStatus[] = [],
): OperatorTargetAction {
  if (!isTargetQueueStrategy(operator, plugins)) return 'request-call';
  const queueActivation = plugins.find((plugin) => plugin.name === operator?.strategy.name)
    ?.strategyFeatures?.queueActivation;
  return queueActivation === 'operator-toggle' ? 'enqueue-only' : 'enqueue-and-start';
}

export function isQueueTargetAction(action: OperatorTargetAction): boolean {
  return action !== 'request-call';
}

export function submitOperatorTarget(
  service: OperatorTargetService,
  action: OperatorTargetAction,
  operatorId: string,
  callsign: string,
  selectedFrame?: WSSelectedFrame,
): void {
  if (isQueueTargetAction(action)) {
    service.enqueueQueueTarget(operatorId, callsign, selectedFrame, {
      startIfIdle: action === 'enqueue-and-start',
    });
    return;
  }
  service.sendRequestCall(operatorId, callsign, selectedFrame);
}

export function shouldRenderOperatorQueue(
  operator: OperatorStatus,
  plugins: PluginStatus[] = [],
): operator is OperatorStatus & { runtime: { queue: AssistedQueueSnapshot } } {
  return isTargetQueueStrategy(operator, plugins) && Boolean(operator.runtime?.queue);
}

export function buildQueueCallsignOrder(
  queue: AssistedQueueSnapshot | undefined,
): Readonly<Record<string, number>> {
  if (!queue) return {};
  return queue.rows.reduce<Record<string, number>>((orders, row, index) => {
    orders[extractBaseCallsign(row.callsign)] = index + 1;
    return orders;
  }, {});
}

export function getNewQueueEntryIds(
  knownEntryIds: ReadonlySet<string>,
  rows: readonly AssistedQueueRow[],
): string[] {
  return rows
    .map((row) => row.entryId)
    .filter((entryId) => !knownEntryIds.has(entryId));
}

export function getQueueBeforeEntryId(rows: AssistedQueueRow[], entryId: string): string | null | undefined {
  const index = rows.findIndex((row) => row.entryId === entryId);
  if (index < 0) return undefined;
  return rows[index + 1]?.entryId ?? null;
}
