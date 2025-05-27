import { FastifyInstance } from 'fastify';
import { ConfigManager } from '../config/config-manager.js';
import { FT8ConfigUpdateSchema, ServerConfigUpdateSchema } from '@tx5dr/contracts';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function configRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();

  // 获取完整配置
  fastify.get('/', async (request, reply) => {
    try {
      const config = configManager.getConfig();
      return reply.code(200).send({
        success: true,
        data: config,
      });
    } catch (error) {
      fastify.log.error('获取配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 获取FT8配置
  fastify.get('/ft8', async (request, reply) => {
    try {
      const ft8Config = configManager.getFT8Config();
      return reply.code(200).send({
        success: true,
        data: ft8Config,
      });
    } catch (error) {
      fastify.log.error('获取FT8配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 更新FT8配置
  fastify.post('/ft8', {
    schema: {
      body: zodToJsonSchema(FT8ConfigUpdateSchema),
    },
  }, async (request, reply) => {
    try {
      const updates = FT8ConfigUpdateSchema.parse(request.body);
      
      await configManager.updateFT8Config(updates);
      
      const updatedConfig = configManager.getFT8Config();
      
      return reply.code(200).send({
        success: true,
        message: 'FT8配置更新成功',
        data: updatedConfig,
      });
    } catch (error) {
      fastify.log.error('更新FT8配置失败:', error);
      
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({
          success: false,
          message: '请求参数格式错误',
        });
      }
      
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 获取服务器配置
  fastify.get('/server', async (request, reply) => {
    try {
      const serverConfig = configManager.getServerConfig();
      return reply.code(200).send({
        success: true,
        data: serverConfig,
      });
    } catch (error) {
      fastify.log.error('获取服务器配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 更新服务器配置
  fastify.post('/server', {
    schema: {
      body: zodToJsonSchema(ServerConfigUpdateSchema),
    },
  }, async (request, reply) => {
    try {
      const updates = ServerConfigUpdateSchema.parse(request.body);
      
      await configManager.updateServerConfig(updates);
      
      const updatedConfig = configManager.getServerConfig();
      
      return reply.code(200).send({
        success: true,
        message: '服务器配置更新成功',
        data: updatedConfig,
      });
    } catch (error) {
      fastify.log.error('更新服务器配置失败:', error);
      
      if (error instanceof Error && error.name === 'ZodError') {
        return reply.code(400).send({
          success: false,
          message: '请求参数格式错误',
        });
      }
      
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 验证配置
  fastify.get('/validate', async (request, reply) => {
    try {
      const validation = configManager.validateConfig();
      
      return reply.code(200).send({
        success: true,
        data: validation,
      });
    } catch (error) {
      fastify.log.error('验证配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 重置配置
  fastify.post('/reset', async (request, reply) => {
    try {
      await configManager.resetConfig();
      
      const resetConfig = configManager.getConfig();
      
      return reply.code(200).send({
        success: true,
        message: '配置已重置为默认值',
        data: resetConfig,
      });
    } catch (error) {
      fastify.log.error('重置配置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 获取配置文件路径
  fastify.get('/path', async (request, reply) => {
    try {
      const configPath = configManager.getConfigPath();
      
      return reply.code(200).send({
        success: true,
        data: {
          path: configPath,
        },
      });
    } catch (error) {
      fastify.log.error('获取配置文件路径失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });
} 