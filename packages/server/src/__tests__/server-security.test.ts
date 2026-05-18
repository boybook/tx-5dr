import Fastify, { type FastifyRequest } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserRole } from '@tx5dr/contracts';
import { isAllowedCorsOrigin, registerRoleScope } from '../server.js';

describe('server security helpers', () => {
  it('allows loopback and same-host browser origins but rejects arbitrary origins', () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true);
    expect(isAllowedCorsOrigin('http://localhost:8076')).toBe(true);
    expect(isAllowedCorsOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedCorsOrigin('https://evil.example')).toBe(false);
  });

  it('allows Android-injected LAN browser origins without relying on Node interface enumeration', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tx5dr-cors-network-'));
    const file = path.join(dir, 'android-network-access.json');
    const previousNetworkAccessFile = process.env.TX5DR_NETWORK_ACCESS_FILE;

    try {
      writeFileSync(file, JSON.stringify({
        hostname: 'android',
        webPort: 8076,
        addresses: [{ ip: '192.168.1.23' }],
      }), 'utf-8');
      process.env.TX5DR_NETWORK_ACCESS_FILE = file;

      expect(isAllowedCorsOrigin('http://192.168.1.23:8076')).toBe(true);
      expect(isAllowedCorsOrigin('http://192.168.1.23:4000')).toBe(false);
    } finally {
      if (previousNetworkAccessFile === undefined) {
        delete process.env.TX5DR_NETWORK_ACCESS_FILE;
      } else {
        process.env.TX5DR_NETWORK_ACCESS_FILE = previousNetworkAccessFile;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies role hooks to child route plugins registered in the same scope', async () => {
    const app = Fastify();
    app.decorateRequest('authUser', null);
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const role = request.headers['x-role'];
      request.authUser = typeof role === 'string'
        ? {
          tokenId: 'test-token',
          role: role as UserRole,
          operatorIds: [],
          iat: 0,
          exp: 0,
        }
        : null;
    });

    await registerRoleScope(app, UserRole.ADMIN, async (scope) => {
      await scope.register(async (child) => {
        child.post('/admin-only', async () => ({ ok: true }));
      });
    });

    try {
      const anonymous = await app.inject({ method: 'POST', url: '/admin-only', payload: {} });
      const viewer = await app.inject({
        method: 'POST',
        url: '/admin-only',
        headers: { 'x-role': UserRole.VIEWER },
        payload: {},
      });
      const admin = await app.inject({
        method: 'POST',
        url: '/admin-only',
        headers: { 'x-role': UserRole.ADMIN },
        payload: {},
      });

      expect(anonymous.statusCode).toBe(401);
      expect(viewer.statusCode).toBe(403);
      expect(admin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
