import type { FastifyInstance } from 'fastify';
import {
  TciSpectrumSettingsResponseSchema,
  TciSpectrumSettingsSchema,
  UserRole,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireAbility, requireRole } from '../auth/authPlugin.js';

function getTciConnection(engine: DigitalRadioEngine) {
  const connection = engine.getRadioManager().getActiveConnection() as {
    getTciSpectrumSettings?: () => Promise<unknown>;
    setTciSpectrumSettings?: (settings: unknown) => Promise<unknown>;
    getType?: () => string;
  } | null;
  if (!connection || connection.getType?.() !== 'tci' || !connection.getTciSpectrumSettings) {
    return null;
  }
  return connection;
}

export async function tciSpectrumSettingsReadRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();
  fastify.get('/', { preHandler: [requireRole(UserRole.VIEWER)] }, async (_request, reply) => {
    const connection = getTciConnection(engine);
    if (!connection) return reply.code(404).send({ success: false, error: { code: 'TCI_UNAVAILABLE', message: 'TCI spectrum is unavailable' } });
    return reply.code(200).send(TciSpectrumSettingsResponseSchema.parse({
      success: true,
      settings: await connection.getTciSpectrumSettings!(),
    }));
  });
}

export async function tciSpectrumSettingsWriteRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();
  fastify.post('/', { preHandler: [requireAbility('execute', 'RadioControl')] }, async (request, reply) => {
    const connection = getTciConnection(engine);
    if (!connection?.setTciSpectrumSettings) return reply.code(404).send({ success: false, error: { code: 'TCI_UNAVAILABLE', message: 'TCI spectrum is unavailable' } });
    const parsed = TciSpectrumSettingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ success: false, error: { code: 'INVALID_CONFIG', message: 'Invalid TCI spectrum settings' } });
    const settings = await connection.setTciSpectrumSettings(parsed.data);
    return reply.code(200).send(TciSpectrumSettingsResponseSchema.parse({ success: true, settings }));
  });
}
