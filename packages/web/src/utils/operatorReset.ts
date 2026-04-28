import type { OperatorRuntimeSlot, OperatorStatus, WSSetOperatorContextMessage } from '@tx5dr/contracts';
import type { RadioService } from '../services/radioService';

type OperatorResetRadioService = Pick<
  RadioService,
  | 'setOperatorContext'
  | 'setOperatorRuntimeState'
  | 'stopOperator'
  | 'removeOperatorFromTransmission'
>;

const CQ_SLOT: OperatorRuntimeSlot = 'TX6';

const hasText = (value: unknown): boolean => (
  typeof value === 'string' && value.trim().length > 0
);

const hasNonDefaultReport = (value: unknown): boolean => (
  typeof value === 'number' && Number.isFinite(value) && value !== 0
);

const getOperatorSlot = (operator: OperatorStatus): string | undefined => (
  operator.currentSlot ?? operator.strategy.state
);

export interface ResetOperatorsForOperatingStateChangeOptions {
  operators: OperatorStatus[];
  radioService: OperatorResetRadioService | null | undefined;
}

export interface ResetOperatorsForOperatingStateChangeResult {
  operatorsChanged: number;
}

export const shouldResetOperatorForOperatingStateChange = (operator: OperatorStatus): boolean => (
  hasText(operator.context.targetCall)
  || hasText(operator.context.targetGrid)
  || hasNonDefaultReport(operator.context.reportSent)
  || hasNonDefaultReport(operator.context.reportReceived)
  || getOperatorSlot(operator) !== CQ_SLOT
  || operator.isTransmitting
  || Boolean(operator.isInActivePTT)
);

export const resetOperatorsForOperatingStateChange = ({
  operators,
  radioService,
}: ResetOperatorsForOperatingStateChangeOptions): ResetOperatorsForOperatingStateChangeResult => {
  if (!radioService) {
    return { operatorsChanged: 0 };
  }

  let operatorsChanged = 0;
  const clearContext: WSSetOperatorContextMessage['data']['context'] = {
    targetCallsign: '',
    targetGrid: '',
    reportSent: 0,
    reportReceived: 0,
  };

  for (const operator of operators) {
    if (!shouldResetOperatorForOperatingStateChange(operator)) {
      continue;
    }

    operatorsChanged += 1;

    if (
      hasText(operator.context.targetCall)
      || hasText(operator.context.targetGrid)
      || hasNonDefaultReport(operator.context.reportSent)
      || hasNonDefaultReport(operator.context.reportReceived)
    ) {
      radioService.setOperatorContext(operator.id, clearContext);
    }

    if (getOperatorSlot(operator) !== CQ_SLOT) {
      radioService.setOperatorRuntimeState(operator.id, CQ_SLOT);
    }

    if (operator.isTransmitting) {
      radioService.stopOperator(operator.id);
    }

    if (operator.isInActivePTT) {
      radioService.removeOperatorFromTransmission(operator.id);
    }
  }

  return { operatorsChanged };
};
