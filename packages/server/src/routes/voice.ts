import { FastifyInstance } from 'fastify';
import { readFile } from 'fs/promises';
import {
  UserRole,
  VoiceKeyerPanelUpdateSchema,
  VoiceKeyerSlotUpdateSchema,
} from '@tx5dr/contracts';
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

  fastify.get('/keyer/:callsign', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    const manager = engine.getVoiceKeyerManager();
    if (!manager) {
      throw new Error('Voice keyer manager not available');
    }
    const panel = await manager.getPanel(callsign);
    return reply.send({ success: true, panel });
  });

  fastify.patch('/keyer/:callsign', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    const body = VoiceKeyerPanelUpdateSchema.parse(req.body);
    const manager = engine.getVoiceKeyerManager();
    if (!manager) {
      throw new Error('Voice keyer manager not available');
    }
    const panel = await manager.updatePanel(callsign, body.slotCount);
    return reply.send({ success: true, panel });
  });

  fastify.patch('/keyer/:callsign/slots/:slotId', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const body = VoiceKeyerSlotUpdateSchema.parse(req.body);
    const manager = engine.getVoiceKeyerManager();
    if (!manager) {
      throw new Error('Voice keyer manager not available');
    }
    const panel = await manager.updateSlot(callsign, slotId, body);
    return reply.send({ success: true, panel });
  });

  fastify.post('/keyer/:callsign/slots/:slotId/audio', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const file = await req.file();
    if (!file) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'audio file is required',
        userMessage: 'Please record audio before uploading',
      });
    }
    const manager = engine.getVoiceKeyerManager();
    if (!manager) {
      throw new Error('Voice keyer manager not available');
    }
    const panel = await manager.saveSlotAudio(callsign, slotId, await file.toBuffer());
    return reply.send({ success: true, panel });
  });

  fastify.get('/keyer/:callsign/slots/:slotId/audio', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const manager = engine.getVoiceKeyerManager();
    if (!manager) {
      throw new Error('Voice keyer manager not available');
    }
    const audioPath = await manager.getSlotAudioPathForRead(callsign, slotId);
    return reply.type('audio/wav').send(await readFile(audioPath));
  });

  fastify.delete('/keyer/:callsign/slots/:slotId/audio', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const manager = engine.getVoiceKeyerManager();
    if (!manager) {
      throw new Error('Voice keyer manager not available');
    }
    const panel = await manager.deleteSlotAudio(callsign, slotId);
    return reply.send({ success: true, panel });
  });
}
