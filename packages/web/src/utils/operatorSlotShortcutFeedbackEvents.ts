import type { OperatorRuntimeSlot } from '@tx5dr/contracts';

export const OPERATOR_SLOT_SHORTCUT_FEEDBACK_EVENT = 'tx5drOperatorSlotShortcutFeedback';

export interface OperatorSlotShortcutFeedbackDetail {
  operatorId: string;
  slot: OperatorRuntimeSlot;
}

export function dispatchOperatorSlotShortcutFeedback(operatorId: string, slot: OperatorRuntimeSlot): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<OperatorSlotShortcutFeedbackDetail>(
    OPERATOR_SLOT_SHORTCUT_FEEDBACK_EVENT,
    { detail: { operatorId, slot } },
  ));
}
