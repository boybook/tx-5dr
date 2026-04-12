const JWT_STORAGE_KEY = 'tx5dr_jwt';

export function getStoredJwt(): string | null {
  try {
    return localStorage.getItem(JWT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getAuthHeaders(extraHeaders?: HeadersInit): HeadersInit {
  const jwt = getStoredJwt();
  const normalized = new Headers(extraHeaders);
  if (jwt) {
    normalized.set('Authorization', `Bearer ${jwt}`);
  }
  return {
    ...Object.fromEntries(normalized.entries()),
  };
}
