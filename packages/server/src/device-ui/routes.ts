import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DeviceServiceJwtPayloadSchema,
  DeviceUiPairingConsumeRequestSchema,
  DeviceUiSessionRequestSchema,
  type DeviceServiceJwtPayload,
} from '@tx5dr/contracts';
import { DEVICE_UI_AUDIENCE, DEVICE_UI_JWT_TTL_SECONDS, DEVICE_UI_SCOPE, DeviceServiceAuth } from './DeviceServiceAuth.js';
import { DeviceUiProjectionService } from './DeviceUiProjectionService.js';
import { PairingCodeService } from './PairingCodeService.js';

export interface DeviceUiRoutesOptions {
  projection: DeviceUiProjectionService;
}

export async function deviceUiRoutes(fastify: FastifyInstance, options: DeviceUiRoutesOptions): Promise<void> {
  const deviceAuth = DeviceServiceAuth.getInstance();
  const pairing = PairingCodeService.getInstance();

  fastify.get('/health', async () => ({
    status: 'ok' as const,
    service: 'tx5dr-device-ui' as const,
    time: new Date().toISOString(),
  }));

  fastify.post('/session', async (request, reply) => {
    const body = DeviceUiSessionRequestSchema.parse(request.body);
    const ok = await deviceAuth.verifyToken(body.deviceToken);
    if (!ok) {
      return reply.code(401).send({ success: false, error: { code: 'INVALID_DEVICE_TOKEN', message: 'Invalid device token' } });
    }

    const deviceId = body.deviceId || await deviceAuth.getDeviceId();
    const jwt = await reply.jwtSign({
      sub: deviceId,
      deviceId,
      aud: DEVICE_UI_AUDIENCE,
      scope: DEVICE_UI_SCOPE,
    }, { expiresIn: DEVICE_UI_JWT_TTL_SECONDS });

    return { jwt, deviceId, expiresInSeconds: DEVICE_UI_JWT_TTL_SECONDS };
  });

  fastify.get('/bootstrap', { preHandler: requireDeviceServiceAuth }, async () => ({
    model: options.projection.getModel(),
  }));

  fastify.get('/access', { preHandler: requireDeviceServiceAuth }, async () => options.projection.getModel().access);

  fastify.post('/pairing-code', { preHandler: requireDeviceServiceAuth }, async () => {
    const code = pairing.createCode();
    options.projection.updateAccess(null, null, code.code, code.expiresAt);
    return { id: code.id, code: code.code, expiresAt: code.expiresAt };
  });

  fastify.get('/pairing-code/:id', { preHandler: requireDeviceServiceAuth }, async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const record = pairing.getCode(id);
    if (!record) return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Pairing code not found' } });
    return { id: record.id, code: record.code, expiresAt: record.expiresAt };
  });

  fastify.get('/diagnostics', { preHandler: requireDeviceServiceAuth }, async () => ({
    tokenPath: await deviceAuth.getTokenPath(),
    modelUpdatedAt: options.projection.getModel().updatedAt,
  }));
}

export async function requireDeviceServiceAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    reply.code(401).send({ success: false, error: { code: 'DEVICE_AUTH_REQUIRED', message: 'Device service JWT required' } });
    return;
  }

  try {
    const decoded = await request.jwtVerify<DeviceServiceJwtPayload>();
    const parsed = DeviceServiceJwtPayloadSchema.safeParse(decoded);
    if (!parsed.success || parsed.data.aud !== DEVICE_UI_AUDIENCE || parsed.data.scope !== DEVICE_UI_SCOPE) {
      reply.code(403).send({ success: false, error: { code: 'INVALID_DEVICE_JWT', message: 'Invalid device JWT audience or scope' } });
    }
  } catch {
    reply.code(401).send({ success: false, error: { code: 'DEVICE_AUTH_INVALID', message: 'Device service JWT invalid' } });
  }
}

export async function authPairingConsumeRoute(fastify: FastifyInstance): Promise<void> {
  const pairing = PairingCodeService.getInstance();

  fastify.post('/pairing/consume', async (request, reply) => {
    const body = DeviceUiPairingConsumeRequestSchema.parse(request.body);
    const result = pairing.consumeCode(body.code, request.ip);
    if ('error' in result) {
      const status = result.error === 'RATE_LIMITED' ? 429 : 401;
      return reply.code(status).send({ success: false, error: { code: result.error, message: 'Pairing code cannot be consumed' } });
    }

    const jwt = await reply.jwtSign({
      tokenId: result.tokenId,
      role: 'viewer',
      operatorIds: [],
    }, { expiresIn: Math.max(1, Math.floor((result.expiresAt - Date.now()) / 1000)) });

    return { jwt, role: 'viewer' as const, expiresAt: result.expiresAt };
  });
}
