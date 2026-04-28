import { describe, expect, it, vi } from 'vitest';
import type { OperatorStatus } from '@tx5dr/contracts';

import { resetOperatorsForOperatingStateChange } from '../operatorReset';

function createOperator(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    id: 'op-1',
    isActive: true,
    isTransmitting: false,
    isInActivePTT: false,
    currentSlot: 'TX6',
    context: {
      myCall: 'BG5DRB',
      myGrid: 'PM01',
      targetCall: '',
      targetGrid: '',
      frequency: 1500,
      reportSent: 0,
      reportReceived: 0,
    },
    strategy: {
      name: 'standard-qso',
      state: 'TX6',
      availableSlots: ['TX1', 'TX2', 'TX3', 'TX4', 'TX5', 'TX6'],
    },
    transmitCycles: [0],
    ...overrides,
  };
}

function createRadioService() {
  return {
    setOperatorContext: vi.fn(),
    setOperatorRuntimeState: vi.fn(),
    stopOperator: vi.fn(),
    removeOperatorFromTransmission: vi.fn(),
  };
}

describe('resetOperatorsForOperatingStateChange', () => {
  it('clears QSO context, returns to CQ, stops TX, and removes active PTT audio', () => {
    const radioService = createRadioService();
    const operator = createOperator({
      isTransmitting: true,
      isInActivePTT: true,
      currentSlot: 'TX3',
      context: {
        myCall: 'BG5DRB',
        myGrid: 'PM01',
        targetCall: 'JA1AAA',
        targetGrid: 'PM95',
        frequency: 1500,
        reportSent: -12,
        reportReceived: -8,
      },
    });

    const result = resetOperatorsForOperatingStateChange({
      operators: [operator],
      radioService,
    });

    expect(result.operatorsChanged).toBe(1);
    expect(radioService.setOperatorContext).toHaveBeenCalledWith('op-1', {
      targetCallsign: '',
      targetGrid: '',
      reportSent: 0,
      reportReceived: 0,
    });
    expect(radioService.setOperatorRuntimeState).toHaveBeenCalledWith('op-1', 'TX6');
    expect(radioService.stopOperator).toHaveBeenCalledWith('op-1');
    expect(radioService.removeOperatorFromTransmission).toHaveBeenCalledWith('op-1');
  });

  it('does nothing for an already idle CQ operator', () => {
    const radioService = createRadioService();

    const result = resetOperatorsForOperatingStateChange({
      operators: [createOperator()],
      radioService,
    });

    expect(result.operatorsChanged).toBe(0);
    expect(radioService.setOperatorContext).not.toHaveBeenCalled();
    expect(radioService.setOperatorRuntimeState).not.toHaveBeenCalled();
    expect(radioService.stopOperator).not.toHaveBeenCalled();
    expect(radioService.removeOperatorFromTransmission).not.toHaveBeenCalled();
  });

  it('stops an armed operator without removing audio when PTT is not active', () => {
    const radioService = createRadioService();

    const result = resetOperatorsForOperatingStateChange({
      operators: [createOperator({ isTransmitting: true })],
      radioService,
    });

    expect(result.operatorsChanged).toBe(1);
    expect(radioService.stopOperator).toHaveBeenCalledWith('op-1');
    expect(radioService.removeOperatorFromTransmission).not.toHaveBeenCalled();
    expect(radioService.setOperatorContext).not.toHaveBeenCalled();
    expect(radioService.setOperatorRuntimeState).not.toHaveBeenCalled();
  });
});
