import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRadioEventMap } from '../radio/createEventMap';
import { initialRadioState } from '../radioStore';
import type { AuthState } from '../authStore';

const STORAGE_KEY = 'tx5dr_operator_preferences';

vi.mock('@tx5dr/core', () => ({
  api: {
    getProfiles: vi.fn().mockResolvedValue({ profiles: [], activeProfileId: null }),
    getStationInfo: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

function installLocalStorageMock() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
}

function createAuthState(): AuthState {
  return {
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
}

function createEventMapForTest() {
  const connectionDispatch = vi.fn();
  const radioDispatch = vi.fn();
  const slotPacksDispatch = vi.fn();
  const logbookDispatch = vi.fn();

  const eventMap = createRadioEventMap({
    connectionDispatch,
    radioDispatch,
    slotPacksDispatch,
    logbookDispatch,
    authStateRef: { current: createAuthState() },
    radioService: {
      getSystemStatus: vi.fn(),
      subscribeSpectrum: vi.fn(),
      sendHandshake: vi.fn(),
      setClientEnabledOperators: vi.fn(),
      setClientSelectedOperator: vi.fn(),
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

  return {
    connectionDispatch,
    radioDispatch,
    slotPacksDispatch,
    logbookDispatch,
    eventMap,
  };
}

describe('createRadioEventMap operator selection flow', () => {
  beforeEach(() => {
    installLocalStorageMock();
    localStorage.clear();
  });

  it('clears local slot history when slotPacksReset arrives', () => {
    const { eventMap, slotPacksDispatch } = createEventMapForTest();

    eventMap.slotPacksReset();

    expect(slotPacksDispatch).toHaveBeenCalledWith({ type: 'CLEAR_DATA' });
  });

  it('persists and dispatches the final selected operator from handshakeComplete', async () => {
    const { eventMap, radioDispatch } = createEventMapForTest();

    await eventMap.handshakeComplete({
      finalSelectedOperatorId: 'op-b',
    });

    expect(radioDispatch).toHaveBeenCalledWith({
      type: 'setCurrentOperator',
      payload: 'op-b',
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      selectedOperatorId: 'op-b',
    });
  });
});
