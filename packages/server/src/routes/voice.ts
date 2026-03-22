import { FastifyInstance } from 'fastify';
import { UserRole, VoiceQSORecordSchema } from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { requireRole } from '../auth/authPlugin.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VoiceRoute');

/**
 * Voice mode REST API routes.
 * Note: frequency presets are managed through the unified /settings/frequency-presets API.
 */
export async function voiceRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();

  // GET /ptt-status - return PTT lock state
  fastify.get('/ptt-status', async (_req, reply) => {
    const voiceSessionManager = engine.getVoiceSessionManager();
    if (!voiceSessionManager) {
      return reply.send({ success: true, lock: { locked: false, lockedBy: null, lockedByLabel: null, lockedAt: null, timeoutMs: 180000 } });
    }
    return reply.send({ success: true, lock: voiceSessionManager.getPTTLockState() });
  });

  // POST /qso-log - save voice QSO record (require OPERATOR role)
  fastify.post('/qso-log', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    try {
      const record = VoiceQSORecordSchema.parse(req.body);
      logger.info('Voice QSO logged', { callsign: record.callsign, frequency: record.frequency, radioMode: record.radioMode });

      // TODO: persist to logbook when voice logbook integration is implemented
      return reply.send({ success: true, record });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // GET /config - return voice callsign and grid
  fastify.get('/config', async (_req, reply) => {
    return reply.send({
      success: true,
      config: {
        callsign: configManager.getVoiceCallsign(),
        grid: configManager.getVoiceGrid(),
      },
    });
  });

  // POST /config - save voice callsign and grid (require OPERATOR)
  fastify.post('/config', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    try {
      const { callsign, grid } = req.body as { callsign?: string; grid?: string };

      if (callsign !== undefined) {
        await configManager.setVoiceCallsign(callsign);
      }
      if (grid !== undefined) {
        await configManager.setVoiceGrid(grid);
      }

      logger.info('Voice config updated', { callsign, grid });

      return reply.send({
        success: true,
        config: {
          callsign: configManager.getVoiceCallsign(),
          grid: configManager.getVoiceGrid(),
        },
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });
}
