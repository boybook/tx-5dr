import { FastifyInstance } from 'fastify';
import {
  AudioDevicesResponseSchema,
  AudioDeviceSettingsSchema,
  AudioDeviceSettingsResponseSchema,
  AudioSettingsResolveRequestSchema,
  AudioSettingsResolveResponseSchema,
} from '@tx5dr/contracts';
import { AudioDeviceManager } from '../audio/audio-device-manager.js';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

/**
 * 音频设备管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
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
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.AUDIO_DEVICE_ERROR);
    }
  });

  // 获取当前音频设备设置
  fastify.get('/settings', async (request, reply) => {
    try {
      const currentSettings = configManager.getAudioConfig();
      const deviceResolution = await audioManager.resolveAudioSettings(currentSettings);

      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        currentSettings,
        deviceResolution,
      });

      return reply.code(200).send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.post('/resolve', {
    schema: {
      body: zodToJsonSchema(AudioSettingsResolveRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const { audio, radioType } = AudioSettingsResolveRequestSchema.parse(request.body);
      const deviceResolution = await audioManager.resolveAudioSettings(audio, radioType);

      const response = AudioSettingsResolveResponseSchema.parse({
        success: true,
        deviceResolution,
      });

      return reply.code(200).send(response);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.AUDIO_DEVICE_ERROR);
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

      // 检查引擎是否正在运行
      const wasRunning = digitalRadioEngine.getStatus().isRunning;

      // 如果引擎正在运行，先停止它
      if (wasRunning) {
        fastify.log.info('Audio settings update: stopping engine to apply new config');
        await digitalRadioEngine.stop();
      }

      // 更新配置（只存储设备名称）
      await configManager.updateAudioConfig(settings);
      digitalRadioEngine.getAudioStreamManager().reloadAudioConfig();
      fastify.log.info({ settings }, 'Audio device config updated');

      // 如果引擎之前在运行，重新启动它
      if (wasRunning) {
        fastify.log.info('Audio settings update: restarting engine');
        await digitalRadioEngine.start();
      }

      const updatedSettings = configManager.getAudioConfig();
      const deviceResolution = await audioManager.resolveAudioSettings(updatedSettings);

      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        message: wasRunning
          ? 'Audio device settings updated, engine restarted'
          : 'Audio device settings updated',
        currentSettings: updatedSettings,
        deviceResolution,
      });

      return reply.code(200).send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      // Zod验证错误会被Fastify自动捕获，这里只处理操作失败
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // 重置音频设备设置
  fastify.post('/settings/reset', async (request, reply) => {
    try {
      // 检查引擎是否正在运行
      const wasRunning = digitalRadioEngine.getStatus().isRunning;

      // 如果引擎正在运行，先停止它
      if (wasRunning) {
        fastify.log.info('Audio settings reset: stopping engine to apply default config');
        await digitalRadioEngine.stop();
      }

      await configManager.updateAudioConfig({
        inputDeviceName: undefined,
        outputDeviceName: undefined,
        sampleRate: 48000,
        bufferSize: 1024,
      });
      digitalRadioEngine.getAudioStreamManager().reloadAudioConfig();

      fastify.log.info('Audio device config reset to default');

      // 如果引擎之前在运行，重新启动它
      if (wasRunning) {
        fastify.log.info('Audio settings reset: restarting engine');
        await digitalRadioEngine.start();
      }

      const resetSettings = configManager.getAudioConfig();
      const deviceResolution = await audioManager.resolveAudioSettings(resetSettings);

      const response = AudioDeviceSettingsResponseSchema.parse({
        success: true,
        message: wasRunning
          ? 'Audio device settings reset, engine restarted'
          : 'Audio device settings reset',
        currentSettings: resetSettings,
        deviceResolution,
      });

      return reply.code(200).send(response);
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
