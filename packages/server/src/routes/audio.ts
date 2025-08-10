import { FastifyInstance } from 'fastify';
import { 
  AudioDevicesResponseSchema, 
  AudioDeviceSettingsSchema, 
  AudioDeviceSettingsResponseSchema 
} from '@tx5dr/contracts';
import { AudioDeviceManager } from '../audio/audio-device-manager.js';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function audioRoutes(fastify: FastifyInstance) {
  const audioManager = AudioDeviceManager.getInstance();
  const configManager = ConfigManager.getInstance();
  const digitalRadioEngine = DigitalRadioEngine.getInstance();

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
      
      // 验证设备是否存在（通过名称查找）
      if (settings.inputDeviceName) {
        const inputDevice = await audioManager.getInputDeviceByName(settings.inputDeviceName);
        if (!inputDevice) {
          return reply.code(400).send({
            success: false,
            message: `指定的输入设备 "${settings.inputDeviceName}" 不存在`,
          });
        }
      }
      
      if (settings.outputDeviceName) {
        const outputDevice = await audioManager.getOutputDeviceByName(settings.outputDeviceName);
        if (!outputDevice) {
          return reply.code(400).send({
            success: false,
            message: `指定的输出设备 "${settings.outputDeviceName}" 不存在`,
          });
        }
      }

      // 检查引擎是否正在运行
      const wasRunning = digitalRadioEngine.getStatus().isRunning;
      
      // 如果引擎正在运行，先停止它
      if (wasRunning) {
        fastify.log.info('音频设置更新：停止解码引擎以应用新配置');
        await digitalRadioEngine.stop();
      }
      
      // 更新配置（只存储设备名称）
      await configManager.updateAudioConfig(settings);
      fastify.log.info('音频设备配置已更新:', settings);
      
      // 如果引擎之前在运行，重新启动它
      if (wasRunning) {
        fastify.log.info('音频设置更新：重新启动解码引擎');
        await digitalRadioEngine.start();
      }

      const updatedSettings = configManager.getAudioConfig();
      
      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        message: wasRunning 
          ? '音频设备设置更新成功，解码引擎已重新启动' 
          : '音频设备设置更新成功',
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
      // 检查引擎是否正在运行
      const wasRunning = digitalRadioEngine.getStatus().isRunning;
      
      // 如果引擎正在运行，先停止它
      if (wasRunning) {
        fastify.log.info('音频设置重置：停止解码引擎以应用默认配置');
        await digitalRadioEngine.stop();
      }

      await configManager.updateAudioConfig({
        inputDeviceName: undefined,
        outputDeviceName: undefined,
        sampleRate: 48000,
        bufferSize: 1024,
      });
      
      fastify.log.info('音频设备配置已重置为默认值');
      
      // 如果引擎之前在运行，重新启动它
      if (wasRunning) {
        fastify.log.info('音频设置重置：重新启动解码引擎');
        await digitalRadioEngine.start();
      }

      const resetSettings = configManager.getAudioConfig();
      
      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        message: wasRunning 
          ? '音频设备设置已重置，解码引擎已重新启动' 
          : '音频设备设置已重置',
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