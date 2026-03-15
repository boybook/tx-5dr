/* eslint-disable @typescript-eslint/no-explicit-any */
// RadioRoutes - FastifyRequest处理需要使用any

/**
 * 电台控制API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { HamlibConfigSchema, RadioConnectionStatus } from '@tx5dr/contracts';
import type { HamlibConfig } from '@tx5dr/contracts';
import serialport from 'serialport';
const { SerialPort } = serialport;
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

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
    case 'serial': return `串口 ${config.serial?.path || ''}`;
    case 'network': return `网络 ${config.network?.host || ''}:${config.network?.port || ''}`;
    case 'icom-wlan': return `ICOM WLAN ${config.icomWlan?.ip || ''}`;
    default: return '未知';
  }
}

export async function radioRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();
  const radioManager = engine.getRadioManager();
  const freqManager = new FrequencyManager();

  fastify.get('/config', async (_req, reply) => {
    return reply.send({ success: true, config: configManager.getRadioConfig() });
  });

  fastify.post('/config', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    const config = HamlibConfigSchema.parse(req.body);
    await configManager.updateRadioConfig(config);

    // 标记是否刚刚触发了引擎重启（用于避免重复调用 applyConfig）
    let engineRestarted = false;

    // 如果切换到 ICOM WLAN 模式，自动设置音频设备为 ICOM WLAN
    if (config.type === 'icom-wlan') {
      console.log('📡 [Radio Routes] 检测到 ICOM WLAN 模式，自动设置音频设备');
      const audioConfig = configManager.getAudioConfig();
      const updatedAudioConfig = {
        ...audioConfig,
        inputDeviceName: 'ICOM WLAN',
        outputDeviceName: 'ICOM WLAN'
      };

      // 重启引擎以应用音频配置（参考 POST /audio/settings 的实现）
      const wasRunning = engine.getStatus().isRunning;
      if (wasRunning) {
        console.log('🔄 [Radio Routes] 停止引擎以应用音频配置');
        await engine.stop();
      }

      await configManager.updateAudioConfig(updatedAudioConfig);
      console.log('✅ [Radio Routes] 音频设备已自动设置为 ICOM WLAN');

      if (wasRunning) {
        console.log('🔄 [Radio Routes] 重新启动引擎');
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
        console.log(`✅ [Radio Routes] 配置已应用: type=${config.type}`);
      } catch (error) {
        console.error('❌ [Radio Routes] 应用配置时出错:', error);
      }
    } else if (engineRestarted) {
      console.log('📡 [Radio Routes] 引擎正在重启，radio 资源会自动应用配置');
    } else {
      console.log('📡 [Radio Routes] 引擎正在运行，radio 资源已自动应用配置');
    }

    // 如果 engine 已运行，立即更新 SlotClock 的发射补偿值（热更新）
    if (engine.getStatus().isRunning) {
      const compensationMs = config.transmitCompensationMs || 0;
      engine.updateTransmitCompensation(compensationMs);
      console.log(`✅ [Radio Routes] 发射补偿已热更新为: ${compensationMs}ms`);
    }

    // 广播配置变更事件，确保所有客户端同步最新配置
    const radioInfo = await radioManager.getRadioInfo();
    engine.emit('radioStatusChanged', {
      connected: radioManager.isConnected(),
      status: radioManager.getConnectionStatus(),
      radioInfo,
      radioConfig: config,
      reason: '配置已更新',
      connectionHealth: radioManager.getConnectionHealth()
    });
    console.log(`📡 [Radio Routes] 已广播配置变更事件: type=${config.type}, connected=${radioManager.isConnected()}`);

    return reply.send({ success: true, config });
  });

  fastify.get('/rigs', async (_req, reply) => {
    return reply.send({ rigs: await PhysicalRadioManager.listSupportedRigs() });
  });

  fastify.get('/serial-ports', async (_req, reply) => {
    const ports = await SerialPort.list();
    return reply.send({ ports });
  });

  fastify.get('/frequencies', async (_req, reply) => {
    return reply.send({ success: true, presets: freqManager.getPresets() });
  });

  fastify.get('/last-frequency', async (_req, reply) => {
    const lastFrequency = configManager.getLastSelectedFrequency();
    return reply.send({ 
      success: true, 
      lastFrequency: lastFrequency 
    });
  });

  fastify.post('/frequency', async (req, reply) => {
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
        message: `无效的频率值: ${frequency}`,
        userMessage: '请提供有效的频率值',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          '确认频率参数是否为数字类型',
          '检查频率范围是否在电台支持的范围内'
        ],
      });
    }

    // 获取当前频率配置，用于判断是否真正改变
    const lastFrequency = configManager.getLastSelectedFrequency();
    const isFrequencyChanged = !lastFrequency ||
      lastFrequency.frequency !== frequency ||
      (mode && lastFrequency.mode !== mode);

    if (isFrequencyChanged) {
      console.log(`📻 [Radio Routes] 频率真正改变: ${lastFrequency?.frequency || 'null'} → ${frequency}, 模式: ${lastFrequency?.mode || 'null'} → ${mode || 'null'}`);
    } else {
      console.log(`📻 [Radio Routes] 频率未改变，跳过清空和广播: ${frequency} Hz, 模式: ${mode}`);
    }

    // 保存到配置文件（无论电台是否连接都要保存）
    if (mode && band) {
      try {
        await configManager.updateLastSelectedFrequency({
          frequency,
          mode,
          radioMode,
          band,
          description
        });
      } catch (configError) {
        console.warn(`⚠️ [Radio Routes] 保存频率配置失败: ${(configError as Error).message}`);
      }
    }

    // 检查电台是否已连接
    const radioConnected = radioManager.isConnected();

    if (!radioConnected) {
      // 电台未连接时，只记录频率但不实际设置
      console.log(`📡 [Radio Routes] 电台未连接，记录频率: ${(frequency / 1000000).toFixed(3)} MHz${radioMode ? ` (${radioMode})` : ''}`);

      // 只有在频率真正改变时才广播
      if (isFrequencyChanged) {
        engine.emit('frequencyChanged', {
          frequency,
          mode: mode || 'FT8',
          band: band || '',
          description: description || `${(frequency / 1000000).toFixed(3)} MHz`,
          radioMode,
          radioConnected: false
        });
      }

      return reply.send({
        success: true,
        frequency,
        radioMode,
        message: '频率已记录（电台未连接）',
        radioConnected: false
      });
    }

    // 设置电台频率和调制模式
    const frequencySuccess = await radioManager.setFrequency(frequency);

    if (!frequencySuccess) {
      throw new RadioError({
        code: RadioErrorCode.INVALID_OPERATION,
        message: '电台频率设置失败',
        userMessage: '无法设置电台频率',
        severity: RadioErrorSeverity.ERROR,
        suggestions: [
          '检查电台连接是否正常',
          '确认频率在电台支持的范围内',
          '尝试重新连接电台'
        ],
      });
    }

    // 如果提供了电台调制模式，也设置该模式
    if (radioMode) {
      try {
        await radioManager.setMode(radioMode);
        console.log(`📻 [Radio Routes] 电台调制模式已设置: ${radioMode}`);
      } catch (modeError) {
        console.warn(`⚠️ [Radio Routes] 设置电台调制模式失败: ${(modeError as Error).message}`);
        // 模式设置失败不影响频率设置的成功
      }
    }

    // 只有在频率真正改变时才清空缓存和广播
    if (isFrequencyChanged) {
      // 基础动作：立即清空服务端内存中的历史接收缓存
      try {
        engine.getSlotPackManager().clearInMemory();
        console.log('🧹 [Radio Routes] 频率切换：已清空 SlotPack 内存缓存');
      } catch (e) {
        console.warn('⚠️ [Radio Routes] 频率切换：清空 SlotPack 缓存失败（继续广播）:', e);
      }

      // 广播频率变化到所有客户端
      engine.emit('frequencyChanged', {
        frequency,
        mode: mode || 'FT8',
        band: band || '',
        description: description || `${(frequency / 1000000).toFixed(3)} MHz`,
        radioMode,
        radioConnected: true
      });
    }

    return reply.send({
      success: true,
      frequency,
      radioMode,
      message: radioMode ? `频率和调制模式设置成功 (${radioMode})` : '频率设置成功',
      radioConnected: true
    });
  });

  fastify.post('/test', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    const config = HamlibConfigSchema.parse(req.body);

    if (config.type === 'none') {
      return reply.send({ success: true, message: '无电台模式，无需测试连接' });
    }

    // 智能复用：检查引擎是否已连接同一硬件
    if (radioManager.isConnected()) {
      const activeConfig = radioManager.getConfig();

      if (isHardwareSameTarget(activeConfig, config)) {
        // 硬件目标相同 → 复用已有连接进行健康检查
        console.log('🔄 [Radio Routes] 复用已有连接进行测试');
        try {
          await radioManager.testConnection();
          return reply.send({ success: true, message: '连接测试成功！电台响应正常。' });
        } catch (error) {
          throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
        }
      }

      // 硬件冲突检测：串口独占 / ICOM WLAN 单客户端
      if (isHardwareConflict(activeConfig, config)) {
        return reply.send({
          success: false,
          message: `引擎正在使用${describeHardware(activeConfig)}，无法同时测试。请先停止引擎或使用不同的硬件。`
        });
      }
    }

    // 创建临时连接，同步等待真实结果
    const tester = new PhysicalRadioManager();
    try {
      await tester.applyConfig(config);
      await tester.testConnection();
      console.log('✅ [Radio Routes] 连接测试成功');
      return reply.send({ success: true, message: '连接测试成功！电台响应正常。' });
    } catch (e) {
      console.error('❌ [Radio Routes] 连接测试失败:', e);
      throw RadioError.from(e, RadioErrorCode.CONNECTION_FAILED);
    } finally {
      try {
        await tester.disconnect();
        console.log('🧹 [Radio Routes] 测试连接已清理');
      } catch (error) {
        console.warn('⚠️ [Radio Routes] 清理测试连接失败:', error);
      }
    }
  });

  fastify.post('/test-ptt', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    const config = HamlibConfigSchema.parse(req.body);

    if (config.type === 'none') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: '无电台模式无需测试PTT',
        userMessage: '当前配置为无电台模式',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          '请先配置电台连接方式（串口或网络）',
          '在设置页面选择正确的电台类型'
        ],
      });
    }

    // PTT 测试辅助：开启 → 等 500ms → 关闭，确保异常时 PTT 关闭
    const doPttTest = async (manager: PhysicalRadioManager) => {
      try {
        await manager.setPTT(true);
        console.log('📡 [Radio Routes] PTT已开启，电台处于发射状态');
        await new Promise(resolve => setTimeout(resolve, 500));
        await manager.setPTT(false);
        console.log('✅ [Radio Routes] PTT测试完成，已恢复接收状态');
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
        console.log('🔄 [Radio Routes] 复用已有连接进行PTT测试');
        try {
          await doPttTest(radioManager);
          return reply.send({ success: true, message: 'PTT 测试成功！已切换发射状态 0.5 秒。' });
        } catch (error) {
          throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
        }
      }

      if (isHardwareConflict(activeConfig, config)) {
        return reply.send({
          success: false,
          message: `引擎正在使用${describeHardware(activeConfig)}，无法同时测试 PTT。请先停止引擎或使用不同的硬件。`
        });
      }
    }

    // 创建临时连接，同步等待 PTT 测试结果
    console.log('🔄 [Radio Routes] 创建临时连接进行PTT测试');
    const tester = new PhysicalRadioManager();
    try {
      await tester.applyConfig(config);
      await doPttTest(tester);
      return reply.send({ success: true, message: 'PTT 测试成功！已切换发射状态 0.5 秒。' });
    } catch (e) {
      console.error('❌ [Radio Routes] PTT测试失败:', e);
      throw RadioError.from(e, RadioErrorCode.INVALID_OPERATION);
    } finally {
      try {
        await tester.disconnect();
        console.log('🧹 [Radio Routes] PTT测试连接已清理');
      } catch (error) {
        console.warn('⚠️ [Radio Routes] 清理PTT测试连接失败:', error);
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
      },
    });
  });

  // 手动连接电台
  fastify.post('/connect', async (_req, reply) => {
    const config = configManager.getRadioConfig();

    if (config.type === 'none') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: '当前配置为无电台模式，无法连接',
        userMessage: '无法连接电台',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          '请先在设置页面配置电台类型',
          '选择串口或网络连接方式'
        ],
      });
    }

    if (radioManager.isConnected()) {
      return reply.send({
        success: true,
        message: '电台已连接',
        isConnected: true
      });
    }

    // 应用配置并连接
    await radioManager.applyConfig(config);

    return reply.send({
      success: true,
      message: '电台连接成功',
      isConnected: true
    });
  });

  // 断开电台连接
  fastify.post('/disconnect', async (_req, reply) => {
    await radioManager.disconnect();

    return reply.send({
      success: true,
      message: '电台已断开连接',
      isConnected: false
    });
  });

  // 手动重连电台
  fastify.post('/manual-reconnect', async (_req, reply) => {
    const config = configManager.getRadioConfig();

    if (config.type === 'none') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: '当前配置为无电台模式，无法重连',
        userMessage: '无法重连电台',
        severity: RadioErrorSeverity.WARNING,
        suggestions: [
          '请先在设置页面配置电台类型',
          '选择串口或网络连接方式'
        ],
      });
    }

    // 执行手动重连
    await radioManager.reconnect();

    return reply.send({
      success: true,
      message: '电台手动重连成功',
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
  fastify.post('/tuner', async (req, reply) => {
    const { enabled } = req.body as { enabled: boolean };

    if (typeof enabled !== 'boolean') {
      throw new RadioError({
        code: RadioErrorCode.INVALID_CONFIG,
        message: `无效的天调开关值: ${enabled}`,
        userMessage: '请提供有效的天调开关状态',
        severity: RadioErrorSeverity.WARNING,
        suggestions: ['确认 enabled 参数是否为布尔类型 (true/false)'],
      });
    }

    await radioManager.setTuner(enabled);

    return reply.send({
      success: true,
      message: `天调已${enabled ? '启用' : '禁用'}`,
    });
  });

  /**
   * 启动手动调谐
   * POST /radio/tuner/tune
   */
  fastify.post('/tuner/tune', async (_req, reply) => {
    const result = await radioManager.startTuning();

    return reply.send({
      success: result,
      message: result ? '调谐成功' : '调谐失败',
    });
  });
}
