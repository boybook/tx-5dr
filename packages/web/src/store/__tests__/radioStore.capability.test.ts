import { describe, expect, it } from 'vitest';
import {
  RadioConnectionStatus,
  type CapabilityDescriptor,
  type CapabilityState,
  type MeterCapabilities,
  type RadioProfile,
} from '@tx5dr/contracts';
import { initialRadioState, radioReducer, type RadioState } from '../radioStore';

const SUPPORTED_METER_CAPABILITIES: MeterCapabilities = {
  strength: true,
  swr: true,
  alc: true,
  power: true,
  powerWatts: true,
};

function createProfile(
  id: string,
  radio: RadioProfile['radio'],
  updatedAt = 1,
): RadioProfile {
  return {
    id,
    name: id,
    radio,
    audio: {},
    audioLockedToRadio: false,
    createdAt: 1,
    updatedAt,
  };
}

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

  it('keeps meter capabilities during initial profile hydration after radio status sync', () => {
    const meterData: NonNullable<RadioState['meterData']> = {
      swr: null,
      alc: null,
      level: {
        raw: 120,
        percent: 50,
        sUnits: 9,
        dBm: -73,
        formatted: 'S9',
        displayStyle: 's-meter-dbm',
      },
      power: null,
    };
    const stateAfterRadioStatus: RadioState = {
      ...initialRadioState,
      radioConnected: true,
      radioConnectionStatus: RadioConnectionStatus.CONNECTED,
      radioConfig: { type: 'icom-wlan' },
      activeProfileId: null,
      meterCapabilities: SUPPORTED_METER_CAPABILITIES,
      meterData,
      hasReceivedMeterData: true,
    };
    const activeProfile = createProfile('icom-wlan-profile', { type: 'icom-wlan' });

    const nextState = radioReducer(stateAfterRadioStatus, {
      type: 'setProfiles',
      payload: {
        profiles: [activeProfile],
        activeProfileId: activeProfile.id,
      },
    });

    expect(nextState.meterCapabilities).toEqual(SUPPORTED_METER_CAPABILITIES);
    expect(nextState.meterData).toBe(meterData);
    expect(nextState.hasReceivedMeterData).toBe(true);
  });

  it('resets meter tracking when profile sync changes the active profile id after hydration', () => {
    const stateWithActiveProfile: RadioState = {
      ...initialRadioState,
      radioConnected: true,
      radioConnectionStatus: RadioConnectionStatus.CONNECTED,
      activeProfileId: 'profile-a',
      profiles: [
        createProfile('profile-a', { type: 'serial', serial: { path: '/dev/tty.usbserial-a', rigModel: 3073 } }),
        createProfile('profile-b', { type: 'icom-wlan' }),
      ],
      meterCapabilities: SUPPORTED_METER_CAPABILITIES,
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
      hasReceivedMeterData: true,
    };

    const nextState = radioReducer(stateWithActiveProfile, {
      type: 'setProfiles',
      payload: {
        profiles: stateWithActiveProfile.profiles,
        activeProfileId: 'profile-b',
      },
    });

    expect(nextState.meterCapabilities).toBeNull();
    expect(nextState.meterData).toBeNull();
    expect(nextState.hasReceivedMeterData).toBe(false);
  });

  it('resets meter tracking when a profile list update changes the active radio config', () => {
    const stateWithActiveProfile: RadioState = {
      ...initialRadioState,
      radioConnected: true,
      radioConnectionStatus: RadioConnectionStatus.CONNECTED,
      activeProfileId: 'profile-a',
      profiles: [createProfile('profile-a', { type: 'serial', serial: { path: '/dev/tty.usbserial-a', rigModel: 3073 } })],
      meterCapabilities: SUPPORTED_METER_CAPABILITIES,
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
      hasReceivedMeterData: true,
    };

    const nextState = radioReducer(stateWithActiveProfile, {
      type: 'profileListUpdated',
      payload: {
        profiles: [createProfile('profile-a', { type: 'network', network: { host: '127.0.0.1', port: 4532 } }, 2)],
        activeProfileId: 'profile-a',
      },
    });

    expect(nextState.meterCapabilities).toBeNull();
    expect(nextState.meterData).toBeNull();
    expect(nextState.hasReceivedMeterData).toBe(false);
  });
});
