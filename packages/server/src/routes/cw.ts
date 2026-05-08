import { FastifyInstance } from 'fastify';
import {
  UserRole,
  CWMessagePanelUpdateSchema,
  CWMessageSlotUpdateSchema,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireRole } from '../auth/authPlugin.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CWRoutes');

export async function cwRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();

  // GET /config - return CW keyer config
  fastify.get('/config', async (_req, reply) => {
    const manager = engine.getCWKeyerManager();
    return reply.send({ success: true, config: manager.getConfig() });
  });

  // PUT /config - update CW keyer config (wpm, etc.)
  fastify.put('/config', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    try {
      const manager = engine.getCWKeyerManager();
      const { wpm } = req.body as { wpm?: number };
      await manager.updateConfig({ wpm });
      logger.info('CW keyer config updated', { wpm });
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
