import { FastifyInstance } from 'fastify';
import { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { HamlibConfigSchema } from '@tx5dr/contracts';
import serialport from 'serialport';
const { SerialPort } = serialport;
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { FrequencyManager } from '../radio/FrequencyManager.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export async function radioRoutes(fastify: FastifyInstance) {
  const engine = DigitalRadioEngine.getInstance();
  const configManager = ConfigManager.getInstance();
  const radioManager = engine.getRadioManager();
  const freqManager = new FrequencyManager();

  fastify.get('/config', async (_req, reply) => {
    return reply.send({ success: true, config: configManager.getRadioConfig() });
  });

  fastify.post('/config', { schema: { body: zodToJsonSchema(HamlibConfigSchema) } }, async (req, reply) => {
    try {
      const config = HamlibConfigSchema.parse(req.body);
      await configManager.updateRadioConfig(config);
      if (engine.getStatus().isRunning) {
        await radioManager.applyConfig(config);
      }
      return reply.send({ success: true, config });
    } catch (err) {
      return reply.code(400).send({ success: false, message: (err as Error).message });
    }
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

  fastify.post('/frequency', async (req, reply) => {
    try {
      const { frequency } = req.body as { frequency: number };
      if (!frequency || typeof frequency !== 'number') {
        return reply.code(400).send({ success: false, message: '无效的频率值' });
      }
      
      // 验证频率是否在业余无线电频段内
      if (!freqManager.isValidAmateuerFrequency(frequency)) {
        return reply.code(400).send({ 
          success: false, 
          message: `频率 ${(frequency / 1000000).toFixed(3)} MHz 不在业余无线电频段范围内` 
        });
      }
      
      // 设置电台频率
      await radioManager.setFrequency(frequency);
      return reply.send({ success: true, frequency });
    } catch (error) {
      return reply.code(500).send({ 
        success: false, 
        message: `设置频率失败: ${(error as Error).message}` 
      });
    }
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
      
      return reply.code(400).send({ success: false, message: (e as Error).message });
    }
  });

  fastify.post('/test-ptt', async (_req, reply) => {
    try {
      if (!radioManager.isConnected()) {
        return reply.code(400).send({ 
          success: false, 
          message: '电台未连接，请先配置并连接电台' 
        });
      }

      // 立即返回成功，然后在后台执行PTT测试
      reply.send({ success: true, message: 'PTT测试已启动，正在切换发射状态0.5秒' });
      
      // 在后台异步执行PTT测试流程
      setImmediate(async () => {
        try {
          console.log('🔄 [Radio Routes] 开始PTT测试...');
          
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
      
    } catch (e) {
      return reply.code(400).send({ success: false, message: (e as Error).message });
    }
  });
}
