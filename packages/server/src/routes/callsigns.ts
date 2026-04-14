import type { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

/**
 * Callsign tracking routes:
 * GET /api/callsigns/:callsign/tracking — returns tracked data (grid, SNR history, etc.)
 */
export async function callsignRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();

  fastify.get<{ Params: { callsign: string } }>('/:callsign/tracking', async (request, reply) => {
    const { callsign } = request.params;
    const data = engine.callsignTracker.getTrackingData(callsign);
    return reply.code(200).send({ success: true, data: data ?? null });
  });
}
