import { HamLib } from 'hamlib';
import { HamlibConfig, SerialConfig } from '@tx5dr/contracts';

export class PhysicalRadioManager {
  private rig: HamLib | null = null;
  private currentConfig: HamlibConfig = { type: 'none' };

  getConfig(): HamlibConfig {
    return { ...this.currentConfig };
  }

  async applyConfig(config: HamlibConfig): Promise<void> {
    await this.disconnect();
    this.currentConfig = config;
    
    if (config.type === 'none') {
      return;
    }
    
    const port = config.type === 'network' ? `${config.host}:${config.port}` : config.path;
    const model = config.type === 'network' ? 2 : config.rigModel;
    
    try {
      this.rig = new HamLib(model as any, port as any);

      // 如果是串口模式且有串口配置，应用串口参数
      if (config.type === 'serial' && config.serialConfig) {
        await this.applySerialConfig(config.serialConfig);
      }

      // 异步打开连接，带超时保护
      await this.openWithTimeout();
      
      console.log(`✅ [PhysicalRadioManager] 电台连接成功: ${config.type === 'network' ? 'Network' : 'Serial'} - ${port}`);
    } catch (error) {
      this.rig = null;
      throw new Error(`电台连接失败: ${(error as Error).message}`);
    }
  }

  /**
   * 应用串口配置参数
   */
  private async applySerialConfig(serialConfig: SerialConfig): Promise<void> {
    if (!this.rig) {
      throw new Error('电台实例未初始化');
    }

    console.log('🔧 [PhysicalRadioManager] 应用串口配置参数...');

    try {
      // 基础串口设置
      const configs = [
        { param: 'data_bits', value: serialConfig.data_bits },
        { param: 'stop_bits', value: serialConfig.stop_bits },
        { param: 'serial_parity', value: serialConfig.serial_parity },
        { param: 'serial_handshake', value: serialConfig.serial_handshake },
        { param: 'rts_state', value: serialConfig.rts_state },
        { param: 'dtr_state', value: serialConfig.dtr_state },
        // 通信设置
        { param: 'rate', value: serialConfig.rate?.toString() },
        { param: 'timeout', value: serialConfig.timeout?.toString() },
        { param: 'retry', value: serialConfig.retry?.toString() },
        // 时序控制
        { param: 'write_delay', value: serialConfig.write_delay?.toString() },
        { param: 'post_write_delay', value: serialConfig.post_write_delay?.toString() }
      ];

      for (const config of configs) {
        if (config.value !== undefined && config.value !== null) {
          console.log(`🔧 [PhysicalRadioManager] 设置 ${config.param}: ${config.value}`);
          await Promise.race([
            this.rig.setSerialConfig(config.param as any, config.value),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`设置${config.param}超时`)), 3000)
            )
          ]);
        }
      }

      console.log('✅ [PhysicalRadioManager] 串口配置参数应用成功');
    } catch (error) {
      console.warn('⚠️ [PhysicalRadioManager] 串口配置应用失败:', (error as Error).message);
      throw new Error(`串口配置失败: ${(error as Error).message}`);
    }
  }

  /**
   * 带超时的连接打开
   */
  private async openWithTimeout(): Promise<void> {
    if (!this.rig) {
      throw new Error('电台实例未初始化');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.error('⏰ 电台连接超时 (10秒)');
        reject(new Error('电台连接超时'));
      }, 10000);
      
      // 异步打开连接
      this.rig!.open()
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  async disconnect(): Promise<void> {
    if (this.rig) {
      try {
        console.log('🔌 [PhysicalRadioManager] 正在断开电台连接...');
        
        // 异步关闭连接，带超时保护
        await Promise.race([
          this.rig.close(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('关闭连接超时')), 5000)
          )
        ]);
        
        console.log('✅ [PhysicalRadioManager] 电台连接已关闭');
      } catch (error) {
        console.warn('⚠️ [PhysicalRadioManager] 关闭连接时出现警告:', (error as Error).message);
      }
      
      try {
        // 异步销毁实例，带超时保护
        await Promise.race([
          this.rig.destroy(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('销毁实例超时')), 3000)
          )
        ]);
        
        console.log('🗑️ [PhysicalRadioManager] 电台实例已销毁');
      } catch (error) {
        console.warn('⚠️ [PhysicalRadioManager] 销毁实例时出现警告:', (error as Error).message);
      }
      
      this.rig = null;
    }
  }

  async setFrequency(freq: number): Promise<void> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      // 异步设置频率，带超时保护
      await Promise.race([
        this.rig.setFrequency(freq),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('设置频率超时')), 5000)
        )
      ]);
      
      console.log(`🔊 [PhysicalRadioManager] 频率设置成功: ${(freq / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      throw new Error(`设置频率失败: ${(error as Error).message}`);
    }
  }

  async setPTT(state: boolean): Promise<void> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    const startTime = Date.now();
    
    try {
      console.log(`📡 [PhysicalRadioManager] 开始PTT操作: ${state ? '启动发射' : '停止发射'}`);
      
      // 异步设置PTT，带超时保护
      await Promise.race([
        this.rig.setPtt(state),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('PTT操作超时')), 5000)
        )
      ]);
      
      const duration = Date.now() - startTime;
      console.log(`📡 [PhysicalRadioManager] PTT设置成功: ${state ? '发射' : '接收'} (耗时: ${duration}ms)`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`📡 [PhysicalRadioManager] PTT设置失败: ${state ? '发射' : '接收'} (耗时: ${duration}ms) - ${(error as Error).message}`);
      throw new Error(`PTT设置失败: ${(error as Error).message}`);
    }
  }

  isConnected(): boolean {
    return !!this.rig;
  }

  /**
   * 测试连接是否正常工作
   * 快速验证电台响应，不进行复杂操作
   */
  async testConnection(): Promise<void> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      // 异步获取当前频率来验证连接，带超时保护
      const currentFreq = await Promise.race([
        this.rig.getFrequency(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('获取频率超时')), 5000)
        )
      ]) as number;
      
      console.log(`✅ [PhysicalRadioManager] 连接测试成功，当前频率: ${(currentFreq / 1000000).toFixed(3)} MHz`);
    } catch (error) {
      throw new Error(`连接测试失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      const frequency = await Promise.race([
        this.rig.getFrequency(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('获取频率超时')), 5000)
        )
      ]) as number;
      
      return frequency;
    } catch (error) {
      throw new Error(`获取频率失败: ${(error as Error).message}`);
    }
  }

  /**
   * 设置模式
   */
  async setMode(mode: string, bandwidth?: 'narrow' | 'wide'): Promise<void> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      await Promise.race([
        this.rig.setMode(mode, bandwidth),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('设置模式超时')), 5000)
        )
      ]);
      
      console.log(`📻 [PhysicalRadioManager] 模式设置成功: ${mode}${bandwidth ? ` (${bandwidth})` : ''}`);
    } catch (error) {
      throw new Error(`设置模式失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取当前模式
   */
  async getMode(): Promise<{ mode: string; bandwidth: string }> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      const modeInfo = await Promise.race([
        this.rig.getMode(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('获取模式超时')), 5000)
        )
      ]) as { mode: string; bandwidth: string };
      
      return modeInfo;
    } catch (error) {
      throw new Error(`获取模式失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取信号强度
   */
  async getSignalStrength(): Promise<number> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      const strength = await Promise.race([
        this.rig.getStrength(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('获取信号强度超时')), 3000)
        )
      ]) as number;
      
      return strength;
    } catch (error) {
      throw new Error(`获取信号强度失败: ${(error as Error).message}`);
    }
  }

  /**
   * 批量操作 - 避免多次单独调用
   */
  async getRadioStatus(): Promise<{
    frequency: number;
    mode: { mode: string; bandwidth: string };
    signalStrength?: number;
  }> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      // 并行获取状态信息，提高效率
      const [frequency, mode, signalStrength] = await Promise.all([
        this.getFrequency(),
        this.getMode(),
        this.getSignalStrength().catch(() => -999) // 信号强度获取失败不影响其他信息
      ]);

      return {
        frequency,
        mode,
        signalStrength: signalStrength !== -999 ? signalStrength : undefined
      };
    } catch (error) {
      throw new Error(`获取电台状态失败: ${(error as Error).message}`);
    }
  }

  static listSupportedRigs() {
    return HamLib.getSupportedRigs();
  }
}
