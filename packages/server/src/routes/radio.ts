/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioRoutes - FastifyRequest处理需要使用any

/**
 * 电台控制API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
import { FastifyInstance } from 'fastify';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RadioRoute');
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { HamlibConfigSchema } from '@tx5dr/contracts';
import { requireAbility, requireAbilityFor } from '../auth/authPlugin.js';
import type { HamlibConfig } from '@tx5dr/contracts';
import serialport from 'serialport';
const { SerialPort } = serialport;
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import type { SetRadioModeOptions } from '../radio/connections/IRadioConnection.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';
import { normalizeHamlibConfig } from '../radio/hamlibConfigUtils.js';
import { buildRadioStatusPayload } from '../radio/buildRadioStatusPayload.js';

/** 判断两个配置是否指向同一硬件目标（用于复用判断） */
function isHardwareSameTarget(a: HamlibConfig, b: HamlibConfig): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'serial': return a.serial?.path === b.serial?.path;
    case 'network': return a.network?.host === b.network?.host && a.network?.port === b.network?.port;
    case 'icom-wlan': return a.icomWlan?.ip === b.icomWlan?.ip && a.icomWlan?.port === b.icomWlan?.port;
    default: return true;
  }
}

/** 判断测试配置是否与已有连接存在硬件冲突（串口独占 / ICOM WLAN 单客户端） */
function isHardwareConflict(active: HamlibConfig, test: HamlibConfig): boolean {
  // 串口：同一 path 就冲突（OS 独占）
  if (test.type === 'serial' && active.type === 'serial'
      && active.serial?.path === test.serial?.path) return true;
  // ICOM WLAN：同一 IP 就冲突（单客户端限制）
  if (test.type === 'icom-wlan' && active.type === 'icom-wlan'
      && active.icomWlan?.ip === test.icomWlan?.ip) return true;
  return false;
}

/** 返回硬件描述文本（用于冲突提示消息） */
function describeHardware(config: HamlibConfig): string {
  switch (config.type) {
    case 'serial': return `Serial ${config.serial?.path || ''}`;
    case 'network': return `Network ${config.network?.host || ''}:${config.network?.port || ''}`;
    case 'icom-wlan': return `ICOM WLAN ${config.icomWlan?.ip || ''}`;
    default: return 'Unknown';
  }
}

function inferModeOptions(appMode: string | undefined, engineMode: 'digital' | 'voice'): SetRadioModeOptions {
  const normalizedAppMode = appMode?.trim().toUpperCase();

  if (normalizedAppMode === 'VOICE') {
    return { intent: 'voice' };
  }

  if (normalizedAppMode === 'FT8' || normalizedAppMode === 'FT4') {
    return { intent: 'digital' };
  }

  return { intent: engineMode === 'voice' ? 'voice' : 'digital' };
}

