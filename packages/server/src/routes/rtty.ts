import type { FastifyInstance } from 'fastify';
import {
  KeyboardMessagePanelUpdateSchema,
  KeyboardMessageSlotSwapSchema,
  KeyboardMessageSlotUpdateSchema,
  RttyConfigPatchSchema,
  RttyTuningUpdateSchema,
  UserRole,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireAbility, requireCallsignAccess, requireRole } from '../auth/authPlugin.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

export async function rttyRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const service = () => engine.getRttyService();

  // GET /state - configuration plus live transmit and decoder state
  fastify.get('/state', async (_req, reply) => {
    return reply.send({
      success: true,
      config: engine.getRttyConfig(),
      txStatus: service()?.getTxStatus() ?? null,
      decoderStatus: service()?.getDecoderStatus() ?? null,
      scan: service()?.getScanUpdate() ?? null,
      transcript: service()?.getTranscriptSnapshot() ?? null,
    });
  });

  // PUT /config - persist RTTY configuration (tones, profile, receive and transmit options)
  fastify.put('/config', {
    preHandler: [requireAbility('update', 'RttyDecoderConfig')],
  }, async (req, reply) => {
    try {
      const patch = RttyConfigPatchSchema.parse(req.body);
      const config = await engine.updateRttyConfig(patch);
      return reply.send({ success: true, config });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // PATCH /tuning - move the receiver while dragging, without persisting
  fastify.patch('/tuning', {
    preHandler: [requireAbility('update', 'RttyDecoderConfig')],
  }, async (req, reply) => {
    try {
      const { centerHz } = RttyTuningUpdateSchema.parse(req.body);
      service()?.previewCenter(centerHz);
      return reply.send({ success: true });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // POST /decoder/clear - start a new receive transcript
  fastify.post('/decoder/clear', {
    preHandler: [requireAbility('execute', 'RttyDecoder')],
  }, async (_req, reply) => {
    const status = service()?.clearTranscript() ?? null;
    return reply.send({ success: true, status });
  });

  // GET /panel/:callsign - message panel
  fastify.get('/panel/:callsign', {
    preHandler: [requireRole(UserRole.OPERATOR), requireCallsignAccess()],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    return reply.send({ success: true, panel: await engine.getRttyPanels().getPanel(callsign) });
  });

  fastify.patch('/panel/:callsign', {
    preHandler: [requireRole(UserRole.OPERATOR), requireCallsignAccess()],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    const body = KeyboardMessagePanelUpdateSchema.parse(req.body);
    return reply.send({ success: true, panel: await engine.getRttyPanels().updatePanel(callsign, body.slotCount) });
  });

  fastify.patch('/panel/:callsign/slots/:slotId', {
    preHandler: [requireRole(UserRole.OPERATOR), requireCallsignAccess()],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    const body = KeyboardMessageSlotUpdateSchema.parse(req.body);
    return reply.send({ success: true, panel: await engine.getRttyPanels().updateSlot(callsign, slotId, body) });
  });

  fastify.delete('/panel/:callsign/slots/:slotId', {
    preHandler: [requireRole(UserRole.OPERATOR), requireCallsignAccess()],
  }, async (req, reply) => {
    const { callsign, slotId } = req.params as { callsign: string; slotId: string };
    return reply.send({ success: true, panel: await engine.getRttyPanels().deleteSlotText(callsign, slotId) });
  });

  fastify.post('/panel/:callsign/slots/swap', {
    preHandler: [requireRole(UserRole.OPERATOR), requireCallsignAccess()],
  }, async (req, reply) => {
    const { callsign } = req.params as { callsign: string };
    const body = KeyboardMessageSlotSwapSchema.parse(req.body);
    return reply.send({ success: true, panel: await engine.getRttyPanels().swapSlots(callsign, body.slotIdA, body.slotIdB) });
  });
}
