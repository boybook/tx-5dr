import { describe, expect, it, vi } from 'vitest';
import { BrowserLoginAuthService, type BrowserLoginAuthDependencies } from '../browserLoginAuth.js';

type BackendResponse = Awaited<ReturnType<BrowserLoginAuthDependencies['requestJson']>>;

describe('BrowserLoginAuthService', () => {
  it('opens a clean URL without reading .admin-token when authentication is disabled', async () => {
    const requestJson = vi.fn(async (): Promise<BackendResponse> => ({
      statusCode: 200,
      body: { enabled: false },
    }));
    const readAdminToken = vi.fn(() => 'txdr_permanent_secret');
    const service = new BrowserLoginAuthService({ requestJson, readAdminToken });

    await expect(service.buildAuthenticatedUrl('http://127.0.0.1:8076')).resolves.toBe('http://127.0.0.1:8076');
    expect(readAdminToken).not.toHaveBeenCalled();
  });

  it('puts only the one-time code in the fragment and preserves page parameters', async () => {
    const permanentToken = 'txdr_permanent_admin_secret';
    const requestJson = vi.fn(async (path: string): Promise<BackendResponse> => {
      if (path === '/api/auth/status') return { statusCode: 200, body: { enabled: true } };
      if (path === '/api/auth/login') return { statusCode: 200, body: { jwt: 'signed-jwt-secret' } };
      return { statusCode: 200, body: { code: 'txdr_blc_one_time_secret', expiresAt: Date.now() + 120_000 } };
    });
    const service = new BrowserLoginAuthService({ requestJson, readAdminToken: () => permanentToken });

    const result = await service.buildAuthenticatedUrl('http://127.0.0.1:8076/logbook.html?operatorId=op-1');
    const url = new URL(result);
    expect(url.searchParams.get('operatorId')).toBe('op-1');
    expect(url.searchParams.has('auth_token')).toBe(false);
    expect(url.hash).toBe('#browser_login_code=txdr_blc_one_time_secret');
    expect(result).not.toContain(permanentToken);
  });

  it('uses a distinct code per window while caching only the JWT', async () => {
    let codeIndex = 0;
    const readAdminToken = vi.fn(() => 'txdr_permanent_admin_secret');
    const requestJson = vi.fn(async (path: string): Promise<BackendResponse> => {
      if (path === '/api/auth/status') return { statusCode: 200, body: { enabled: true } };
      if (path === '/api/auth/login') return { statusCode: 200, body: { jwt: 'signed-jwt-secret' } };
      codeIndex += 1;
      return { statusCode: 200, body: { code: `txdr_blc_code_${codeIndex}`, expiresAt: Date.now() + 120_000 } };
    });
    const service = new BrowserLoginAuthService({ requestJson, readAdminToken });

    const first = await service.buildAuthenticatedUrl('http://127.0.0.1:8076');
    const second = await service.buildAuthenticatedUrl('http://127.0.0.1:8076/spectrum.html');

    expect(new URL(first).hash).toBe('#browser_login_code=txdr_blc_code_1');
    expect(new URL(second).hash).toBe('#browser_login_code=txdr_blc_code_2');
    expect(readAdminToken).toHaveBeenCalledTimes(1);
  });

  it('rereads .admin-token and retries minting once after a cached JWT is rejected', async () => {
    const tokens = ['txdr_old_admin_secret', 'txdr_new_admin_secret'];
    const readAdminToken = vi.fn(() => tokens.shift() ?? null);
    let loginIndex = 0;
    let mintIndex = 0;
    const requestJson = vi.fn(async (path: string): Promise<BackendResponse> => {
      if (path === '/api/auth/status') return { statusCode: 200, body: { enabled: true } };
      if (path === '/api/auth/login') {
        loginIndex += 1;
        return { statusCode: 200, body: { jwt: `jwt-${loginIndex}-secret` } };
      }
      mintIndex += 1;
      return mintIndex === 1
        ? { statusCode: 401, body: {} }
        : { statusCode: 200, body: { code: 'txdr_blc_retried_code', expiresAt: Date.now() + 120_000 } };
    });
    const service = new BrowserLoginAuthService({ requestJson, readAdminToken });

    const result = await service.buildAuthenticatedUrl('http://127.0.0.1:8076');

    expect(new URL(result).hash).toBe('#browser_login_code=txdr_blc_retried_code');
    expect(readAdminToken).toHaveBeenCalledTimes(2);
    expect(mintIndex).toBe(2);
  });

  it('rereads .admin-token when the token file is replaced by regeneration', async () => {
    let tokenVersion = 'version-1';
    let token = 'txdr_old_admin_secret';
    const readAdminToken = vi.fn(() => token);
    let loginCount = 0;
    const requestJson = vi.fn(async (path: string): Promise<BackendResponse> => {
      if (path === '/api/auth/status') return { statusCode: 200, body: { enabled: true } };
      if (path === '/api/auth/login') {
        loginCount += 1;
        return { statusCode: 200, body: { jwt: `jwt-${loginCount}-secret` } };
      }
      return { statusCode: 200, body: { code: `txdr_blc_code_${loginCount}`, expiresAt: Date.now() + 120_000 } };
    });
    const service = new BrowserLoginAuthService({
      requestJson,
      readAdminToken,
      getAdminTokenVersion: () => tokenVersion,
    });

    await service.buildAuthenticatedUrl('http://127.0.0.1:8076');
    token = 'txdr_new_admin_secret';
    tokenVersion = 'version-2';
    await service.buildAuthenticatedUrl('http://127.0.0.1:8076');

    expect(readAdminToken).toHaveBeenCalledTimes(2);
    expect(loginCount).toBe(2);
  });

  it('throws instead of falling back to a permanent-token URL', async () => {
    const requestJson = vi.fn(async (path: string): Promise<BackendResponse> => {
      if (path === '/api/auth/status') return { statusCode: 200, body: { enabled: true } };
      if (path === '/api/auth/login') return { statusCode: 200, body: { jwt: 'signed-jwt-secret' } };
      return { statusCode: 500, body: {} };
    });
    const service = new BrowserLoginAuthService({
      requestJson,
      readAdminToken: () => 'txdr_permanent_admin_secret',
    });

    await expect(service.buildAuthenticatedUrl('http://127.0.0.1:8076')).rejects.toThrow(
      'Unable to create browser login code',
    );
  });
});
