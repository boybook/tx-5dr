import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ImagePaperSaveCommandSchema, ImageReceiveProfileSchema, ImageTemplateSchema, UserRole } from '@tx5dr/contracts';

import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { AuthManager } from '../auth/AuthManager.js';
import { requireRole } from '../auth/authPlugin.js';
import { rasterwaveRuntime } from '../image-radio/RasterwaveRuntime.js';

function canAccessOperator(request: FastifyRequest, operatorId: string): boolean {
  const user = request.authUser;
  return Boolean(user && AuthManager.hasOperatorAccess(user.role, user.operatorIds, operatorId));
}

function requireStores(engine: DigitalRadioEngine) {
  const artifacts = engine.getImageArtifactStore();
  const composerBackgrounds = engine.getImageComposerBackgroundStore();
  const history = engine.getImageHistoryStore();
  const templates = engine.getImageTemplateStore();
  if (!artifacts || !composerBackgrounds || !history || !templates) throw new Error('IMAGE_RADIO_NOT_INITIALIZED');
  return { artifacts, composerBackgrounds, history, templates };
}

export async function imageRadioRoutes(fastify: FastifyInstance): Promise<void> {
  const engine = DigitalRadioEngine.getInstance();

  fastify.get('/status', async (_request, reply) => {
    return reply.send({ success: true, status: engine.getImageRadioService()?.getStatus() ?? null });
  });

  fastify.get('/modes', async (_request, reply) => {
    try {
      return reply.send({ success: true, modes: rasterwaveRuntime.load().sstvModes() });
    } catch (error) {
      return reply.code(503).send({ success: false, error: { code: 'IMAGE_NATIVE_UNAVAILABLE', message: (error as Error).message } });
    }
  });

  fastify.put('/receive-profile', {
    preHandler: [requireRole(UserRole.OPERATOR)],
  }, async (request, reply) => {
    const service = engine.getImageRadioService();
    if (!service) return reply.code(503).send({ success: false, error: { code: 'IMAGE_RADIO_NOT_INITIALIZED' } });
    const profile = ImageReceiveProfileSchema.parse(request.body);
    try {
      const status = profile.family === 'sstv'
        ? await service.configureSstvReceive(profile)
        : await service.configureFaxReceive(profile);
      return reply.send({ success: true, status });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'IMAGE_RECEIVE_PROFILE_FAILED';
      return reply.code(code === 'IMAGE_MODE_INVALID' ? 400 : 503).send({ success: false, error: { code } });
    }
  });

  fastify.get('/history', async (request, reply) => {
    const { artifacts, history } = requireStores(engine);
    const query = request.query as {
      family?: 'sstv' | 'fax'; direction?: 'all' | 'rx' | 'tx'; operatorId?: string;
      limit?: string; cursor?: string;
    };
    let direction = query.direction ?? 'all';
    let txOperatorId = query.operatorId;
    let includeAllTx = false;
    const user = request.authUser;

    if (!user || user.role === UserRole.VIEWER) {
      if (direction === 'tx') return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
      direction = 'rx';
      txOperatorId = undefined;
    } else if (user.role === UserRole.ADMIN) {
      includeAllTx = !txOperatorId;
    } else {
      txOperatorId ??= user.operatorIds[0];
      if (txOperatorId && !canAccessOperator(request, txOperatorId)) {
        return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
      }
      if (!txOperatorId && direction === 'tx') {
        return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
      }
    }

    const page = history.list({
      family: query.family,
      direction,
      txOperatorId,
      includeAllTx,
      limit: Number(query.limit) || 50,
      cursor: query.cursor,
    });
    const entries = page.records.flatMap((record) => {
      const artifact = artifacts.get(record.artifactId);
      return artifact ? [{ record, artifact }] : [];
    });
    return reply.send({ success: true, entries, nextCursor: page.nextCursor });
  });

  fastify.patch('/history/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { artifacts, history } = requireStores(engine);
    const { id } = request.params as { id: string };
    const record = history.get(id);
    if (!record) return reply.code(404).send({ success: false, error: { code: 'IMAGE_HISTORY_NOT_FOUND' } });
    if (record.direction === 'tx' && !canAccessOperator(request, record.operatorId)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    }
    const body = request.body as { qsoId?: string };
    if (!body.qsoId) return reply.code(400).send({ success: false, error: { code: 'IMAGE_HISTORY_PATCH_INVALID' } });
    const updated = await history.linkQso(id, body.qsoId);
    await artifacts.linkQso(record.artifactId, body.qsoId);
    return reply.send({ success: true, record: updated });
  });

  fastify.delete('/history/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { artifacts, history, templates } = requireStores(engine);
    const { id } = request.params as { id: string };
    const record = history.get(id);
    if (!record) return reply.code(404).send({ success: false, error: { code: 'IMAGE_HISTORY_NOT_FOUND' } });
    if (record.direction === 'tx' && !canAccessOperator(request, record.operatorId)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    }
    await history.delete(id);
    const artifact = artifacts.get(record.artifactId);
    if (artifact && !history.referencesArtifact(artifact.id) && !templates.referencesArtifact(artifact.id)) {
      await artifacts.delete(artifact.id).catch(() => undefined);
    }
    return reply.send({ success: true });
  });

  fastify.get('/artifacts', async (request, reply) => {
    const { artifacts } = requireStores(engine);
    const query = request.query as { family?: 'sstv' | 'fax'; direction?: 'rx' | 'tx'; operatorId?: string; limit?: string; offset?: string };
    let direction: 'rx' | 'tx' = query.direction ?? 'rx';
    let operatorId = query.operatorId;
    if (!request.authUser || request.authUser.role === UserRole.VIEWER) direction = 'rx';
    if (direction === 'tx') {
      if (request.authUser?.role === UserRole.VIEWER) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
      if (operatorId && !canAccessOperator(request, operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
      if (request.authUser?.role !== UserRole.ADMIN && !operatorId) operatorId = request.authUser?.operatorIds[0];
    }
    const items = artifacts.list({
      family: query.family,
      direction,
      operatorId,
      limit: Number(query.limit) || 50,
      offset: Number(query.offset) || 0,
    });
    return reply.send({ success: true, artifacts: items });
  });

  fastify.get('/artifacts/:id/image', async (request, reply) => {
    const { artifacts } = requireStores(engine);
    const { id } = request.params as { id: string };
    const artifact = artifacts.get(id);
    if (!artifact) return reply.code(404).send({ success: false, error: { code: 'IMAGE_ARTIFACT_NOT_FOUND' } });
    if (artifact.direction === 'tx' && artifact.operatorId && !canAccessOperator(request, artifact.operatorId)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    }
    return reply.type('image/png').header('Cache-Control', 'private, max-age=31536000, immutable').send(await artifacts.readImage(id));
  });

  fastify.get('/paper/current', async (_request, reply) => {
    const manifest = engine.getImageRadioService()?.getPaperManifest();
    if (!manifest) return reply.code(404).send({ success: false, error: { code: 'IMAGE_PAPER_NOT_FOUND' } });
    return reply.header('Cache-Control', 'private, no-store').send({ success: true, manifest });
  });

  fastify.get('/paper/segments/:boundaryId/snapshot', async (request, reply) => {
    const service = engine.getImageRadioService();
    if (!service) return reply.code(404).send({ success: false, error: { code: 'IMAGE_PAPER_NOT_FOUND' } });
    try {
      const png = await service.renderPaperSegment((request.params as { boundaryId: string }).boundaryId);
      return reply.type('image/png').header('Cache-Control', 'private, no-store').send(png);
    } catch {
      return reply.code(404).send({ success: false, error: { code: 'IMAGE_PAPER_SEGMENT_NOT_FOUND' } });
    }
  });

  fastify.post('/paper/save', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const command = ImagePaperSaveCommandSchema.parse(request.body);
    if (!canAccessOperator(request, command.operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const service = engine.getImageRadioService();
    if (!service) return reply.code(503).send({ success: false, error: { code: 'IMAGE_RADIO_NOT_INITIALIZED' } });
    try {
      const result = await service.saveCurrentPaper(command);
      return reply.send({ success: true, ...result });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'IMAGE_PAPER_SAVE_FAILED';
      return reply.code(code === 'IMAGE_PAPER_EMPTY' ? 409 : 400).send({ success: false, error: { code } });
    }
  });

  fastify.get('/composer-backgrounds/:operatorId', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { operatorId } = request.params as { operatorId: string };
    if (!canAccessOperator(request, operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const { composerBackgrounds } = requireStores(engine);
    return reply.header('Cache-Control', 'private, no-store').send({ success: true, background: composerBackgrounds.get(operatorId) });
  });

  fastify.get('/composer-backgrounds/:operatorId/image', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { operatorId } = request.params as { operatorId: string };
    if (!canAccessOperator(request, operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const { composerBackgrounds } = requireStores(engine);
    try {
      return reply.type('image/png').header('Cache-Control', 'private, no-store').send(await composerBackgrounds.read(operatorId));
    } catch {
      return reply.code(404).send({ success: false, error: { code: 'IMAGE_COMPOSER_BACKGROUND_NOT_FOUND' } });
    }
  });

  fastify.put('/composer-backgrounds/:operatorId', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { operatorId } = request.params as { operatorId: string };
    if (!canAccessOperator(request, operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const file = await request.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    if (!file || file.mimetype !== 'image/png') return reply.code(400).send({ success: false, error: { code: 'IMAGE_COMPOSER_BACKGROUND_INVALID' } });
    const { composerBackgrounds } = requireStores(engine);
    try {
      const background = await composerBackgrounds.save(operatorId, await file.toBuffer());
      return reply.send({ success: true, background });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'IMAGE_COMPOSER_BACKGROUND_INVALID';
      return reply.code(400).send({ success: false, error: { code } });
    }
  });

  fastify.post('/artifacts/sstv', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const query = request.query as { operatorId?: string; mode?: string; frequency?: string; radioMode?: string };
    if (!query.operatorId || !canAccessOperator(request, query.operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const native = rasterwaveRuntime.load();
    const mode = native.sstvModes().find((item) => item.mode === query.mode);
    if (!mode) return reply.code(400).send({ success: false, error: { code: 'IMAGE_MODE_INVALID' } });
    const file = await request.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!file || file.mimetype !== 'image/png') return reply.code(400).send({ success: false, error: { code: 'IMAGE_UPLOAD_INVALID_PNG' } });
    const { artifacts } = requireStores(engine);
    const frequency = Number(query.frequency);
    if (!Number.isFinite(frequency) || frequency <= 0) return reply.code(400).send({ success: false, error: { code: 'IMAGE_FREQUENCY_INVALID' } });
    const result = await artifacts.importNormalizedSstvPng({
      png: await file.toBuffer(), mode: mode.mode, width: mode.width, height: mode.height,
      operatorId: query.operatorId, frequency, radioMode: query.radioMode,
    });
    return reply.code(201).send({ success: true, artifact: result.artifact });
  });

  fastify.patch('/artifacts/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { artifacts } = requireStores(engine);
    const { id } = request.params as { id: string };
    const artifact = artifacts.get(id);
    if (!artifact) return reply.code(404).send({ success: false, error: { code: 'IMAGE_ARTIFACT_NOT_FOUND' } });
    if (!request.authUser || request.authUser.role === UserRole.VIEWER) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    if (artifact.operatorId && !canAccessOperator(request, artifact.operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const body = request.body as { pinned?: boolean; qsoId?: string };
    let updated = artifact;
    if (typeof body.pinned === 'boolean') updated = await artifacts.setPinned(id, body.pinned);
    if (body.qsoId) updated = await artifacts.linkQso(id, body.qsoId);
    return reply.send({ success: true, artifact: updated });
  });

  fastify.delete('/artifacts/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { artifacts } = requireStores(engine);
    const { id } = request.params as { id: string };
    const artifact = artifacts.get(id);
    if (!artifact) return reply.code(404).send({ success: false, error: { code: 'IMAGE_ARTIFACT_NOT_FOUND' } });
    if (artifact.direction === 'tx' && artifact.operatorId && !canAccessOperator(request, artifact.operatorId)) {
      return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    }
    await artifacts.delete(id);
    return reply.send({ success: true });
  });

  fastify.get('/templates', async (request, reply) => {
    const operatorId = (request.query as { operatorId?: string }).operatorId;
    if (operatorId && !canAccessOperator(request, operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const { templates } = requireStores(engine);
    return reply.send({ success: true, templates: templates.list(operatorId) });
  });

  fastify.put('/templates/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = ImageTemplateSchema.pick({ name: true, backgroundArtifactId: true, layers: true }).extend({ operatorId: ImageTemplateSchema.shape.operatorId.unwrap() }).parse(request.body);
    if (!canAccessOperator(request, body.operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const { templates } = requireStores(engine);
    return reply.send({ success: true, template: await templates.save(body.operatorId, { id, ...body }) });
  });

  fastify.delete('/templates/:id', { preHandler: [requireRole(UserRole.OPERATOR)] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { operatorId } = request.query as { operatorId?: string };
    if (!operatorId || !canAccessOperator(request, operatorId)) return reply.code(403).send({ success: false, error: { code: 'FORBIDDEN' } });
    const { templates } = requireStores(engine);
    await templates.delete(operatorId, id);
    return reply.send({ success: true });
  });
}
