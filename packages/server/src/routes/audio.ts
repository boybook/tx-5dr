import { FastifyInstance } from 'fastify';
import { 
  AudioDevicesResponseSchema, 
  AudioDeviceSettingsSchema, 
  AudioDeviceSettingsResponseSchema 
} from '@tx5dr/contracts';
import { AudioDeviceManager } from '../audio/audio-device-manager.js';
import { ConfigManager } from '../config/config-manager.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function audioRoutes(fastify: FastifyInstance) {
  const audioManager = AudioDeviceManager.getInstance();
  const configManager = ConfigManager.getInstance();

  // 获取所有音频设备
  fastify.get('/devices', async (request, reply) => {
    try {
      const devices = await audioManager.getAllDevices();
      
      const response = AudioDevicesResponseSchema.parse(devices);
      return reply.code(200).send(response);
    } catch (error) {
      fastify.log.error('获取音频设备失败:', error);
      return reply.code(500).send({
        error: '获取音频设备失败',
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 获取当前音频设备设置
  fastify.get('/settings', async (request, reply) => {
    try {
      const currentSettings = configManager.getAudioConfig();
      
      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        currentSettings,
      });
      
      return reply.code(200).send(response);
    } catch (error) {
      fastify.log.error('获取音频设置失败:', error);
      return reply.code(500).send({
        error: '获取音频设置失败',
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });

  // 更新音频设备设置
  fastify.post('/settings', {
    schema: {
      body: zodToJsonSchema(AudioDeviceSettingsSchema),
    },
  }, async (request, reply) => {
    try {
      const settings = AudioDeviceSettingsSchema.parse(request.body);
      
      // 验证设备是否存在
      if (settings.inputDeviceId) {
        const inputDeviceExists = await audioManager.validateDevice(settings.inputDeviceId);
        if (!inputDeviceExists) {
          return reply.code(400).send({
            success: false,
            message: '指定的输入设备不存在',
          });
        }
      }
      
      if (settings.outputDeviceId) {
        const outputDeviceExists = await audioManager.validateDevice(settings.outputDeviceId);
        if (!outputDeviceExists) {
          return reply.code(400).send({
            success: false,
            message: '指定的输出设备不存在',
          });
        }
      }
      
      // 更新配置
      await configManager.updateAudioConfig(settings);
      
      const updatedSettings = configManager.getAudioConfig();
      
      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        message: '音频设备设置更新成功',
        currentSettings: updatedSettings,
      });
      
      return reply.code(200).send(response);
    } catch (error) {
      fastify.log.error('更新音频设置失败:', error);
      
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

  // 重置音频设备设置
  fastify.post('/settings/reset', async (request, reply) => {
    try {
      await configManager.updateAudioConfig({
        inputDeviceId: undefined,
        outputDeviceId: undefined,
        sampleRate: 48000,
        bufferSize: 1024,
      });
      
      const resetSettings = configManager.getAudioConfig();
      
      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        message: '音频设备设置已重置',
        currentSettings: resetSettings,
      });
      
      return reply.code(200).send(response);
    } catch (error) {
      fastify.log.error('重置音频设置失败:', error);
      return reply.code(500).send({
        success: false,
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  });


} 