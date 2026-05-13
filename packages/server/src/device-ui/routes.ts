/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DeviceUiBootstrapSnapshotSchema,
  DeviceUiSessionRequestSchema,
  DeviceUiSessionResponseSchema,
  type DeviceUiJwtPayload,
} from '@tx5dr/contracts';
import { DeviceServiceAuthManager } from '../auth/DeviceServiceAuthManager.js';
import { createLogger } from '../utils/logger.js';
import type { DeviceUiProjectionService } from './DeviceUiProjectionService.js';

const logger = createLogger('DeviceUiRoutes');

export interface DeviceUiRoutesOptions {
  projectionService: DeviceUiProjectionService;
  authManager: DeviceServiceAuthManager;
}

export async function deviceUiRoutes(fastify: FastifyInstance, options: DeviceUiRoutesOptions): Promise<void> {
  const projectionService = options.projectionService;
  const authManager = options.authManager;

  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'tx5dr-device-ui',
    time: new Date().toISOString(),
  }));

  fastify.post('/session', async (request, reply) => {
    const parsed = DeviceUiSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid device session request', details: parsed.error.flatten() },
      });
    }

    const session = await authManager.createSession(parsed.data);
    if (!session) {
      logger.warn('Device UI session rejected', { deviceId: parsed.data.deviceId });
      return reply.code(401).send({
        success: false,
        error: { code: 'INVALID_DEVICE_TOKEN', message: 'Device token is invalid or expired' },
      });
    }

    return reply.send(DeviceUiSessionResponseSchema.parse(session));
  });

  fastify.get('/bootstrap', async (request, reply) => {
    const session = await verifyDeviceUiJwtFromRequest(request, authManager).catch(() => null);
    if (!session) {
      return reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Device JWT is required' },
      });
    }

    return reply.send(DeviceUiBootstrapSnapshotSchema.parse(projectionService.getSnapshot()));
  });
}

export async function verifyDeviceUiJwtFromRequest(
  request: FastifyRequest,
  authManager: DeviceServiceAuthManager,
): Promise<{ payload: DeviceUiJwtPayload; session: unknown }> {
  const authHeader = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing bearer token');
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const verified = await authManager.verifyDeviceSession(token);
  if (!verified) {
    throw new Error('Invalid device JWT');
  }
  return verified;
}
