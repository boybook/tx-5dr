import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  UserRole,
  CWKeyerBackendSchema,
  CWDecoderConfigSchema,
  CWMessagePanelUpdateSchema,
  CWMessageSlotUpdateSchema,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireAbility, requireRole } from '../auth/authPlugin.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CWRoutes');

const UNAUTHORIZED_RESPONSE = {
  success: false,
  error: { code: 'UNAUTHORIZED', message: 'Authentication required', userMessage: 'Please login first' },
} as const;

const FORBIDDEN_RESPONSE = {
  success: false,
  error: { code: 'FORBIDDEN', message: 'Permission denied', userMessage: 'You do not have permission for this operation' },
} as const;

function hasPatchBody(body: unknown): boolean {
  return Boolean(body)
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.keys(body as Record<string, unknown>).length > 0;
}

async function requireCWDecoderConfigUpdateForPatch(request: FastifyRequest, reply: FastifyReply) {
  if (!hasPatchBody(request.body)) return;
  if (!request.authUser) {
    return reply.code(401).send(UNAUTHORIZED_RESPONSE);
  }
  if (request.ability.cannot('update', 'CWDecoderConfig')) {
    return reply.code(403).send(FORBIDDEN_RESPONSE);
  }
}

export async function cwRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();

  fastify.get('/decoder/backends', async (_req, reply) => {
    return reply.send({ success: true, backends: engine.getCWDecoderBackends() });
  });

  fastify.get('/decoder/config', async (_req, reply) => {
    return reply.send({
      success: true,
      config: engine.getCWDecoderConfig(),
      status: engine.getCWDecoderStatus(),
    });
  });

  fastify.put('/decoder/config', {
    preHandler: [requireAbility('update', 'CWDecoderConfig')],
  }, async (req, reply) => {
    try {
      const patch = CWDecoderConfigSchema.partial().parse(req.body);
      const config = await engine.updateCWDecoderConfig(patch);
      return reply.send({ success: true, config, status: engine.getCWDecoderStatus() });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  fastify.post('/decoder/start', {
    preHandler: [requireAbility('execute', 'CWDecoder'), requireCWDecoderConfigUpdateForPatch],
  }, async (req, reply) => {
    try {
      const patch = CWDecoderConfigSchema.partial().parse(req.body ?? {});
      const status = await engine.startCWDecoder(patch);
      return reply.send({ success: true, status, config: engine.getCWDecoderConfig() });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.post('/decoder/stop', {
    preHandler: [requireAbility('execute', 'CWDecoder')],
  }, async (_req, reply) => {
    try {
      const status = await engine.stopCWDecoder();
      return reply.send({ success: true, status, config: engine.getCWDecoderConfig() });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.post('/decoder/clear', {
    preHandler: [requireAbility('execute', 'CWDecoder')],
  }, async (_req, reply) => {
    try {
      const status = engine.clearCWDecoderTranscript();
      return reply.send({ success: true, status, config: engine.getCWDecoderConfig() });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // GET /config - return CW keyer config
  fastify.get('/config', async (_req, reply) => {
    const manager = engine.getCWKeyerManager();
    return reply.send({ success: true, config: await manager.getConfigAsync() });
  });

  // PUT /config - update CW keyer config (wpm, etc.)
  fastify.put('/config', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    try {
      const manager = engine.getCWKeyerManager();
      const body = req.body as { backend?: unknown; wpm?: unknown };
      const update: { backend?: 'cat' | 'serial'; wpm?: number } = {};
      if (body.backend !== undefined) {
        update.backend = CWKeyerBackendSchema.parse(body.backend);
      }
      if (body.wpm !== undefined) {
        update.wpm = Number(body.wpm);
      }
      await manager.updateConfig(update);
      logger.info('CW keyer config updated', update);
      return reply.send({ success: true, config: manager.getConfig() });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // GET /panel/:callsign - get message panel
  fastify.get('/panel/:callsign', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    const manager = engine.getCWKeyerManager();
    const panel = await manager.getPanel(callsign);
    return reply.send({ success: true, panel });
  });

  // PATCH /panel/:callsign - update panel (slot count)
  fastify.patch('/panel/:callsign', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    const body = CWMessagePanelUpdateSchema.parse(req.body);
    const manager = engine.getCWKeyerManager();
    const panel = await manager.updatePanel(callsign, body.slotCount);
    return reply.send({ success: true, panel });
  });

  // PATCH /panel/:callsign/slots/:slotId - update slot
  fastify.patch('/panel/:callsign/slots/:slotId', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const body = CWMessageSlotUpdateSchema.parse(req.body);
    const manager = engine.getCWKeyerManager();
    const panel = await manager.updateSlot(callsign, slotId, body);
    return reply.send({ success: true, panel });
  });

  // DELETE /panel/:callsign/slots/:slotId - clear slot text
  fastify.delete('/panel/:callsign/slots/:slotId', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const manager = engine.getCWKeyerManager();
    const panel = await manager.deleteSlotText(callsign, slotId);
    return reply.send({ success: true, panel });
  });
}
