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
          message: `Profile 数据验证失败: ${e.message}`,
          userMessage: '请检查 Profile 配置参数',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['确认名称不为空', '检查电台配置参数'],
        });
      }
      throw e;
    }
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
        message: `Profile ${id} 不存在`,
        userMessage: '找不到指定的 Profile',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['请刷新页面后重试'],
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
          message: `Profile 数据验证失败: ${e.message}`,
          userMessage: '请检查 Profile 配置参数',
          severity: RadioErrorSeverity.WARNING,
          suggestions: ['确认名称不为空', '检查配置参数格式'],
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
        message: `Profile ${id} 不存在`,
        userMessage: '找不到指定的 Profile',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['请刷新页面后重试'],
      });
    }

    // 禁止删除当前激活的 Profile
    if (configManager.getActiveProfileId() === id) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: '无法删除当前激活的 Profile',
        userMessage: '无法删除正在使用的 Profile',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['请先切换到其他 Profile，再删除此 Profile'],
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
        message: `Profile ${id} 不存在`,
        userMessage: '找不到指定的 Profile',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['请刷新页面后重试'],
      });
    }

    const result = await profileManager.activateProfile(id);
    return reply.send(result);
  });
}
