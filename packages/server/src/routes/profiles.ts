/**
 * Profile 管理 API 路由
 */
import { FastifyInstance } from 'fastify';
import { ConfigManager } from '../config/config-manager.js';
import { ProfileManager } from '../config/ProfileManager.js';
import { CreateProfileRequestSchema, UpdateProfileRequestSchema } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

export async function profileRoutes(fastify: FastifyInstance) {
  const profileManager = ProfileManager.getInstance();
  const configManager = ConfigManager.getInstance();

  /**
   * GET /profiles - 获取 Profile 列表
   */
  fastify.get('/', async (_req, reply) => {
    return reply.send({
      profiles: profileManager.getAllProfiles(),
      activeProfileId: configManager.getActiveProfileId(),
    });
  });

  /**
   * POST /profiles - 创建 Profile
   */
  fastify.post('/', async (req, reply) => {
    try {
      const data = CreateProfileRequestSchema.parse(req.body);
      const profile = await profileManager.createProfile(data);
      return reply.status(201).send({ success: true, profile });
    } catch (e) {
      if (e instanceof Error && e.name === 'ZodError') {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `Profile data validation failed: ${e.message}`,
          userMessage: 'Check Profile configuration parameters',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Confirm name is not empty', 'Check radio configuration parameters'],
        });
      }
      throw e;
    }
  });

  /**
   * PUT /profiles/reorder - 重排 Profile 顺序
   */
  fastify.put('/reorder', async (req, reply) => {
    const { profileIds } = req.body as { profileIds: string[] };

    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'profileIds must be a non-empty array',
        userMessage: 'Invalid sort parameters',
        severity: RadioErrorSeverity.WARNING,
      });
    }

    await profileManager.reorderProfiles(profileIds);
    return reply.send({ success: true });
  });

  /**
   * PUT /profiles/:id - 更新 Profile
   */
  fastify.put<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params;

    // 检查 Profile 是否存在
    if (!profileManager.getProfile(id)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Profile ${id} does not exist`,
        userMessage: 'Profile not found',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['Please refresh the page and try again'],
      });
    }

    try {
      const updates = UpdateProfileRequestSchema.parse(req.body);
      const profile = await profileManager.updateProfile(id, updates);
      return reply.send({ success: true, profile });
    } catch (e) {
      if (e instanceof Error && e.name === 'ZodError') {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: `Profile data validation failed: ${e.message}`,
          userMessage: 'Check Profile configuration parameters',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['Confirm name is not empty', 'Check configuration parameter format'],
        });
      }
      throw e;
    }
  });

  /**
   * DELETE /profiles/:id - 删除 Profile
   */
  fastify.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { id } = req.params;

    if (!profileManager.getProfile(id)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Profile ${id} does not exist`,
        userMessage: 'Profile not found',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['Please refresh the page and try again'],
      });
    }

    // 禁止删除当前激活的 Profile
    if (configManager.getActiveProfileId() === id) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Cannot delete the currently active Profile',
        userMessage: 'Cannot delete Profile currently in use',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['Please switch to another Profile before deleting this one'],
      });
    }

    await profileManager.deleteProfile(id);
    return reply.send({ success: true });
  });

  /**
   * POST /profiles/:id/activate - 激活 Profile
   */
  fastify.post<{ Params: { id: string } }>('/:id/activate', async (req, reply) => {
    const { id } = req.params;

    if (!profileManager.getProfile(id)) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Profile ${id} does not exist`,
        userMessage: 'Profile not found',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['Please refresh the page and try again'],
      });
    }

    const result = await profileManager.activateProfile(id);
    return reply.send(result);
  });
}
