import type { OperatorStatus } from '@tx5dr/contracts';
import { describe, expect, it } from 'vitest';
import {
  deriveSameCallsignStandardFrequencyWarning,
  deriveMultiStreamStandardFrequencyRestriction,
  getStandardDigitalFrequencyMatch,
} from '../standardDigitalFrequencyWarning';

function createOperator(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return {
    id: overrides.id ?? 'operator-1',
    isActive: overrides.isActive ?? true,
    isTransmitting: overrides.isTransmitting ?? true,
    currentSlot: overrides.currentSlot,
    context: {
      myCall: 'BI7ALG',
      myGrid: 'OL63',
      targetCall: '',
      ...overrides.context,
    },
    strategy: overrides.strategy ?? {
      name: 'standard-qso',
      state: 'idle',
      availableSlots: [],
    },
    runtime: overrides.runtime,
    slots: overrides.slots,
    transmitCycles: overrides.transmitCycles ?? [0],
  };
}

describe('standardDigitalFrequencyWarning utils', () => {
  it('warns for same callsign transmitting on the same FT8 standard cycle', () => {
    const warning = deriveSameCallsignStandardFrequencyWarning([
      createOperator({ id: 'operator-a', transmitCycles: [0] }),
      createOperator({ id: 'operator-b', transmitCycles: [0] }),
    ], 'FT8', 14074000);

    expect(warning).toMatchObject({
      modeName: 'FT8',
      standardFrequency: 14074000,
      groups: [{ callsign: 'BI7ALG', cycles: [0], operatorIds: ['operator-a', 'operator-b'] }],
    });
  });

  it('does not warn for same callsign transmitting on different cycles', () => {
    const warning = deriveSameCallsignStandardFrequencyWarning([
      createOperator({ id: 'operator-a', transmitCycles: [0] }),
      createOperator({ id: 'operator-b', transmitCycles: [1] }),
    ], 'FT8', 14074000);

    expect(warning).toBeNull();
  });

  it('matches an FT4 standard frequency only when the active mode is FT4', () => {
    expect(getStandardDigitalFrequencyMatch('FT4', 7047500)).toEqual({
      modeName: 'FT4',
      standardFrequency: 7047500,
    });
    expect(getStandardDigitalFrequencyMatch('FT8', 7047500)).toBeNull();
  });

  it('does not warn for non-standard frequency or non-digital mode', () => {
    const operators = [
      createOperator({ id: 'operator-a' }),
      createOperator({ id: 'operator-b' }),
    ];

    expect(deriveSameCallsignStandardFrequencyWarning(operators, 'FT8', 14000000)).toBeNull();
    expect(deriveSameCallsignStandardFrequencyWarning(operators, 'VOICE', 14074000)).toBeNull();
    expect(deriveSameCallsignStandardFrequencyWarning(operators, undefined, 14074000)).toBeNull();
  });

  it('ignores empty callsigns and non-transmitting operators', () => {
    expect(deriveSameCallsignStandardFrequencyWarning([
      createOperator({ id: 'operator-a', context: { myCall: '', myGrid: 'OL63', targetCall: '' } }),
      createOperator({ id: 'operator-b', context: { myCall: '  ', myGrid: 'OL63', targetCall: '' } }),
    ], 'FT8', 14074000)).toBeNull();

    expect(deriveSameCallsignStandardFrequencyWarning([
      createOperator({ id: 'operator-a', isTransmitting: true }),
      createOperator({ id: 'operator-b', isTransmitting: false }),
    ], 'FT8', 14074000)).toBeNull();
  });

  it('warns on odd cycle overlap between all-cycle and odd-cycle operators', () => {
    const warning = deriveSameCallsignStandardFrequencyWarning([
      createOperator({ id: 'operator-a', transmitCycles: [0, 1] }),
      createOperator({ id: 'operator-b', transmitCycles: [1] }),
    ], 'FT8', 14074000);

    expect(warning?.groups).toEqual([
      { callsign: 'BI7ALG', cycles: [1], operatorIds: ['operator-a', 'operator-b'] },
    ]);
  });

  it('warns when any queue strategy requests multiple streams on a standard frequency', () => {
    expect(deriveMultiStreamStandardFrequencyRestriction([
      createOperator({
        id: 'ww-digi-operator',
        isTransmitting: false,
        strategy: { name: 'ww-digi', state: 'TX6', availableSlots: ['TX6'] },
        runtime: {
          currentState: 'TX6',
          queue: { version: 1, rows: [], maxActiveStreams: 1, requestedMaxActiveStreams: 3 },
        },
      }),
      createOperator({
        id: 'assisted-operator',
        strategy: { name: 'assisted-qso-queue', state: 'TX6', availableSlots: ['TX6'] },
        runtime: {
          currentState: 'TX6',
          queue: { version: 1, rows: [], maxActiveStreams: 1, requestedMaxActiveStreams: 2 },
        },
      }),
    ], 'FT8', 14_074_000)).toEqual({
      modeName: 'FT8',
      standardFrequency: 14_074_000,
      operatorIds: ['ww-digi-operator', 'assisted-operator'],
    });
  });

  it('does not warn for single-stream strategies or away from standard frequencies', () => {
    const operator = createOperator({
      strategy: { name: 'ww-digi', state: 'TX6', availableSlots: ['TX6'] },
      runtime: {
        currentState: 'TX6',
        queue: { version: 1, rows: [], maxActiveStreams: 1, requestedMaxActiveStreams: 3 },
      },
    });

    expect(deriveMultiStreamStandardFrequencyRestriction([operator], 'FT8', 14_090_000)).toBeNull();
    expect(deriveMultiStreamStandardFrequencyRestriction([
      createOperator({
        runtime: {
          currentState: 'TX6',
          queue: { version: 1, rows: [], maxActiveStreams: 1, requestedMaxActiveStreams: 1 },
        },
      }),
    ], 'FT8', 14_074_000)).toBeNull();
  });
});
