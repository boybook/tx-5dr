import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { RuntimeStateManager } from '../../config/RuntimeStateManager.js';
import { AuthManager } from '../../auth/AuthManager.js';
import { authPlugin } from '../../auth/authPlugin.js';
import { authRoutes } from '../auth.js';
import { tx5drPaths } from '../../utils/app-paths.js';

function resetAuthSingletons(): void {
  (AuthManager as unknown as { instance?: AuthManager }).instance = undefined;
  (RuntimeStateManager as unknown as { instance?: RuntimeStateManager | null }).instance = null;
  (tx5drPaths as unknown as { _configDir: string | null })._configDir = null;
}

describe('browser login code routes', () => {
  const previousConfigDir = process.env.TX5DR_CONFIG_DIR;
  let configDir: string;
  let authManager: AuthManager;
  let fastify: ReturnType<typeof Fastify>;
  let adminJwt: string;

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'tx5dr-browser-login-routes-'));
    process.env.TX5DR_CONFIG_DIR = configDir;
    resetAuthSingletons();
    authManager = AuthManager.getInstance();
    await authManager.initialize();

    fastify = Fastify();
    await fastify.register(authPlugin);
    await fastify.register(authRoutes, { prefix: '/api/auth' });

    const token = (await readFile(join(configDir, '.admin-token'), 'utf8')).trim();
    const login = await fastify.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token },
    });
    adminJwt = login.json().jwt;
  });

  afterEach(async () => {
    await fastify.close();
    await authManager.flush();
    resetAuthSingletons();
    if (previousConfigDir === undefined) delete process.env.TX5DR_CONFIG_DIR;
    else process.env.TX5DR_CONFIG_DIR = previousConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  it('mints and publicly exchanges a code exactly once', async () => {
    const mint = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(mint.statusCode).toBe(200);
    expect(mint.headers['cache-control']).toBe('no-store');

    const firstExchange = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes/exchange?source=electron',
      payload: { code: mint.json().code },
    });
    expect(firstExchange.statusCode).toBe(200);
    expect(firstExchange.headers['cache-control']).toBe('no-store');
    expect(firstExchange.json()).toMatchObject({ role: UserRole.ADMIN });
    expect(firstExchange.json().jwt).toEqual(expect.any(String));

    const secondExchange = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes/exchange',
      payload: { code: mint.json().code },
    });
    expect(secondExchange.statusCode).toBe(401);
    expect(secondExchange.json().error.code).toBe('INVALID_OR_EXPIRED_BROWSER_LOGIN_CODE');
  });

  it('requires an active admin JWT to mint codes', async () => {
    const operator = await authManager.createToken({
      label: 'Operator',
      role: UserRole.OPERATOR,
      operatorIds: [],
      maxOperators: 1,
    }, null);
    const login = await fastify.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: operator.token },
    });

    const unauthenticated = await fastify.inject({ method: 'POST', url: '/api/auth/browser-login-codes' });
    const unauthorized = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes',
      headers: { authorization: `Bearer ${login.json().jwt}` },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['cache-control']).toBe('no-store');
    expect(unauthorized.statusCode).toBe(403);
    expect(unauthorized.headers['cache-control']).toBe('no-store');
  });

  it('rejects a consumed code after its issuing admin is downgraded', async () => {
    const mint = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    const systemToken = authManager.listTokens().find(token => token.system)!;
    await authManager.updateToken(systemToken.id, { role: UserRole.OPERATOR });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes/exchange',
      payload: { code: mint.json().code },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_OR_EXPIRED_BROWSER_LOGIN_CODE');
  });

  it('rejects codes after the issuing token is revoked or expired', async () => {
    for (const invalidation of ['revoked', 'expired'] as const) {
      const created = await authManager.createToken({
        label: `Temporary admin ${invalidation}`,
        role: UserRole.ADMIN,
        operatorIds: [],
        maxOperators: 0,
      }, null);
      const login = await fastify.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { token: created.token },
      });
      const mint = await fastify.inject({
        method: 'POST',
        url: '/api/auth/browser-login-codes',
        headers: { authorization: `Bearer ${login.json().jwt}` },
      });

      if (invalidation === 'revoked') await authManager.revokeToken(created.id);
      else await authManager.updateToken(created.id, { expiresAt: Date.now() - 1 });

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/auth/browser-login-codes/exchange',
        payload: { code: mint.json().code },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('INVALID_OR_EXPIRED_BROWSER_LOGIN_CODE');
    }
  });

  it('invalidates outstanding codes when the auth manager is reinitialized', async () => {
    const mint = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes',
      headers: { authorization: `Bearer ${adminJwt}` },
    });

    await authManager.initialize();
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes/exchange',
      payload: { code: mint.json().code },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 429 when an issuer has too many outstanding codes', async () => {
    for (let index = 0; index < 8; index += 1) {
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/auth/browser-login-codes',
        headers: { authorization: `Bearer ${adminJwt}` },
      });
      expect(response.statusCode).toBe(200);
    }

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/auth/browser-login-codes',
      headers: { authorization: `Bearer ${adminJwt}` },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('TOO_MANY_BROWSER_LOGIN_CODES');
  });
});
