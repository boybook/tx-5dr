/**
 * Routes for the rigctld-compatible TCP bridge.
 *
 * - GET  /status — current running state, listening address, connected clients.
 * - PUT  /config — update enabled/bindAddress/port and reconcile the listener.
 */
import { FastifyInstance } from 'fastify';
import { RigctldBridgeConfigSchema } from '@tx5dr/contracts';
import { requireAbility } from '../auth/authPlugin.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';

export async function rigctldRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();

  fastify.get('/status', async () => {
    return engine.getRigctldStatus();
  });

  fastify.put(
    '/config',
    { preHandler: [requireAbility('execute', 'RigctldBridge')] },
    async (req, reply) => {
      const patch = RigctldBridgeConfigSchema.partial().parse(req.body);
      const status = await engine.updateRigctldConfig(patch);
      return reply.send(status);
    },
  );
}
