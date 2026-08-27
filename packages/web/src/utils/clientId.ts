let fallbackSequence = 0;

function createUuidV4FromRandomValues(cryptoApi: Crypto): string | null {
  if (typeof cryptoApi.getRandomValues !== 'function') return null;

  try {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

function createNonSecureFallbackId(): string {
  fallbackSequence = fallbackSequence >= Number.MAX_SAFE_INTEGER ? 1 : fallbackSequence + 1;
  const bestEffortEntropy = Math.random().toString(36).slice(2, 12) || '0';
  return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}-${bestEffortEntropy}`;
}

/**
 * Creates browser-side correlation and entity IDs. These IDs are not suitable
 * for authentication credentials or other security-sensitive values.
 */
export function createClientId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Some embedded browsers expose the method but reject calls at runtime.
    }
  }

  if (cryptoApi) {
    const uuid = createUuidV4FromRandomValues(cryptoApi);
    if (uuid) return uuid;
  }

  return createNonSecureFallbackId();
}

export function createPrefixedClientId(prefix: string): string {
  return `${prefix}-${createClientId()}`;
}
