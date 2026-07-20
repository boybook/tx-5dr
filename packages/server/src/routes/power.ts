/**
 * Radio power management routes
 *
 * Handles physical radio on/off/standby/operate transitions that are outside
 * the capability system because they affect connection reachability.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RadioPowerRequestSchema, UserRole } from '@tx5dr/contracts';
import { requireAbility } from '../auth/authPlugin.js';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

export async function powerRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const controller = engine.getRadioPowerController();
  const sendCrossProfileForbidden = (reply: FastifyReply) => reply.code(403).send({
    success: false,
    error: {
      code: 'FORBIDDEN',
      message: 'Only administrators can power a different Profile',
      userMessage: 'You do not have permission to switch the active radio Profile',
    },
  });
  const requireActiveProfilePowerTarget = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.authUser?.role === UserRole.ADMIN) return;

    const profileId = (req.body as { profileId?: unknown } | null)?.profileId;
    if (typeof profileId === 'string' && profileId !== ConfigManager.getInstance().getActiveProfileId()) {
      return sendCrossProfileForbidden(reply);
    }
  };

  /**
   * POST /api/radio/power
   */
  fastify.post(
    '/',
    { preHandler: [requireAbility('execute', 'RadioPower'), requireActiveProfilePowerTarget] },
    async (req, reply) => {
      try {
        const body = RadioPowerRequestSchema.parse(req.body);
        const state = await controller.handleRequest(body, {
          allowProfileActivation: req.authUser?.role === UserRole.ADMIN,
        });
        return reply.send({ success: true, target: body.state, state });
      } catch (e) {
        if (e instanceof RadioError && e.context?.reason === 'profile-activation-not-authorized') {
          return sendCrossProfileForbidden(reply);
        }
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