export async function radioRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();
  const radioManager = engine.getRadioManager();

  fastify.get('/config', async (_req, reply) => {
    return reply.send({ success: true, config: configManager.getRadioConfig() });
  });

  fastify.post('/config', { schema: { body: zodToJsonSchema(HamlibConfigSchema) }, preHandler: [requireAbility('update', 'RadioConfig')] }, async (req, reply) => {
    const config = normalizeHamlibConfig(HamlibConfigSchema.parse(req.body));
    await configManager.updateRadioConfig(config);

    // 标记是否刚刚触发了引擎重启（用于避免重复调用 applyConfig）
    let engineRestarted = false;

    // 如果切换到 ICOM WLAN 模式，自动设置音频设备为 ICOM WLAN
    if (config.type === 'icom-wlan') {
      logger.debug('ICOM WLAN mode detected, auto-setting audio devices');
      const audioConfig = configManager.getAudioConfig();
      const updatedAudioConfig = {
        ...audioConfig,
        inputDeviceName: 'ICOM WLAN',
        outputDeviceName: 'ICOM WLAN'
      };

      // 重启引擎以应用音频配置（参考 POST /audio/settings 的实现）
      const wasRunning = engine.getStatus().isRunning;
      if (wasRunning) {
        logger.debug('Stopping engine to apply audio config');
        await engine.stop();
      }

      await configManager.updateAudioConfig(updatedAudioConfig);
      logger.info('Audio devices auto-set to ICOM WLAN');

      if (wasRunning) {
        logger.debug('Restarting engine');
        await engine.start();
        engineRestarted = true; // 标记已触发重启，radio 资源会自动应用配置
      }
    }

    // 仅在引擎未运行 且 没有刚刚触发重启 时手动应用配置
    // 如果刚触发重启，radio 资源会在 ResourceManager 启动时自动应用配置
    // 这避免了竞态条件（engine.start() 是非阻塞的，检查 isRunning 可能还是 STARTING 状态）
    if (!engine.getStatus().isRunning && !engineRestarted) {
      try {
        await radioManager.applyConfig(config);
        logger.info(`Config applied: type=${config.type}`);
      } catch (error) {
        logger.error('Error applying config:', error);
      }
    } else if (engineRestarted) {
      logger.debug('Engine restarting, radio resource will auto-apply config');
    } else {
      logger.debug('Engine running, radio resource has auto-applied config');
    }

    // 如果 engine 已运行，立即更新 SlotClock 的发射补偿值（热更新）
    if (engine.getStatus().isRunning) {
      const compensationMs = config.transmitCompensationMs || 0;
      engine.updateTransmitCompensation(compensationMs);
      logger.info(`Transmit compensation hot-updated: ${compensationMs}ms`);
    }

    // 广播配置变更事件，确保所有客户端同步最新配置
    const radioInfo = await radioManager.getRadioInfo();
    engine.emit('radioStatusChanged', buildRadioStatusPayload({
      connected: radioManager.isConnected(),
      status: radioManager.getConnectionStatus(),
      radioInfo,
      radioConfig: config,
      reason: 'Configuration updated',
      radioManager,
    }));
    logger.debug(`Config change event broadcast: type=${config.type}, connected=${radioManager.isConnected()}`);

    return reply.send({ success: true, config });
  });

  fastify.get('/rigs', async (_req, reply) => {
    return reply.send({ rigs: await PhysicalRadioManager.listSupportedRigs() });
  });

  fastify.get('/rigs/:rigModel/config-schema', async (req: any, reply) => {
    const rigModel = Number(req.params?.rigModel);

    if (!Number.isInteger(rigModel) || rigModel <= 0) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Invalid rigModel parameter: ${req.params?.rigModel}`,
        userMessage: 'Invalid radio model',
        suggestions: ['Select a valid radio model from the supported rig list'],
      });
    }

    const schema = await PhysicalRadioManager.getRigConfigSchema(rigModel);
    return reply.send(schema);
  });

  fastify.get('/serial-ports', async (_req, reply) => {
    const ports = await SerialPort.list();
    return reply.send({ ports });
  });

  fastify.get('/frequencies', async (_req, reply) => {
    const custom = configManager.getCustomFrequencyPresets();
    const freqManager = new FrequencyManager(custom);
    return reply.send({ success: true, presets: freqManager.getPresets() });
  });

  fastify.get('/last-frequency', async (_req, reply) => {
    const lastFrequency = configManager.getLastSelectedFrequency();
    const lastVoiceFrequency = configManager.getLastVoiceFrequency();
    return reply.send({
      success: true,
      lastFrequency,
      lastVoiceFrequency,
    });
  });

  fastify.post('/frequency', {
    preHandler: [requireAbilityFor('execute', 'RadioFrequency', (r) => ({ frequency: (r.body as any).frequency }))],
  }, async (req, reply) => {
    const { frequency, radioMode, mode, band, description } = req.body as {
      frequency: number;
      radioMode?: string;
      mode?: string;
      band?: string;
      description?: string;
    };
    if (!frequency || typeof frequency !== 'number') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Invalid frequency value: ${frequency}`,
        userMessage: 'Please provide a valid frequency value',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          'Confirm frequency parameter is a number',
          'Check if frequency is within radio supported range'
        ],
      });
    }

    // 获取当前频率配置，用于判断是否真正改变
    const lastFrequency = configManager.getLastSelectedFrequency();
    const isFrequencyChanged = !lastFrequency ||
      lastFrequency.frequency !== frequency ||
      (mode && lastFrequency.mode !== mode);

    if (isFrequencyChanged) {
      logger.debug(`Frequency changed: ${lastFrequency?.frequency || 'null'} -> ${frequency}, mode: ${lastFrequency?.mode || 'null'} -> ${mode || 'null'}`);
    } else {
      logger.debug(`Frequency unchanged, skipping clear and broadcast: ${frequency} Hz, mode: ${mode}`);
    }

    // 保存到配置文件（无论电台是否连接都要保存）
    // Voice mode saves to separate lastVoiceFrequency to avoid overwriting digital frequency
    if (mode && band) {
      try {
        if (mode === 'VOICE') {
          await configManager.updateLastVoiceFrequency({
            frequency,
            radioMode,
            band,
            description,
          });
        } else {
          await configManager.updateLastSelectedFrequency({
            frequency,
            mode,
            radioMode,
            band,
            description
          });
        }
      } catch (configError) {
        logger.warn(`Failed to save frequency config: ${(configError as Error).message}`);
      }
    }

    // 检查电台是否已连接
    const radioConnected = radioManager.isConnected();

    if (!radioConnected) {
      // 电台未连接时，只记录频率但不实际设置
      logger.debug(`Radio not connected, recording frequency: ${(frequency / 1000000).toFixed(3)} MHz${radioMode ? ` (${radioMode})` : ''}`);

      // 只有在频率真正改变时才广播
      if (isFrequencyChanged) {
      engine.emit('frequencyChanged', {
        frequency,
        mode: mode || 'FT8',
        band: band || '',
        description: description || `${(frequency / 1000000).toFixed(3)} MHz`,
        radioMode,
        radioConnected: false,
        source: 'program',
      });
      }

      return reply.send({
        success: true,
        frequency,
        radioMode,
        message: 'Frequency recorded (radio not connected)',
        radioConnected: false
      });
    }

    // 在同一个关键区间内切换频率/模式，避免被后台轮询插入。
    const applyResult = await radioManager.applyOperatingState({
      frequency,
      mode: radioMode,
      bandwidth: radioMode ? 'nochange' : undefined,
      options: radioMode ? inferModeOptions(mode, engine.getEngineMode()) : undefined,
      tolerateModeFailure: true,
    });
    const frequencySuccess = applyResult.frequencyApplied;

    if (!frequencySuccess) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: 'Failed to set radio frequency',
        userMessage: 'Cannot set radio frequency',
        severity: RadioErrorSeverity.ERROR,
        suggestions: [
          'Check if radio connection is normal',
          'Confirm frequency is within radio supported range',
          'Try reconnecting to the radio'
        ],
      });
    }

    if (applyResult.modeError) {
      logger.warn(`Failed to set radio mode: ${applyResult.modeError.message}`);
      // 模式设置失败不影响频率设置的成功
    }

    // 只有在频率真正改变时才清空缓存和广播
    if (isFrequencyChanged) {
      // 基础动作：立即清空服务端内存中的历史接收缓存
      try {
        engine.getSlotPackManager().clearInMemory();
        logger.debug('Frequency switched: SlotPack memory cache cleared');
      } catch (e) {
        logger.warn('Frequency switched: failed to clear SlotPack cache (continuing broadcast):', e);
      }

      // 广播频率变化到所有客户端
      engine.emit('frequencyChanged', {
        frequency,
        mode: mode || 'FT8',
        band: band || '',
        description: description || `${(frequency / 1000000).toFixed(3)} MHz`,
        radioMode,
        radioConnected: true,
        source: 'program',
      });
    }

    return reply.send({
      success: true,
      frequency,
      radioMode,
      message: radioMode ? `Frequency and mode set successfully (${radioMode})` : 'Frequency set successfully',
      radioConnected: true
    });
  });

  fastify.post('/test', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    const config = normalizeHamlibConfig(HamlibConfigSchema.parse(req.body));

    if (config.type === 'none') {
      return reply.send({ success: true, message: 'No radio mode, connection test not needed' });
    }

    // 智能复用：检查引擎是否已连接同一硬件
    if (radioManager.isConnected()) {
      const activeConfig = radioManager.getConfig();

      if (isHardwareSameTarget(activeConfig, config)) {
        // 硬件目标相同 → 复用已有连接进行健康检查
        logger.debug('Reusing existing connection for test');
        try {
          await radioManager.testConnection();
          return reply.send({ success: true, message: 'Connection test successful! Radio responding normally.' });
        } catch (error) {
          throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
        }
      }

      // 硬件冲突检测：串口独占 / ICOM WLAN 单客户端
      if (isHardwareConflict(activeConfig, config)) {
        return reply.send({
          success: false,
          message: `Engine is using ${describeHardware(activeConfig)}, cannot test simultaneously. Stop the engine or use different hardware.`
        });
      }
    }

    // 创建临时连接，同步等待真实结果
    const tester = new PhysicalRadioManager();
    try {
      await tester.applyConfig(config);
      await tester.testConnection();
      logger.info('Connection test succeeded');
      return reply.send({ success: true, message: 'Connection test successful! Radio responding normally.' });
    } catch (e) {
      logger.error('Connection test failed:', e);
      throw RadioError.from(e, RadioErrorCode.CONNECTION_FAILED);
    } finally {
      try {
        await tester.disconnect();
        logger.debug('Test connection cleaned up');
      } catch (error) {
        logger.warn('Failed to clean up test connection:', error);
      }
    }
  });

  fastify.post('/test-ptt', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    const config = normalizeHamlibConfig(HamlibConfigSchema.parse(req.body));

    if (config.type === 'none') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'No radio mode, PTT test not needed',
        userMessage: 'Current configuration is no-radio mode',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          'Configure radio connection type first (serial or network)',
          'Select correct radio type in settings page'
        ],
      });
    }

    // PTT 测试辅助：开启 → 等 500ms → 关闭，确保异常时 PTT 关闭
    const doPttTest = async (manager: PhysicalRadioManager) => {
      try {
        await manager.setPTT(true);
        logger.debug('PTT enabled, radio in transmit state');
        await new Promise(resolve => setTimeout(resolve, 500));
        await manager.setPTT(false);
        logger.info('PTT test complete, returned to receive state');
      } catch (error) {
        // 确保 PTT 关闭
        try { await manager.setPTT(false); } catch { /* ignore */ }
        throw error;
      }
    };

    // 智能复用：检查引擎是否已连接同一硬件
    if (radioManager.isConnected()) {
      const activeConfig = radioManager.getConfig();

      if (isHardwareSameTarget(activeConfig, config)) {
        logger.debug('Reusing existing connection for PTT test');
        try {
          await doPttTest(radioManager);
          return reply.send({ success: true, message: 'PTT test successful! Transmit state toggled for 0.5 seconds.' });
        } catch (error) {
          throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
        }
      }

      if (isHardwareConflict(activeConfig, config)) {
        return reply.send({
          success: false,
          message: `Engine is using ${describeHardware(activeConfig)}, cannot test PTT simultaneously. Stop the engine or use different hardware.`
        });
      }
    }

    // 创建临时连接，同步等待 PTT 测试结果
    logger.debug('Creating temporary connection for PTT test');
    const tester = new PhysicalRadioManager();
    try {
      await tester.applyConfig(config);
      await doPttTest(tester);
      return reply.send({ success: true, message: 'PTT test successful! Transmit state toggled for 0.5 seconds.' });
    } catch (e) {
      logger.error('PTT test failed:', e);
      throw RadioError.from(e, RadioErrorCode.INVALID_OPERATION);
    } finally {
      try {
        await tester.disconnect();
        logger.debug('PTT test connection cleaned up');
      } catch (error) {
        logger.warn('Failed to clean up PTT test connection:', error);
      }
    }
  });

  // 获取电台连接状态
  fastify.get('/status', async (_req, reply) => {
    const config = configManager.getRadioConfig();
    const isConnected = radioManager.isConnected();
    const connectionStatus = radioManager.getConnectionStatus();

    // 使用统一的 getRadioInfo() 方法获取电台信息
    const radioInfo = await radioManager.getRadioInfo();

    return reply.send({
      success: true,
      status: {
        connected: isConnected,
        connectionStatus,
        radioInfo,
        radioConfig: config,
        connectionHealth: radioManager.getConnectionHealth(),
        coreCapabilities: radioManager.getCoreCapabilities(),
        coreCapabilityDiagnostics: radioManager.getCoreCapabilityDiagnostics(),
      },
    });
  });

  // 手动连接电台
  fastify.post('/connect', { preHandler: [requireAbility('execute', 'RadioReconnect')] }, async (_req, reply) => {
    const config = configManager.getRadioConfig();

    if (config.type === 'none') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Current configuration is no-radio mode, cannot connect',
        userMessage: 'Cannot connect to radio',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          'Configure radio type in settings page first',
          'Select serial or network connection type'
        ],
      });
    }

    if (radioManager.isConnected()) {
      return reply.send({
        success: true,
        message: 'Radio already connected',
        isConnected: true
      });
    }

    // 应用配置并连接
    await radioManager.applyConfig(config);

    return reply.send({
      success: true,
      message: 'Radio connected successfully',
      isConnected: true
    });
  });

  // 断开电台连接
  fastify.post('/disconnect', { preHandler: [requireAbility('execute', 'RadioReconnect')] }, async (_req, reply) => {
    await radioManager.disconnect();

    return reply.send({
      success: true,
      message: 'Radio disconnected',
      isConnected: false
    });
  });

  // 手动重连电台
  fastify.post('/manual-reconnect', { preHandler: [requireAbility('execute', 'RadioReconnect')] }, async (_req, reply) => {
    const config = configManager.getRadioConfig();

    if (config.type === 'none') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: 'Current configuration is no-radio mode, cannot reconnect',
        userMessage: 'Cannot reconnect to radio',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          'Configure radio type in settings page first',
          'Select serial or network connection type'
        ],
      });
    }

    // 执行手动重连
    await radioManager.reconnect();

    return reply.send({
      success: true,
      message: 'Radio manual reconnect successful',
      isConnected: true
    });
  });

  // ==================== 天线调谐器控制 ====================

  /**
   * 获取天线调谐器能力
   * GET /radio/tuner/capabilities
   */
  fastify.get('/tuner/capabilities', async (_req, reply) => {
    const capabilities = await radioManager.getTunerCapabilities();
    return reply.send({
      success: true,
      capabilities,
    });
  });

  /**
   * 获取天线调谐器状态
   * GET /radio/tuner/status
   */
  fastify.get('/tuner/status', async (_req, reply) => {
    const status = await radioManager.getTunerStatus();
    return reply.send({
      success: true,
      status,
    });
  });

  /**
   * 设置天线调谐器开关
   * POST /radio/tuner
   * Body: { enabled: boolean }
   */
  fastify.post('/tuner', { preHandler: [requireAbility('execute', 'RadioTuner')] }, async (req, reply) => {
    const { enabled } = req.body as { enabled: boolean };

    if (typeof enabled !== 'boolean') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `Invalid tuner switch value: ${enabled}`,
        userMessage: 'Please provide a valid tuner switch state',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['Confirm enabled parameter is a boolean (true/false)'],
      });
    }

    await radioManager.setTuner(enabled);

    return reply.send({
      success: true,
      message: `Tuner ${enabled ? 'enabled' : 'disabled'}`,
    });
  });

  /**
   * 启动手动调谐
   * POST /radio/tuner/tune
   */
  fastify.post('/tuner/tune', { preHandler: [requireAbility('execute', 'RadioTune')] }, async (_req, reply) => {
    const result = await radioManager.startTuning();

    return reply.send({
      success: result,
      message: result ? 'Tuning successful' : 'Tuning failed',
    });
  });

  // ===== 统一能力系统 REST 接口 =====

  /**
   * 获取当前所有能力的状态快照
   * GET /radio/capabilities
   */
  fastify.get('/capabilities', async (_req, reply) => {
    const snapshot = radioManager.getCapabilitySnapshot();
    return reply.send({ success: true, ...snapshot });
  });

  /**
   * 写入能力值
   * POST /radio/capabilities/:id
   * Body: { value?: boolean | number, action?: boolean }
   */
  fastify.post('/capabilities/:id', { preHandler: [requireAbility('execute', 'RadioControl')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { value?: boolean | number; action?: boolean };

    await radioManager.writeCapability(id, body?.value, body?.action);

    return reply.send({ success: true });
  });
}
