import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRadioEventMap } from '../radio/createEventMap';
import { initialRadioState } from '../radioStore';
import type { AuthState } from '../authStore';
import { setSpectrumSubscriptionPaused } from '../../utils/spectrumSubscriptionPause';
import { UserRole } from '@tx5dr/contracts';

function createHarness(paused: boolean) {
  setSpectrumSubscriptionPaused(paused);

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

  const radioService = {
    getSystemStatus: vi.fn(),
    subscribeSpectrum: vi.fn(),
    sendHandshake: vi.fn(),
    setClientEnabledOperators: vi.fn(),
    wsClientInstance: {},
  };

  const eventMap = createRadioEventMap({
    connectionDispatch: vi.fn(),
    radioDispatch: vi.fn(),
    slotPacksDispatch: vi.fn(),
    logbookDispatch: vi.fn(),
    authStateRef: { current: authState },
    radioService: radioService as never,
    radioServiceRef: { current: null },
    clientInstanceId: 'client-test',
    radioStateRef: {
      current: {
        ...initialRadioState,
        subscribedSpectrumKind: 'audio' as const,
      },
    },
    capabilitiesRef: { current: null },
    activeProfileIdRef: { current: null },
    spectrumNegotiation: {
      applySpectrumSelection: vi.fn(),
      applyProfileDrivenSpectrumNegotiation: vi.fn(),
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

  return { eventMap, radioService };
}

describe('createRadioEventMap spectrum refresh', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    setSpectrumSubscriptionPaused(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resubscribes on reconnect when spectrum is expanded', () => {
    const { eventMap, radioService } = createHarness(false);

    eventMap.connected();

    expect(radioService.subscribeSpectrum).toHaveBeenCalledWith('audio');
  });

  it('does not resubscribe on reconnect when spectrum is collapsed', () => {
    const { eventMap, radioService } = createHarness(true);

    eventMap.connected();

    expect(radioService.subscribeSpectrum).not.toHaveBeenCalled();
  });
});
