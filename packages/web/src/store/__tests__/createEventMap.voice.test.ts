import { describe, expect, it, vi } from 'vitest';
import { createRadioEventMap } from '../radio/createEventMap';
import { initialRadioState } from '../radioStore';
import type { AuthState } from '../authStore';

describe('createRadioEventMap voice frequency sync', () => {
  it('updates both current frequency and voice radio mode from frequencyChanged events', () => {
    const connectionDispatch = vi.fn();
    const radioDispatch = vi.fn();
    const slotPacksDispatch = vi.fn();
    const logbookDispatch = vi.fn();

    const authState: AuthState = {
      initialized: true,
      sessionResolved: true,
      authEnabled: false,
      allowPublicViewing: true,
      jwt: null,
      role: 'admin' as any,
      label: null,
      operatorIds: [],
      isPublicViewer: false,
      loginError: null,
      loginLoading: false,
    };

    const eventMap = createRadioEventMap({
      connectionDispatch,
      radioDispatch,
      slotPacksDispatch,
      logbookDispatch,
      authStateRef: { current: authState },
      radioService: {
        getSystemStatus: vi.fn(),
        subscribeSpectrum: vi.fn(),
        sendHandshake: vi.fn(),
        setClientEnabledOperators: vi.fn(),
        wsClientInstance: {} as any,
      } as any,
      radioServiceRef: { current: null },
      clientInstanceId: 'client-test',
      radioStateRef: { current: initialRadioState },
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

    eventMap.frequencyChanged({
      frequency: 14270000,
      radioMode: 'USB',
    });

    expect(radioDispatch).toHaveBeenNthCalledWith(1, {
      type: 'setCurrentRadioFrequency',
      payload: 14270000,
    });
    expect(radioDispatch).toHaveBeenNthCalledWith(2, {
      type: 'voiceRadioModeChanged',
      payload: 'USB',
    });
    expect(slotPacksDispatch).toHaveBeenCalledWith({ type: 'CLEAR_DATA' });
    expect(connectionDispatch).not.toHaveBeenCalled();
    expect(logbookDispatch).not.toHaveBeenCalled();
  });
});
