import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { requireRole } from '../auth/authPlugin.js';
import { UserRole, RecordingSettingsSchema } from '@tx5dr/contracts';
import { RecordingService } from '../audio/RecordingService.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { getConfigFilePath } from '../utils/app-paths.js';

export async function recordingRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();
  const configPath = await getConfigFilePath('config.json');
  const service = new RecordingService(engine.getAudioStreamManager(), path.dirname(configPath));
  fastify.addHook('onClose', async () => service.dispose());
  fastify.get('/settings', { preHandler: [requireRole(UserRole.OPERATOR)] }, async () => ({ ...service.getSettings(), mp3Supported: true }));
  fastify.get('/status', { preHandler: [requireRole(UserRole.OPERATOR)] }, async () => service.getStatus());
  fastify.put('/settings', { preHandler: [requireRole(UserRole.OPERATOR)] }, async request => service.setSettings(RecordingSettingsSchema.parse(request.body)));
  fastify.get('/', { preHandler: [requireRole(UserRole.OPERATOR)] }, async () => service.list());
  fastify.post('/start', { preHandler: [requireRole(UserRole.OPERATOR)] }, async () => service.start());
  fastify.post('/stop', { preHandler: [requireRole(UserRole.OPERATOR)] }, async () => service.stop());
  fastify.get<{ Params: { id: string } }>('/:id/download', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => { const file = await service.download(request.params.id); return reply.type(file.entry.format === 'mp3' ? 'audio/mpeg' : 'audio/wav').header('Content-Disposition', `attachment; filename="${file.entry.fileName}"`).send(await fs.readFile(file.path)); });
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async request => { await service.delete(request.params.id); return { success: true }; });
}
