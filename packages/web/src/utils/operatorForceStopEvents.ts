export const OPERATOR_FORCE_STOP_REQUESTED_EVENT = 'tx5drOperatorForceStopRequested';

export interface OperatorForceStopRequestedDetail {
  operatorId: string;
}

export function dispatchOperatorForceStopRequested(operatorId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OperatorForceStopRequestedDetail>(
    OPERATOR_FORCE_STOP_REQUESTED_EVENT,
    { detail: { operatorId } },
  ));
}
