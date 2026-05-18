import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { createRadioEventMap } from '../radio/createEventMap';
import { initialRadioState } from '../radioStore';
import type { AuthState } from '../authStore';
import type { RadioService } from '../../services/radioService';

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

function createAuthState(overrides: Partial<AuthState> = {}): AuthState {
  return {
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
    ...overrides,
  };
}

function createEventMapForTest(authOverrides: Partial<AuthState> = {}) {
  const connectionDispatch = vi.fn();
  const radioDispatch = vi.fn();
  const slotPacksDispatch = vi.fn();
  const logbookDispatch = vi.fn();
  const radioService = {
    getSystemStatus: vi.fn(),
    subscribeSpectrum: vi.fn(),
    sendHandshake: vi.fn(),
    setClientEnabledOperators: vi.fn(),
    setClientSelectedOperator: vi.fn(),
    wsClientInstance: {},
  } as unknown as RadioService;

  const eventMap = createRadioEventMap({
    connectionDispatch,
    radioDispatch,
    slotPacksDispatch,
    logbookDispatch,
    authStateRef: { current: createAuthState(authOverrides) },
    radioService,
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
    radioService,
  };
}

describe('createRadioEventMap operator selection flow', () => {
  beforeEach(() => {
    installLocalStorageMock();
    localStorage.clear();
  });

  it('buffers and commits replacement slot history when slotPacksReset phases arrive', () => {
    const { eventMap, slotPacksDispatch } = createEventMapForTest();

    eventMap.slotPacksReset({ phase: 'start' });
    eventMap.slotPacksReset({ phase: 'complete' });

    expect(slotPacksDispatch).toHaveBeenNthCalledWith(1, { type: 'beginSync' });
    expect(slotPacksDispatch).toHaveBeenNthCalledWith(2, { type: 'commitSync' });
  });

  it('falls back to clearing history for legacy reset messages without phase', () => {
    const { eventMap, slotPacksDispatch } = createEventMapForTest();

    eventMap.slotPacksReset();

    expect(slotPacksDispatch).toHaveBeenCalledWith({ type: 'CLEAR_DATA' });
  });

  it('persists and dispatches the final selected operator from handshakeComplete', async () => {
    const { eventMap, connectionDispatch, radioDispatch } = createEventMapForTest();

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
    expect(connectionDispatch).toHaveBeenCalledWith({ type: 'handshakeComplete' });
  });

  it('waits for server handshake before requesting status snapshots', async () => {
    const { eventMap, radioService } = createEventMapForTest();

    eventMap.connected();
    eventMap.authResult({ success: true, role: UserRole.ADMIN });

    expect(radioService.getSystemStatus).not.toHaveBeenCalled();

    await eventMap.handshakeComplete({
      finalSelectedOperatorId: null,
    });

    expect(radioService.getSystemStatus).toHaveBeenCalledTimes(1);
  });

  it('does not send no-auth handshake when URL-token login has a JWT', () => {
    const { eventMap, radioService } = createEventMapForTest({
      authEnabled: true,
      jwt: 'jwt-from-url-token',
      role: UserRole.ADMIN,
    });

    eventMap.connected();

    expect(radioService.sendHandshake).not.toHaveBeenCalled();
  });
});
