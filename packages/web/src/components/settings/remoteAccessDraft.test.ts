import { describe, expect, it } from 'vitest';
import type { RemoteAccessSecurityStatus } from '@tx5dr/contracts';
import { validateRemoteAccessDraft } from './remoteAccessDraft';

function publicSettings(allowedOrigins: string[]): RemoteAccessSecurityStatus {
  return {
    preset: 'public',
    allowedOrigins,
    maxConnections: 128,
    maxConnectionsPerIp: 32,
    maxPendingAuth: 32,
    authTimeoutMs: 10_000,
    handshakeTimeoutMs: 10_000,
    allowPublicViewing: false,
    activeConnections: 0,
    pendingConnections: 0,
  };
}

describe('remote access draft validation', () => {
  it('accepts exact HTTP and HTTPS origins for public access', () => {
    expect(validateRemoteAccessDraft(publicSettings(['http://radio.example.com:8076']))).toBeNull();
    expect(validateRemoteAccessDraft(publicSettings(['https://radio.example.com']))).toBeNull();
  });

  it('still rejects missing origins and addresses with a path', () => {
    expect(validateRemoteAccessDraft(publicSettings([]))).toBe('originRequired');
    expect(validateRemoteAccessDraft(publicSettings(['http://radio.example.com/tx5dr']))).toBe('originInvalid');
  });
});
