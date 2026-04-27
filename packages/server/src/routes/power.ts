/**
 * Radio power management routes
 *
 * Handles physical radio on/off/standby/operate transitions that are outside
 * the capability system because they affect connection reachability.
 */
import { FastifyInstance } from 'fastify';
import { RadioPowerRequestSchema } from '@tx5dr/contracts';
import { requireAbility } from '../auth/authPlugin.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { RadioPowerController } from '../radio/RadioPowerController.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

export async function powerRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const controller = RadioPowerController.create({
    radioManager: engine.getRadioManager(),
    getEngineLifecycle: () => engine.getEngineLifecycle(),
  });

  // Bridge controller progress events onto the engine emitter so WSServer can broadcast them
  controller.on('powerState', (event) => {
    engine.emit('radioPowerState', event);
  });

  /**
   * POST /api/radio/power
   */
  fastify.post(
    '/',
    { preHandler: [requireAbility('execute', 'RadioPower')] },
    async (req, reply) => {
      try {
        const body = RadioPowerRequestSchema.parse(req.body);
        const state = await controller.handleRequest(body);
        return reply.send({ success: true, target: body.state, state });
      } catch (e) {
        if (e instanceof Error && e.name === 'ZodError') {
          throw new RadioError({
            code: RadioErrorCode.INVALID_CONFIG,
            message: `Power request validation failed: ${e.message}`,
            userMessage: 'Invalid power request',
            severity: RadioErrorSeverity.WARNING,
          });
        }
        throw e;
      }
    }
  );

  /**
   * GET /api/radio/power/support?profileId=xxx
   */
  fastify.get<{ Querystring: { profileId?: string } }>(
    '/support',
    async (req, reply) => {
      const profileId = req.query.profileId;
      if (!profileId) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'profileId is required',
          userMessage: 'Profile ID is required',
          severity: RadioErrorSeverity.WARNING,
        });
      }
      const info = await controller.getSupportInfo(profileId);
      return reply.send(info);
    }
  );
}
