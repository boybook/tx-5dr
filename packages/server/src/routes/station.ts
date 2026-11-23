import type { FastifyInstance } from 'fastify';
import { UpdateStationInfoRequestSchema } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { requireAbility } from '../auth/authPlugin.js';
import { createLogger } from '../utils/logger.js';
import { getStationIdentityService, type StationIdentityService } from '../services/StationIdentityService.js';

const logger = createLogger('StationRoutes');

export interface StationRoutesOptions {
  identityService?: StationIdentityService;
}

/**
 * Station routes:
 * GET  /api/station/identity — public build identity for desktop shells and discovery
 * GET  /api/station/info     — public, no auth required
 * PUT  /api/station/info     — admin only (enforced via preHandler)
 */
export async function stationRoutes(fastify: FastifyInstance, options: StationRoutesOptions = {}): Promise<void> {
  const configManager = ConfigManager.getInstance();
  const identityService = options.identityService ?? getStationIdentityService();

  fastify.get('/identity', async (_request, reply) => {
    const identity = await identityService.getIdentity();
    return reply
      .code(200)
      .header('Cache-Control', 'no-store')
      .send(identity);
  });

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
