import { describe, expect, it } from 'vitest';
import { RadioConnectionStatus, type CapabilityDescriptor, type CapabilityState } from '@tx5dr/contracts';
import { initialRadioState, radioReducer, type RadioState } from '../radioStore';

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
    ];
    const capabilities: CapabilityState[] = [
      { id: 'tuning_step', supported: true, value: 50, updatedAt: 1 },
      { id: 'lock_mode', supported: true, value: true, updatedAt: 2 },
    ];

    const nextState = radioReducer(initialRadioState, {
      type: 'setCapabilityList',
      payload: { descriptors, capabilities },
    });

    expect(nextState.capabilityDescriptors.get('tuning_step')).toEqual(descriptors[0]);
    expect(nextState.capabilityDescriptors.get('lock_mode')).toEqual(descriptors[1]);
    expect(nextState.capabilityStates.get('tuning_step')).toEqual(capabilities[0]);
    expect(nextState.capabilityStates.get('lock_mode')).toEqual(capabilities[1]);
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


  it('stores squelch status and resets it on disconnect', () => {
    const withSquelch = radioReducer(initialRadioState, {
      type: 'squelchStatusChanged',
      payload: {
        supported: true,
        open: false,
        muted: true,
        source: 'hamlib-dcd',
        updatedAt: 123,
      },
    });

    expect(withSquelch.squelchStatus).toMatchObject({
      supported: true,
      open: false,
      muted: true,
    });

    const disconnectedState = radioReducer(withSquelch, {
      type: 'radioStatusUpdate',
      payload: {
        radioConnected: false,
        status: RadioConnectionStatus.DISCONNECTED,
        radioInfo: null,
      },
    });

    expect(disconnectedState.squelchStatus).toEqual(initialRadioState.squelchStatus);
  });

  it('marks meter visibility only after a real reading arrives and resets it on disconnect', () => {
    const withEmptyMeterPayload = radioReducer(initialRadioState, {
      type: 'meterData',
      payload: {
        swr: null,
        alc: null,
        level: null,
        power: null,
      },
    });

    expect(withEmptyMeterPayload.hasReceivedMeterData).toBe(false);

    const withRealMeterPayload = radioReducer(withEmptyMeterPayload, {
      type: 'meterData',
      payload: {
        swr: null,
        alc: {
          raw: 12,
          percent: 35,
          alert: false,
        },
        level: null,
        power: null,
      },
    });

    expect(withRealMeterPayload.hasReceivedMeterData).toBe(true);

    const disconnectedState = radioReducer(withRealMeterPayload, {
      type: 'radioStatusUpdate',
      payload: {
        radioConnected: false,
        status: RadioConnectionStatus.DISCONNECTED,
        radioInfo: null,
      },
    });

    expect(disconnectedState.hasReceivedMeterData).toBe(false);
    expect(disconnectedState.meterData).toBeNull();
  });

  it('resets meter visibility when the active profile changes', () => {
    const stateWithMeterData: RadioState = {
      ...initialRadioState,
      hasReceivedMeterData: true,
      meterData: {
        swr: null,
        alc: {
          raw: 10,
          percent: 25,
          alert: false,
        },
        level: null,
        power: null,
      },
      profiles: [
        {
          id: 'profile-a',
          name: 'A',
          radio: { type: 'serial' as const },
          audio: {},
          audioLockedToRadio: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const nextState = radioReducer(stateWithMeterData, {
      type: 'profileChanged',
      payload: {
        profileId: 'profile-a',
        profile: {
          id: 'profile-a',
          name: 'A',
          radio: { type: 'network' as const, network: { host: '127.0.0.1', port: 4532 } },
          audio: {},
          audioLockedToRadio: false,
          createdAt: 1,
          updatedAt: 2,
        },
        previousProfileId: 'profile-a',
        wasRunning: false,
      },
    });

    expect(nextState.hasReceivedMeterData).toBe(false);
    expect(nextState.meterData).toBeNull();
  });
});
