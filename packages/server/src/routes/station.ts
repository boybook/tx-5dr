import type { FastifyInstance } from 'fastify';
import { UpdateStationInfoRequestSchema } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { requireAbility } from '../auth/authPlugin.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StationRoutes');

/**
 * Station info routes:
 * GET  /api/station/info  — public, no auth required
 * PUT  /api/station/info  — admin only (enforced via preHandler)
 */
export async function stationRoutes(fastify: FastifyInstance): Promise<void> {
  const configManager = ConfigManager.getInstance();

  fastify.get('/info', async (_request, reply) => {
    const data = configManager.getStationInfo();
    return reply.code(200).send({ success: true, data });
  });

  fastify.put('/info', {
    preHandler: [requireAbility('update', 'StationInfo')],
  }, async (request, reply) => {
    const parsed = UpdateStationInfoRequestSchema.parse(request.body);
    await configManager.updateStationInfo(parsed);
    logger.info('Station info saved via API', { callsign: parsed.callsign });
    return reply.code(200).send({ success: true, data: configManager.getStationInfo() });
  });
}
