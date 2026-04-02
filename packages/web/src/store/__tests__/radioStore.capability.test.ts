import { describe, expect, it } from 'vitest';
import { RadioConnectionStatus, type CapabilityDescriptor, type CapabilityState } from '@tx5dr/contracts';
import { initialRadioState, radioReducer } from '../radioStore';

describe('radioStore capability reducer', () => {
  it('hydrates runtime descriptors and states from capability list snapshots', () => {
    const descriptors: CapabilityDescriptor[] = [
      {
        id: 'tuning_step',
        category: 'operation',
        valueType: 'enum',
        options: [{ value: 10 }, { value: 50 }],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.tuning_step.label',
        descriptionI18nKey: 'radio:capability.tuning_step.description',
        hasSurfaceControl: false,
      },
      {
        id: 'power_state',
        category: 'system',
        valueType: 'enum',
        options: [{ value: 'off' }, { value: 'operate' }],
        readable: true,
        writable: true,
        updateMode: 'polling',
        pollIntervalMs: 10000,
        labelI18nKey: 'radio:capability.power_state.label',
        descriptionI18nKey: 'radio:capability.power_state.description',
        hasSurfaceControl: false,
      },
    ];
    const capabilities: CapabilityState[] = [
      { id: 'tuning_step', supported: true, value: 50, updatedAt: 1 },
      { id: 'power_state', supported: true, value: 'operate', updatedAt: 2 },
    ];

    const nextState = radioReducer(initialRadioState, {
      type: 'setCapabilityList',
      payload: { descriptors, capabilities },
    });

    expect(nextState.capabilityDescriptors.get('tuning_step')).toEqual(descriptors[0]);
    expect(nextState.capabilityDescriptors.get('power_state')).toEqual(descriptors[1]);
    expect(nextState.capabilityStates.get('tuning_step')).toEqual(capabilities[0]);
    expect(nextState.capabilityStates.get('power_state')).toEqual(capabilities[1]);
  });

  it('clears runtime capability metadata when radio disconnects', () => {
    const connectedState = radioReducer(initialRadioState, {
      type: 'setCapabilityList',
      payload: {
        descriptors: [
          {
            id: 'lock_mode',
            category: 'system',
            valueType: 'boolean',
            readable: true,
            writable: true,
            updateMode: 'polling',
            pollIntervalMs: 10000,
            labelI18nKey: 'radio:capability.lock_mode.label',
            descriptionI18nKey: 'radio:capability.lock_mode.description',
            hasSurfaceControl: false,
          },
        ],
        capabilities: [
          { id: 'lock_mode', supported: true, value: true, updatedAt: 3 },
        ],
      },
    });

    const disconnectedState = radioReducer(connectedState, {
      type: 'radioStatusUpdate',
      payload: {
        radioConnected: false,
        status: RadioConnectionStatus.DISCONNECTED,
        radioInfo: null,
      },
    });

    expect(disconnectedState.capabilityDescriptors.size).toBe(0);
    expect(disconnectedState.capabilityStates.size).toBe(0);
  });
});
