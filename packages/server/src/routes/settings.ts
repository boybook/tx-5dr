import { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DecodeWindowSettingsSchema,
  DEFAULT_DECODE_WINDOW_SETTINGS,
  FT4_WINDOW_PRESETS,
  FT8_WINDOW_PRESETS,
  RealtimeSettingsResponseDataSchema,
  resolveWindowTiming,
  CustomFrequencyPresetsSchema,
  RealtimeSettingsSchema,
} from '@tx5dr/contracts';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { requireAbility } from '../auth/authPlugin.js';
import { LiveKitConfig } from '../realtime/LiveKitConfig.js';
import { RealtimeTransportManager } from '../realtime/RealtimeTransportManager.js';
import { getLiveKitCredentialRuntimeStatus } from '../realtime/LiveKitCredentialState.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { WSServer } from '../websocket/WSServer.js';
import { WSMessageType } from '@tx5dr/contracts';
import {
  normalizeManagedLiveKitSettings,
  validateManagedLiveKitSettings,
  writeManagedLiveKitRuntimeConfig,
} from '../realtime/LiveKitRuntimeConfig.js';

/**
 * 设置管理API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
export async function settingsRoutes(fastify: FastifyInstance) {
  const configManager = ConfigManager.getInstance();
  const transportManager = RealtimeTransportManager.getInstance();

  const buildRealtimeSettingsData = (request: FastifyRequest) => {
    const publicWsUrl = configManager.getLiveKitPublicUrl();
    const transportPolicy = configManager.getRealtimeTransportPolicy();
    const networkMode = configManager.getLiveKitNetworkMode();
    const nodeIp = configManager.getLiveKitNodeIp();
    const connectivityHints = LiveKitConfig.getConnectivityHints(request);
    const health = transportManager.getScopeHealth('radio');

    return RealtimeSettingsResponseDataSchema.parse({
      publicWsUrl,
      transportPolicy,
      networkMode,
      nodeIp,
      runtime: {
        liveKitEnabled: LiveKitConfig.isEnabled(),
        connectivityHints,
        radioReceiveTransport: transportManager.getPreferredTransport('radio', 'recv'),
        radioBridgeHealthy: health.healthy,
        radioBridgeIssueCode: health.issueCode,
        credentialStatus: getLiveKitCredentialRuntimeStatus(),
      },
    });
  };

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
      const settings = configManager.getDecodeWindowSettings() ?? DEFAULT_DECODE_WINDOW_SETTINGS;
      return reply.code(200).send({
        success: true,
        data: {
          settings,
          resolved: {
            ft8: resolveWindowTiming('FT8', settings) ?? FT8_WINDOW_PRESETS.balanced,
            ft4: resolveWindowTiming('FT4', settings) ?? FT4_WINDOW_PRESETS.balanced,
          },
        },
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 更新解码窗口设置
  fastify.put('/decode-windows', {
    preHandler: [requireAbility('update', 'SettingsDecodeWindows')],
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
            ft8: resolveWindowTiming('FT8', parsed) ?? FT8_WINDOW_PRESETS.balanced,
            ft4: resolveWindowTiming('FT4', parsed) ?? FT4_WINDOW_PRESETS.balanced,
          },
        },
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // ==================== 频率预设管理 ====================

  fastify.get('/realtime', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (request, reply) => {
    try {
      return reply.code(200).send({
        success: true,
        data: buildRealtimeSettingsData(request),
      });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  fastify.put('/realtime', {
    preHandler: [requireAbility('manage', 'all')],
  }, async (request, reply) => {
    try {
      const body = RealtimeSettingsSchema.parse(request.body);
      const publicWsUrl = body.publicWsUrl?.trim() || null;
      const managedSettings = normalizeManagedLiveKitSettings({
        networkMode: body.networkMode ?? configManager.getLiveKitNetworkMode(),
        nodeIp: body.nodeIp ?? configManager.getLiveKitNodeIp(),
      });
      validateManagedLiveKitSettings(managedSettings);

      await configManager.updateLiveKitPublicUrl(publicWsUrl);
      await configManager.updateRealtimeTransportPolicy(body.transportPolicy ?? 'auto');
      await configManager.updateLiveKitNetworkMode(managedSettings.networkMode);
      await configManager.updateLiveKitNodeIp(managedSettings.nodeIp);
      await writeManagedLiveKitRuntimeConfig({ settings: managedSettings });

      const data = buildRealtimeSettingsData(request);
      WSServer.getInstance()?.broadcast(WSMessageType.REALTIME_SETTINGS_CHANGED, data);

      return reply.code(200).send({
        success: true,
        message: 'Realtime settings updated',
        data,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('nodeIp')) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: error.message,
          userMessage: 'Manual LiveKit media mode requires a valid public IPv4 address',
        });
      }
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

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

  // 保存自定义频率预设
  fastify.put('/frequency-presets', {
    preHandler: [requireAbility('update', 'SettingsFrequencyPresets')],
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

  // 恢复默认频率预设
  fastify.delete('/frequency-presets', {
    preHandler: [requireAbility('update', 'SettingsFrequencyPresets')],
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
