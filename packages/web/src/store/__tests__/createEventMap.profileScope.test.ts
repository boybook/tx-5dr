import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '../authStore';
import { createRadioEventMap } from '../radio/createEventMap';
import { initialRadioState, type ProfileRequestScopeRef } from '../radioStore';
import { UserRole, type RadioProfile } from '@tx5dr/contracts';

const PROFILE_A: RadioProfile = {
  id: 'profile-a',
  name: 'A',
  radio: { type: 'none' },
  audio: {},
  audioLockedToRadio: false,
  createdAt: 1,
  updatedAt: 1,
};

const PROFILE_B: RadioProfile = {
  ...PROFILE_A,
  id: 'profile-b',
  name: 'B',
};

function createHarness() {
  const authState: AuthState = {
    initialized: true,
    sessionResolved: true,
    authEnabled: false,
    allowPublicViewing: true,
    jwt: null,
    role: UserRole.ADMIN,
    label: null,
    operatorIds: [],
    isPublicViewer: false,
    loginError: null,
    loginLoading: false,
  };
  const activeProfileIdRef = { current: PROFILE_A.id as string | null };
  const profileRequestScopeRef: ProfileRequestScopeRef = {
    current: { profileId: PROFILE_A.id, generation: 3 },
  };
  const radioDispatch = vi.fn();
  const applyProfileDrivenSpectrumNegotiation = vi.fn();

  const eventMap = createRadioEventMap({
    connectionDispatch: vi.fn(),
    radioDispatch,
    slotPacksDispatch: vi.fn(),
    logbookDispatch: vi.fn(),
    authStateRef: { current: authState },
    radioService: {
      getSystemStatus: vi.fn(),
      subscribeSpectrum: vi.fn(),
      sendHandshake: vi.fn(),
      setClientEnabledOperators: vi.fn(),
      wsClientInstance: {},
    } as never,
    radioServiceRef: { current: null },
    clientInstanceId: 'profile-scope-test',
    radioStateRef: { current: initialRadioState },
    capabilitiesRef: { current: null },
    activeProfileIdRef,
    profileRequestScopeRef,
    spectrumNegotiation: {
      applySpectrumSelection: vi.fn(),
      applyProfileDrivenSpectrumNegotiation,
      applyModeDrivenSpectrumNegotiation: vi.fn(),
      onSpectrumSessionStateChanged: vi.fn(),
      shouldAcceptSpectrumProfile: vi.fn().mockReturnValue(true),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });

  return {
    activeProfileIdRef,
    applyProfileDrivenSpectrumNegotiation,
    eventMap,
    profileRequestScopeRef,
    radioDispatch,
  };
}

describe('createRadioEventMap Profile request scope', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advances the shared scope synchronously before dispatching profileChanged', () => {
    const harness = createHarness();
    harness.radioDispatch.mockImplementationOnce(() => {
      expect(harness.profileRequestScopeRef.current).toEqual({
        profileId: PROFILE_B.id,
        generation: 8,
      });
    });
    harness.eventMap.profileChanged({
      profileId: PROFILE_B.id,
      profile: PROFILE_B,
      previousProfileId: PROFILE_A.id,
      wasRunning: true,
      generation: 8,
      engineMode: 'cw',
      currentMode: {
        name: 'CW',
        slotMs: 0,
        toleranceMs: 0,
        windowTiming: [],
        transmitTiming: 0,
        encodeAdvance: 0,
      },
    });

    expect(harness.profileRequestScopeRef.current).toEqual({
      profileId: PROFILE_B.id,
      generation: 8,
    });
    expect(harness.activeProfileIdRef.current).toBe(PROFILE_B.id);
    expect(harness.radioDispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: 'profileChanged',
    }));
  });

  it('preserves Profile-driven spectrum negotiation when the list changes the active Profile', () => {
    const harness = createHarness();

    harness.eventMap.profileListUpdated({
      profiles: [PROFILE_A, PROFILE_B],
      activeProfileId: PROFILE_B.id,
    });

    expect(harness.applyProfileDrivenSpectrumNegotiation).toHaveBeenCalledWith(PROFILE_B.id, true);
    expect(harness.profileRequestScopeRef.current).toEqual({
      profileId: PROFILE_B.id,
      generation: 4,
    });
  });
});
