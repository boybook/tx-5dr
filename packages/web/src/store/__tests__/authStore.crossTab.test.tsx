// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@tx5dr/contracts';

const coreMocks = vi.hoisted(() => {
  let configuredJwt: string | null = null;
  const identities = new Map<string, { role: string; label: string; operatorIds: string[]; tokenId: string }>();
  return {
    identities,
    getConfiguredJwt: () => configuredJwt,
    configureAuthToken: vi.fn((jwt: string | null) => { configuredJwt = jwt; }),
    getAuthStatus: vi.fn(),
    getAuthMe: vi.fn(async () => {
      const identity = configuredJwt ? identities.get(configuredJwt) : undefined;
      if (!identity) throw new Error('unauthorized');
      return { ...identity, loginCredential: { configured: false } };
    }),
  };
});

vi.mock('@tx5dr/core', () => ({
  configureAuthToken: coreMocks.configureAuthToken,
  api: {
    getAuthStatus: coreMocks.getAuthStatus,
    getAuthMe: coreMocks.getAuthMe,
  },
}));

vi.mock('../../i18n/index', () => ({ default: { t: (key: string) => key } }));

import { AuthProvider, hasSameAuthIdentity, useAuth } from '../authStore';

const JWT_STORAGE_KEY = 'tx5dr_jwt';

let latest: ReturnType<typeof useAuth> | null = null;
function Probe() {
  latest = useAuth();
  return null;
}

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

function changeStoredJwt(jwt: string | null) {
  if (jwt) localStorage.setItem(JWT_STORAGE_KEY, jwt);
  else localStorage.removeItem(JWT_STORAGE_KEY);
  window.dispatchEvent(new StorageEvent('storage', { key: JWT_STORAGE_KEY, newValue: jwt }));
}

async function renderRestoredSession(allowPublicViewing: boolean) {
  coreMocks.getAuthStatus.mockResolvedValue({ enabled: true, allowPublicViewing });
  localStorage.setItem(JWT_STORAGE_KEY, 'jwt-a');
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(latest?.state.jwt).toBe('jwt-a'));
}

describe('cross-tab session sync', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageStub());
    coreMocks.identities.clear();
    coreMocks.identities.set('jwt-a', { role: UserRole.OPERATOR, label: 'Alice', operatorIds: ['op-1'], tokenId: 't-a' });
    coreMocks.identities.set('jwt-a2', { role: UserRole.OPERATOR, label: 'Alice', operatorIds: ['op-1'], tokenId: 't-a' });
    coreMocks.identities.set('jwt-b', { role: UserRole.ADMIN, label: 'Bob', operatorIds: [], tokenId: 't-b' });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    latest = null;
    vi.clearAllMocks();
  });

  it('ends this page session when another tab logs out', async () => {
    await renderRestoredSession(false);

    act(() => changeStoredJwt(null));

    expect(latest?.state.jwt).toBeNull();
    expect(latest?.state.role).toBeNull();
    expect(latest?.requiresLogin).toBe(true);
    expect(coreMocks.getConfiguredJwt()).toBeNull();
  });

  it('falls back to public viewing when another tab logs out and public viewing is allowed', async () => {
    await renderRestoredSession(true);

    act(() => changeStoredJwt(null));

    expect(latest?.state.isPublicViewer).toBe(true);
    expect(latest?.state.role).toBe(UserRole.VIEWER);
    expect(latest?.state.jwt).toBeNull();
  });

  it('adopts a different identity logged in from another tab', async () => {
    await renderRestoredSession(false);

    act(() => changeStoredJwt('jwt-b'));

    await waitFor(() => expect(latest?.state.jwt).toBe('jwt-b'));
    expect(latest?.state.role).toBe(UserRole.ADMIN);
    expect(latest?.state.label).toBe('Bob');
    expect(coreMocks.getConfiguredJwt()).toBe('jwt-b');
  });

  it('keeps the current session when another page re-authenticates as the same identity', async () => {
    await renderRestoredSession(false);

    act(() => changeStoredJwt('jwt-a2'));

    await waitFor(() => expect(coreMocks.getAuthMe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(coreMocks.getConfiguredJwt()).toBe('jwt-a'));
    expect(latest?.state.jwt).toBe('jwt-a');
  });

  it('ends the session when the replacement stored session is invalid', async () => {
    await renderRestoredSession(false);

    act(() => changeStoredJwt('jwt-unknown'));

    await waitFor(() => expect(latest?.state.jwt).toBeNull());
    expect(latest?.requiresLogin).toBe(true);
    expect(coreMocks.getConfiguredJwt()).toBeNull();
  });

  it('ignores unrelated storage keys', async () => {
    await renderRestoredSession(false);

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
    });

    expect(latest?.state.jwt).toBe('jwt-a');
    expect(coreMocks.getAuthMe).toHaveBeenCalledTimes(1);
  });
});

describe('hasSameAuthIdentity', () => {
  const base = { role: UserRole.OPERATOR, label: 'Alice', operatorIds: ['op-1'], maxOperators: 2, permissionGrants: undefined };

  it('matches identical resolved identities', () => {
    expect(hasSameAuthIdentity(base, { ...base })).toBe(true);
  });

  it('detects role, operator and permission differences', () => {
    expect(hasSameAuthIdentity(base, { ...base, role: UserRole.ADMIN })).toBe(false);
    expect(hasSameAuthIdentity(base, { ...base, operatorIds: ['op-2'] })).toBe(false);
    expect(hasSameAuthIdentity(base, { ...base, permissionGrants: [{ action: 'execute', subject: 'RadioControl' }] as never })).toBe(false);
  });
});
