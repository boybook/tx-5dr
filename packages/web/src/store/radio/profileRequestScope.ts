export interface ProfileRequestScope {
  profileId: string | null;
  generation: number;
}

export interface ProfileRequestScopeRef {
  current: ProfileRequestScope;
}

export interface ActiveProfileIdRef {
  current: string | null;
}

export type ProfileScopedResult<T> =
  | { status: 'current'; value: T }
  | { status: 'stale' };

export function advanceProfileRequestScope(
  current: ProfileRequestScope,
  profileId: string | null,
  serverGeneration?: number,
  forceAdvance = false,
): ProfileRequestScope {
  const profileChanged = current.profileId !== profileId;
  const minimumGeneration = current.generation + (forceAdvance || profileChanged ? 1 : 0);
  const normalizedServerGeneration = typeof serverGeneration === 'number'
    && Number.isInteger(serverGeneration)
    && serverGeneration >= 0
    ? serverGeneration
    : 0;

  return {
    profileId,
    generation: Math.max(minimumGeneration, normalizedServerGeneration),
  };
}

export function captureProfileRequestScope(ref: ProfileRequestScopeRef): ProfileRequestScope {
  return { ...ref.current };
}

export function isProfileRequestScopeCurrent(
  requestScope: ProfileRequestScope,
  ref: ProfileRequestScopeRef,
): boolean {
  return requestScope.profileId === ref.current.profileId
    && requestScope.generation === ref.current.generation;
}

export function synchronizeProfileRequestScopeFromState(
  ref: ProfileRequestScopeRef,
  stateScope: ProfileRequestScope,
  activeProfileIdRef: ActiveProfileIdRef,
): ProfileRequestScope {
  const stateIsNewer = stateScope.generation > ref.current.generation;
  const stateMatchesCurrent = stateScope.generation === ref.current.generation
    && stateScope.profileId === ref.current.profileId;

  if (stateIsNewer || stateMatchesCurrent) {
    ref.current = { ...stateScope };
  }
  activeProfileIdRef.current = ref.current.profileId;
  return ref.current;
}

export async function awaitProfileScoped<T>(
  promise: Promise<T>,
  requestScope: ProfileRequestScope,
  ref: ProfileRequestScopeRef,
): Promise<ProfileScopedResult<T>> {
  try {
    const value = await promise;
    return isProfileRequestScopeCurrent(requestScope, ref)
      ? { status: 'current', value }
      : { status: 'stale' };
  } catch (error) {
    if (!isProfileRequestScopeCurrent(requestScope, ref)) {
      return { status: 'stale' };
    }
    throw error;
  }
}
