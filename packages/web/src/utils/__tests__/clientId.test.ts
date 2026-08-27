import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClientId, createPrefixedClientId } from '../clientId';

describe('clientId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses crypto.randomUUID when it is available', () => {
    const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000001');
    vi.stubGlobal('crypto', { randomUUID });

    expect(createClientId()).toBe('00000000-0000-4000-8000-000000000001');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('creates an RFC 4122 version 4 UUID from getRandomValues', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => {
        target.set(Array.from({ length: 16 }, (_, index) => index));
        return target;
      },
    });

    expect(createClientId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('falls through when randomUUID is exposed but throws', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => { throw new Error('not available in this context'); },
      getRandomValues: (target: Uint8Array) => {
        target.fill(255);
        return target;
      },
    });

    expect(createClientId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('keeps IDs unique without Web Crypto, even within the same millisecond', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const first = createClientId();
    const second = createClientId();

    expect(first).not.toBe(second);
    expect(createPrefixedClientId('sstv')).toMatch(/^sstv-[a-z0-9-]+$/);
  });
});
