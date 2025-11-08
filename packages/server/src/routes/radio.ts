/**
 * 电台控制API路由
 * 📊 Day14优化：统一错误处理，使用 RadioError + Fastify 全局错误处理器
 */
import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { HamlibConfigSchema } from '@tx5dr/contracts';
import serialport from 'serialport';
const { SerialPort } = serialport;
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RadioError, RadioErrorCode, RadioErrorSeverity } from '../utils/errors/RadioError.js';

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

    // 如果切换到 ICOM WLAN 模式，自动设置音频设备为 ICOM WLAN
    if (config.type === 'icom-wlan') {
      console.log('📡 [Radio Routes] 检测到 ICOM WLAN 模式，自动设置音频设备');
      const audioConfig = configManager.getAudioConfig();
      const updatedAudioConfig = {
        ...audioConfig,
        inputDeviceName: 'ICOM WLAN',
        outputDeviceName: 'ICOM WLAN'
      };
      await configManager.updateAudioConfig(updatedAudioConfig);
      console.log('✅ [Radio Routes] 音频设备已自动设置为 ICOM WLAN');
    }

    if (engine.getStatus().isRunning) {
      await radioManager.applyConfig(config);
      // 立即更新 SlotClock 的发射补偿值
      const compensationMs = config.transmitCompensationMs || 0;
      engine.updateTransmitCompensation(compensationMs);
      console.log(`✅ [Radio Routes] 发射补偿已热更新为: ${compensationMs}ms`);
    }
    return reply.send({ success: true, config });
  });

  fastify.get('/rigs', async (_req, reply) => {
    return reply.send({ rigs: PhysicalRadioManager.listSupportedRigs() });
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
    const tester = new PhysicalRadioManager();

    try {
      await tester.applyConfig(config);

      // 立即返回成功，然后在后台执行测试
      reply.send({ success: true, message: '连接测试已启动，正在验证电台响应...' });

      // 在后台异步执行连接测试
      setImmediate(async () => {
        try {
          console.log('🔄 [Radio Routes] 开始连接测试...');

          // 测试基本功能：尝试获取频率来验证连接
          await tester.testConnection();
          console.log('✅ [Radio Routes] 连接测试成功');

        } catch (error) {
          console.error('❌ [Radio Routes] 连接测试失败:', error);
        } finally {
          // 无论成功失败都要清理连接
          try {
            await tester.disconnect();
            console.log('🧹 [Radio Routes] 测试连接已清理');
          } catch (error) {
            console.warn('❌ [Radio Routes] 清理测试连接失败:', error);
          }
        }
      });

    } catch (e) {
      // 配置失败时立即清理并返回错误
      setTimeout(async () => {
        try {
          await tester.disconnect();
        } catch (error) {
          console.warn('❌ [Radio Routes] 配置失败后清理实例失败:', error);
        }
      }, 0);

      throw RadioError.from(e, RadioErrorCode.INVALID_CONFIG);
    }
  });

  fastify.post('/test-ptt', async (_req, reply) => {
    const config = configManager.getRadioConfig();

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

    // 检查主程序是否已有电台连接
    if (radioManager.isConnected()) {
      console.log('🔄 [Radio Routes] 使用已有电台连接进行PTT测试');
      
      // 立即返回成功，然后在后台执行PTT测试
      reply.send({ success: true, message: 'PTT测试已启动，正在切换发射状态0.5秒' });
      
      // 在后台异步执行PTT测试流程
      setImmediate(async () => {
        try {
          console.log('🔄 [Radio Routes] 开始PTT测试 (使用已有连接)...');
          
          // 开启PTT
          await radioManager.setPTT(true);
          console.log('📡 [Radio Routes] PTT已开启，电台处于发射状态');
          
          // 等待0.5秒后关闭PTT
          setTimeout(async () => {
            try {
              await radioManager.setPTT(false);
              console.log('✅ [Radio Routes] PTT测试完成，已恢复接收状态');
            } catch (error) {
              console.warn('❌ [Radio Routes] PTT关闭失败:', error);
            }
          }, 500);
          
        } catch (error) {
          console.error('❌ [Radio Routes] PTT测试失败:', error);
        }
      });
      
      return;
    }

    // 主程序未连接，创建临时测试实例
    console.log('🔄 [Radio Routes] 创建临时连接进行PTT测试');
    const tester = new PhysicalRadioManager();
    
    try {
      // 应用配置并连接
      await tester.applyConfig(config);
      
      // 立即返回成功，然后在后台执行PTT测试
      reply.send({ success: true, message: 'PTT测试已启动，正在切换发射状态0.5秒' });
      
      // 在后台异步执行PTT测试流程
      setImmediate(async () => {
        try {
          console.log('🔄 [Radio Routes] 开始PTT测试 (临时连接)...');
          
          // 开启PTT
          await tester.setPTT(true);
          console.log('📡 [Radio Routes] PTT已开启，电台处于发射状态');
          
          // 等待0.5秒后关闭PTT
          setTimeout(async () => {
            try {
              await tester.setPTT(false);
              console.log('✅ [Radio Routes] PTT测试完成，已恢复接收状态');
            } catch (error) {
              console.warn('❌ [Radio Routes] PTT关闭失败:', error);
            } finally {
              // 清理测试连接
              try {
                await tester.disconnect();
                console.log('🧹 [Radio Routes] PTT测试连接已清理');
              } catch (error) {
                console.warn('❌ [Radio Routes] 清理PTT测试连接失败:', error);
              }
            }
          }, 500);
          
        } catch (error) {
          console.error('❌ [Radio Routes] PTT测试失败:', error);
          // 清理测试连接
          try {
            await tester.disconnect();
          } catch (cleanupError) {
            console.warn('❌ [Radio Routes] 清理PTT测试连接失败:', cleanupError);
          }
        }
      });
      
    } catch (e) {
      // 配置失败时立即清理并返回错误
      setTimeout(async () => {
        try {
          await tester.disconnect();
        } catch (error) {
          console.warn('❌ [Radio Routes] PTT配置失败后清理实例失败:', error);
        }
      }, 0);

      throw RadioError.from(e, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // 获取电台连接状态
  fastify.get('/status', async (_req, reply) => {
    const config = configManager.getRadioConfig();
    const isConnected = radioManager.isConnected();

    let radioInfo = null;
    if (isConnected && config.type !== 'none') {
      // 获取电台型号信息
      if (config.type === 'serial' && config.serial?.rigModel) {
        const supportedRigs = PhysicalRadioManager.listSupportedRigs();
        const rigInfo = supportedRigs.find(r => r.rigModel === config.serial!.rigModel);
        if (rigInfo) {
          radioInfo = {
            manufacturer: rigInfo.mfgName,
            model: rigInfo.modelName,
            rigModel: rigInfo.rigModel
          };
        }
      } else if (config.type === 'network') {
        radioInfo = {
          manufacturer: 'Network',
          model: 'RigCtrl',
          rigModel: 2
        };
      }
    }

    return reply.send({
      success: true,
      config,
      isConnected,
      radioInfo,
      connectionType: config.type
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
    await radioManager.manualReconnect();

    return reply.send({
      success: true,
      message: '电台手动重连成功',
      isConnected: true
    });
  });
}
