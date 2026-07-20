import { describe, expect, it } from 'vitest';
import {
  advanceProfileRequestScope,
  awaitProfileScoped,
  synchronizeProfileRequestScopeFromState,
  type ProfileRequestScopeRef,
} from '../radioStore';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Profile request scope', () => {
  it('advances monotonically for Profile changes, forced reactivation, and server generations', () => {
    const initial = { profileId: 'profile-a', generation: 3 };

    expect(advanceProfileRequestScope(initial, 'profile-a')).toEqual(initial);
    expect(advanceProfileRequestScope(initial, 'profile-b')).toEqual({
      profileId: 'profile-b',
      generation: 4,
    });
    expect(advanceProfileRequestScope(initial, 'profile-a', undefined, true)).toEqual({
      profileId: 'profile-a',
      generation: 4,
    });
    expect(advanceProfileRequestScope(initial, 'profile-a', 9, true)).toEqual({
      profileId: 'profile-a',
      generation: 9,
    });
    expect(advanceProfileRequestScope(initial, 'profile-a', 1, true)).toEqual({
      profileId: 'profile-a',
      generation: 4,
    });
  });

  it('drops a successful response after its Profile scope becomes stale', async () => {
    const ref: ProfileRequestScopeRef = {
      current: { profileId: 'profile-a', generation: 1 },
    };
    const requestScope = { ...ref.current };
    const deferred = createDeferred<string>();
    const resultPromise = awaitProfileScoped(deferred.promise, requestScope, ref);

    ref.current = { profileId: 'profile-b', generation: 2 };
    deferred.resolve('old response');

    await expect(resultPromise).resolves.toEqual({ status: 'stale' });
  });

  it('does not let a stale provider render roll back an event-advanced scope', () => {
    const ref: ProfileRequestScopeRef = {
      current: { profileId: 'profile-b', generation: 8 },
    };
    const activeProfileIdRef = { current: 'profile-b' as string | null };

    expect(synchronizeProfileRequestScopeFromState(ref, {
      profileId: 'profile-a',
      generation: 7,
    }, activeProfileIdRef)).toEqual({ profileId: 'profile-b', generation: 8 });
    expect(activeProfileIdRef.current).toBe('profile-b');

    activeProfileIdRef.current = 'profile-a';
    expect(synchronizeProfileRequestScopeFromState(ref, {
      profileId: 'profile-c',
      generation: 8,
    }, activeProfileIdRef)).toEqual({ profileId: 'profile-b', generation: 8 });
    expect(activeProfileIdRef.current).toBe('profile-b');

    expect(synchronizeProfileRequestScopeFromState(ref, {
      profileId: 'profile-c',
      generation: 9,
    }, activeProfileIdRef)).toEqual({ profileId: 'profile-c', generation: 9 });
    expect(activeProfileIdRef.current).toBe('profile-c');
  });

  it('swallows a stale rejection but keeps a current rejection observable', async () => {
    const ref: ProfileRequestScopeRef = {
      current: { profileId: 'profile-a', generation: 1 },
    };
    const staleScope = { ...ref.current };
    const staleDeferred = createDeferred<never>();
    const staleResult = awaitProfileScoped(staleDeferred.promise, staleScope, ref);

    ref.current = { profileId: 'profile-a', generation: 2 };
    staleDeferred.reject(new Error('old Profile failed'));
    await expect(staleResult).resolves.toEqual({ status: 'stale' });

    const currentScope = { ...ref.current };
    await expect(
      awaitProfileScoped(Promise.reject(new Error('current Profile failed')), currentScope, ref),
    ).rejects.toThrow('current Profile failed');
  });
});
