import { FastifyInstance } from 'fastify';
import { UserRole, DecodeWindowSettingsSchema, resolveWindowTiming, CustomFrequencyPresetsSchema, AudioMonitorCodecSchema } from '@tx5dr/contracts';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireRole } from '../auth/authPlugin.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

/**
 * 设置管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function settingsRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();

  // 获取 FT8 配置
  fastify.get('/ft8', async (request, reply) => {
    try {
      const ft8Config = configManager.getFT8Config();
      return reply.code(200).send({
        success: true,
        data: ft8Config,
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 更新 FT8 配置
  fastify.put('/ft8', async (request, reply) => {
    try {
      const updates = request.body as Partial<{
        myCallsign: string;
        myGrid: string;
        frequency: number;
        transmitPower: number;
        autoReply: boolean;
        maxQSOTimeout: number;
        decodeWhileTransmitting: boolean;
        spectrumWhileTransmitting: boolean;
      }>;

      await configManager.updateFT8Config(updates);
      fastify.log.info({ updates }, 'FT8 config updated');

      return reply.code(200).send({
        success: true,
        message: 'Configuration saved successfully',
        data: configManager.getFT8Config(),
      });
    } catch (error) {
      // 📊 Day14：使用 RadioError，由全局错误处理器统一处理
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // 获取解码窗口设置
  fastify.get('/decode-windows', async (request, reply) => {
    try {
      const settings = configManager.getDecodeWindowSettings();
      return reply.code(200).send({
        success: true,
        data: {
          settings: settings ?? {},
          resolved: {
            ft8: resolveWindowTiming('FT8', settings) ?? [-1500, -1000, -500, 0, 250],
            ft4: resolveWindowTiming('FT4', settings) ?? [0],
          },
        },
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 更新解码窗口设置（仅管理员）
  fastify.put('/decode-windows', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    try {
      const parsed = DecodeWindowSettingsSchema.parse(request.body);
      await configManager.updateDecodeWindowSettings(parsed);

      // 通知引擎应用新的窗口时序
      const engine = DigitalRadioEngine.getInstance();
      engine.updateDecodeWindows();

      return reply.code(200).send({
        success: true,
        message: 'Decode window settings saved',
        data: {
          settings: parsed,
          resolved: {
            ft8: resolveWindowTiming('FT8', parsed) ?? [-1500, -1000, -500, 0, 250],
            ft4: resolveWindowTiming('FT4', parsed) ?? [0],
          },
        },
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // ==================== 音频监听编码设置 ====================

  fastify.get('/audio-monitor-codec', async (_request, reply) => {
    try {
      const codec = configManager.getAudioMonitorCodec();
      return reply.code(200).send({ success: true, data: { codec } });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.put('/audio-monitor-codec', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    try {
      const body = request.body as { codec?: string };
      const codec = AudioMonitorCodecSchema.parse(body?.codec);
      await configManager.updateAudioMonitorCodec(codec);

      return reply.code(200).send({
        success: true,
        message: 'Audio monitor codec updated',
        data: { codec },
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // ==================== 频率预设管理 ====================

  // 获取频率预设列表（包含所有模式：FT8/FT4/VOICE）
  fastify.get('/frequency-presets', async (_request, reply) => {
    try {
      const custom = configManager.getCustomFrequencyPresets();
      const freqManager = new FrequencyManager(custom);
      return reply.code(200).send({
        success: true,
        presets: freqManager.getPresets(),
        isCustomized: custom !== null,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 保存自定义频率预设（仅管理员，包含所有模式）
  fastify.put('/frequency-presets', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (request, reply) => {
    try {
      const parsed = CustomFrequencyPresetsSchema.parse(request.body);
      await configManager.updateCustomFrequencyPresets(parsed.presets);
      return reply.code(200).send({
        success: true,
        message: 'Frequency presets saved',
        presets: parsed.presets,
        isCustomized: true,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // 恢复默认频率预设（仅管理员）
  fastify.delete('/frequency-presets', {
    preHandler: [requireRole(UserRole.ADMIN)],
  }, async (_request, reply) => {
    try {
      await configManager.resetCustomFrequencyPresets();
      return reply.code(200).send({
        success: true,
        message: 'Frequency presets reset to defaults',
        presets: FrequencyManager.DEFAULT_PRESETS,
        isCustomized: false,
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });
}
