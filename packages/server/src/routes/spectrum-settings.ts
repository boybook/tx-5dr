import type { FastifyInstance } from 'fastify';
import {
  getSpectrumPresetDefinition,
  SpectrumPresetSchema,
  SpectrumSettingsResponseSchema,
  SpectrumSettingsUpdateRequestSchema,
  UserRole,
} from '@tx5dr/contracts';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireRole } from '../auth/authPlugin.js';

const PRESETS = ['responsive', 'balanced', 'fine'] as const;

function createResponse(engine: DigitalRadioEngine, message?: string) {
  return SpectrumSettingsResponseSchema.parse({
    success: true,
    ...(message ? { message } : {}),
    currentSettings: engine.getSpectrumScheduler().getRenderConfig(),
    presets: PRESETS.map(getSpectrumPresetDefinition),
  });
}

export async function spectrumSettingsReadRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();
  fastify.get('/', { preHandler: [requireRole(UserRole.VIEWER)] }, async (_request, reply) => (
    reply.code(200).send(createResponse(engine))
  ));
}

export async function spectrumSettingsWriteRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();
  fastify.post('/', {
    preHandler: [requireRole(UserRole.ADMIN)],
    schema: {
      body: {
        type: 'object',
        required: ['preset'],
        properties: {
          preset: { type: 'string' },
          settings: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const parsedResult = SpectrumSettingsUpdateRequestSchema.safeParse(request.body);
    if (!parsedResult.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_CONFIG', message: 'Invalid spectrum analysis settings' },
      });
    }
    const parsed = parsedResult.data;
    const preset = parsed.preset;
    const customSettings = parsed.preset === 'custom' ? parsed.settings : undefined;
    SpectrumPresetSchema.parse(preset);
    const settings = await engine.updateSpectrumSettings(preset, customSettings);
    return reply.code(200).send(SpectrumSettingsResponseSchema.parse({
      success: true,
      message: 'Spectrum analysis preset updated',
      currentSettings: settings,
      presets: PRESETS.map(getSpectrumPresetDefinition),
    }));
  });
}
