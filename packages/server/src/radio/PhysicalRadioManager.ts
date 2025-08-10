import { HamLib } from 'hamlib';
import { HamlibConfig, SerialConfig } from '@tx5dr/contracts';
import { EventEmitter } from 'eventemitter3';
import { ConsoleLogger } from '../utils/console-logger.js';

interface PhysicalRadioManagerEvents {
  connected: () => void;
  disconnected: (reason?: string) => void;
  reconnecting: (attempt: number) => void;
  reconnectFailed: (error: Error, attempt: number) => void;
  reconnectStopped: (maxAttempts: number) => void;
  error: (error: Error) => void;
}

export class PhysicalRadioManager extends EventEmitter<PhysicalRadioManagerEvents> {
  private logger = ConsoleLogger.getInstance();
  
  constructor() {
    super();
  }
  private rig: HamLib | null = null;
  private currentConfig: HamlibConfig = { type: 'none' };
  
  // 连接监控和重连机制
  private isMonitoring = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = -1; // -1 表示无上限
  private reconnectDelay = 3000; // 固定3秒
  private isReconnecting = false;
  private connectionHealthy = true;
  private lastSuccessfulOperation = Date.now();
  private isCleaningUp = false; // 防止重复清理

  getConfig(): HamlibConfig {
    return { ...this.currentConfig };
  }

  /**
   * 获取重连状态信息
   */
  getReconnectInfo() {
    return {
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      hasReachedMaxAttempts: this.maxReconnectAttempts > 0 && this.reconnectAttempts >= this.maxReconnectAttempts,
      connectionHealthy: this.connectionHealthy,
      nextReconnectDelay: this.reconnectDelay
    };
  }

  /**
   * 设置重连参数
   */
  setReconnectParams(maxAttempts: number, delayMs: number) {
    this.maxReconnectAttempts = maxAttempts;
    this.reconnectDelay = delayMs;
    console.log(`🔧 [PhysicalRadioManager] 重连参数已设置: 最大${maxAttempts}次, 间隔${delayMs}ms`);
  }

  /**
   * 重置重连计数器
   */
  resetReconnectAttempts() {
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.connectionHealthy = true;
    console.log('🔄 [PhysicalRadioManager] 重连计数器已重置');
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
      
      // 连接成功后重置重连状态
      this.resetReconnectAttempts();
      this.lastSuccessfulOperation = Date.now();
      
      // 启动连接监控
      this.startConnectionMonitoring();
      
      // 发射连接成功事件
      this.emit('connected');
      
    } catch (error) {
      this.rig = null;
      console.error(`❌ [PhysicalRadioManager] 电台连接失败: ${(error as Error).message}`);
      this.emit('error', new Error(`电台连接失败: ${(error as Error).message}`));
      // 在重连过程中需要抛出错误，让重连逻辑知道连接失败
      if (this.isReconnecting) {
        throw new Error(`电台连接失败: ${(error as Error).message}`);
      }
      return; // 只在非重连情况下避免进程崩溃
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

  async disconnect(reason?: string): Promise<void> {
    // 停止监控和重连
    this.stopConnectionMonitoring();
    this.stopReconnection();
    
    if (this.rig && !this.isCleaningUp) {
      console.log('🔌 [PhysicalRadioManager] 正在断开电台连接...');
      
      // 使用安全的清理连接方法
      await this.forceCleanupConnection();
      
      console.log('✅ [PhysicalRadioManager] 电台连接已完全断开');
      
      // 发射断开连接事件
      this.emit('disconnected', reason);
    }
  }

  async setFrequency(freq: number): Promise<boolean> {
    if (!this.rig) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法设置频率');
      return false;
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
      this.lastSuccessfulOperation = Date.now();
      return true;
    } catch (error) {
      this.handleOperationError(error as Error, '设置频率');
      console.error(`❌ [PhysicalRadioManager] 设置频率失败: ${(error as Error).message}`);
      return false;
    }
  }

  async setPTT(state: boolean): Promise<void> {
    if (!this.rig) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法设置PTT');
      return;
    }

    const startTime = Date.now();
    
    try {
      console.log(`📡 [PhysicalRadioManager] 开始PTT操作: ${state ? '启动发射' : '停止发射'}`);
      
      // 异步设置PTT，带更短的超时保护
      await Promise.race([
        this.rig.setPtt(state),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('PTT操作超时')), 3000) // 缩短到3秒
        )
      ]);
      
      const duration = Date.now() - startTime;
      console.log(`📡 [PhysicalRadioManager] PTT设置成功: ${state ? '发射' : '接收'} (耗时: ${duration}ms)`);
      this.lastSuccessfulOperation = Date.now();
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = (error as Error).message;
      console.error(`📡 [PhysicalRadioManager] PTT设置失败: ${state ? '发射' : '接收'} (耗时: ${duration}ms) - ${errorMsg}`);
      
      // 特别检查PTT相关的错误
      if (errorMsg.toLowerCase().includes('ptt') || 
          errorMsg.toLowerCase().includes('transmit') ||
          state) { // 如果是启动发射时失败，更严格处理
        console.error(`🚨 [PhysicalRadioManager] PTT操作失败可能表示严重连接问题`);
        this.handleOperationError(error as Error, 'PTT设置');
      } else {
        this.handleOperationError(error as Error, 'PTT设置');
      }
      console.error(`❌ [PhysicalRadioManager] PTT设置失败: ${errorMsg}`);
      // 不要抛出错误，避免进程崩溃
      return;
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
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法测试连接');
      return;
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
      this.lastSuccessfulOperation = Date.now();
    } catch (error) {
      this.handleOperationError(error as Error, '连接测试');
      console.error(`❌ [PhysicalRadioManager] 连接测试失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    if (!this.rig) {
      console.error('❌ [PhysicalRadioManager] 电台未连接，无法获取频率');
      return 0; // 返回默认频率
    }

    try {
      const frequency = await Promise.race([
        this.rig.getFrequency(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('获取频率超时')), 5000)
        )
      ]) as number;
      
      this.lastSuccessfulOperation = Date.now();
      return frequency;
    } catch (error) {
      this.handleOperationError(error as Error, '获取频率');
      console.error(`❌ [PhysicalRadioManager] 获取频率失败: ${(error as Error).message}`);
      return 0; // 返回默认频率
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
      this.lastSuccessfulOperation = Date.now();
    } catch (error) {
      this.handleOperationError(error as Error, '设置模式');
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
      
      this.lastSuccessfulOperation = Date.now();
      return modeInfo;
    } catch (error) {
      this.handleOperationError(error as Error, '获取模式');
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
      
      this.lastSuccessfulOperation = Date.now();
      return strength;
    } catch (error) {
      this.handleOperationError(error as Error, '获取信号强度');
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

  /**
   * 启动连接监控
   */
  private startConnectionMonitoring(): void {
    if (this.isMonitoring || this.currentConfig.type === 'none') {
      return;
    }

    this.isMonitoring = true;
    this.connectionHealthy = true;
    
    console.log('👁️ [PhysicalRadioManager] 启动连接监控 (每3秒检查)');
    
    this.monitoringInterval = setInterval(async () => {
      if (!this.rig || this.isReconnecting) {
        return;
      }

      try {
        // 使用更短的超时进行健康检查
        const frequency = await Promise.race([
          this.rig.getFrequency(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('健康检查超时')), 1500) // 进一步缩短超时时间
          )
        ]);
        
        // 验证返回值是否有效
        if (typeof frequency === 'number' && frequency > 0) {
          // 健康检查成功
          if (!this.connectionHealthy) {
            console.log('✅ [PhysicalRadioManager] 连接恢复健康');
            this.connectionHealthy = true;
          }
          this.lastSuccessfulOperation = Date.now();
        } else {
          throw new Error('获取到无效频率值');
        }
        
      } catch (error) {
        const errorMsg = (error as Error).message.toLowerCase(); // 转换为小写进行匹配
        console.warn('⚠️ [PhysicalRadioManager] 连接健康检查失败:', errorMsg);
        
        // 更全面的错误匹配模式（匹配常见的Hamlib错误）
        const isIOError = errorMsg.includes('io error') || 
                         errorMsg.includes('device not configured') ||
                         errorMsg.includes('健康检查超时') ||
                         errorMsg.includes('无效频率值') ||
                         errorMsg.includes('timeout') ||
                         errorMsg.includes('connection refused') ||
                         errorMsg.includes('port not found') ||
                         errorMsg.includes('no such device') ||
                         errorMsg.includes('no such file or directory') ||  // USB设备断开
                         errorMsg.includes('operation timed out') ||
                         errorMsg.includes('broken pipe') ||
                         errorMsg.includes('resource temporarily unavailable') ||
                         errorMsg.includes('malloc') ||
                         errorMsg.includes('heap corruption') ||
                         errorMsg.includes('guard value');
        
        if (isIOError) {
          console.error('🚨 [PhysicalRadioManager] 检测到设备连接问题，立即触发重连');
          this.connectionHealthy = false;
          this.handleConnectionLoss();
        } else {
          // 即使不是明确的IO错误，连续失败也应该触发重连
          const timeSinceLastSuccess = Date.now() - this.lastSuccessfulOperation;
          if (timeSinceLastSuccess > 8000) { // 8秒内没有成功操作
            console.error('🚨 [PhysicalRadioManager] 连续8秒健康检查失败，触发重连');
            this.connectionHealthy = false;
            this.handleConnectionLoss();
          }
        }
      }
    }, 3000); // 更频繁的检查 - 每3秒一次
  }

  /**
   * 停止连接监控
   */
  private stopConnectionMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log('👁️ [PhysicalRadioManager] 已停止连接监控');
  }

  /**
   * 处理操作错误
   */
  private handleOperationError(error: Error, operation: string): void {
    const errorMsg = error.message.toLowerCase(); // 转换为小写进行匹配
    console.warn(`⚠️ [PhysicalRadioManager] ${operation}失败:`, error.message); // 显示原始错误信息
    this.connectionHealthy = false;
    
    // 扩展的错误匹配模式，涵盖所有可能的Hamlib IO错误
    const isCriticalError = errorMsg.includes('io error') || 
                           errorMsg.includes('device not configured') ||
                           errorMsg.includes('设备未连接') ||
                           errorMsg.includes('连接超时') ||
                           errorMsg.includes('获取频率超时') ||
                           errorMsg.includes('ptt操作超时') ||
                           errorMsg.includes('设置频率超时') ||
                           errorMsg.includes('设置模式超时') ||
                           errorMsg.includes('timeout') ||
                           errorMsg.includes('timed out') ||
                           errorMsg.includes('connection refused') ||
                           errorMsg.includes('connection lost') ||
                           errorMsg.includes('port not found') ||
                           errorMsg.includes('no such device') ||
                           errorMsg.includes('no such file or directory') ||  // USB设备断开
                           errorMsg.includes('operation timed out') ||
                           errorMsg.includes('broken pipe') ||
                           errorMsg.includes('resource temporarily unavailable') ||
                           errorMsg.includes('input/output error') ||
                           errorMsg.includes('device or resource busy') ||
                           errorMsg.includes('no route to host') ||
                           errorMsg.includes('network unreachable') ||
                           errorMsg.includes('invalid argument') ||
                           errorMsg.includes('permission denied');
    
    if (isCriticalError) {
      console.error(`🚨 [PhysicalRadioManager] 检测到严重IO错误，立即触发重连: ${error.message}`);
      this.handleConnectionLoss();
      return;
    }
    
    // 如果不是严重错误，检查操作失败时间
    const timeSinceLastSuccess = Date.now() - this.lastSuccessfulOperation;
    if (timeSinceLastSuccess > 10000) { // 进一步降低到10秒，更快响应
      console.warn('⚠️ [PhysicalRadioManager] 操作持续失败10秒，触发重连机制');
      this.handleConnectionLoss();
    }
  }

  /**
   * 处理连接丢失
   */
  private handleConnectionLoss(): void {
    if (this.isReconnecting || this.currentConfig.type === 'none') {
      return;
    }

    console.warn('🔌 [PhysicalRadioManager] 检测到连接丢失，立即清理连接并开始重连流程');
    
    // 立即清理连接，确保isConnected()返回false
    this.forceCleanupConnection().then(() => {
      console.log('🧹 [PhysicalRadioManager] 连接已清理，状态已更新');
    }).catch((error) => {
      console.warn('⚠️ [PhysicalRadioManager] 清理连接时出错:', error.message);
    });
    
    this.emit('disconnected', '连接丢失');
    this.startReconnection();
  }

  /**
   * 开始重连流程
   */
  private startReconnection(): void {
    if (this.isReconnecting || this.currentConfig.type === 'none') {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts = 0;
    
    console.log('🔄 [PhysicalRadioManager] 开始自动重连...');
    this.attemptReconnection();
  }

  /**
   * 尝试重连
   */
  private async attemptReconnection(): Promise<void> {
    if (!this.isReconnecting) {
      this.stopReconnection();
      return;
    }

    this.reconnectAttempts++;
    console.log(`🔄 [PhysicalRadioManager] 重连尝试 第${this.reconnectAttempts}次`);
    
    this.emit('reconnecting', this.reconnectAttempts);

    try {
      // 等待任何正在进行的清理完成
      while (this.isCleaningUp) {
        console.log('⏳ [PhysicalRadioManager] 等待清理完成...');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // 彻底清理现有连接
      await this.forceCleanupConnection();

      // 更长的延迟让设备和系统都稳定
      console.log('⏳ [PhysicalRadioManager] 等待设备稳定...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 尝试重新连接
      console.log('🔄 [PhysicalRadioManager] 开始重新建立连接...');
      await this.applyConfig(this.currentConfig);
      
      // 验证连接是否真正成功
      if (!this.isConnected()) {
        throw new Error('重连后连接状态验证失败');
      }
      
      console.log('✅ [PhysicalRadioManager] 重连成功');
      this.isReconnecting = false;
      this.connectionHealthy = true;
      
    } catch (error) {
      console.warn(`❌ [PhysicalRadioManager] 重连尝试 ${this.reconnectAttempts} 失败:`, (error as Error).message);
      this.emit('reconnectFailed', error as Error, this.reconnectAttempts);
      
      // 继续重连，使用固定延迟
      console.log(`⏳ [PhysicalRadioManager] ${this.reconnectDelay}ms 后进行下次重连尝试`);
      
      this.reconnectTimer = setTimeout(() => {
        this.attemptReconnection();
      }, this.reconnectDelay);
    }
  }

  /**
   * 强制清理连接，避免内存损坏的安全清理方式
   */
  private async forceCleanupConnection(): Promise<void> {
    if (!this.rig || this.isCleaningUp) return;

    this.isCleaningUp = true;
    console.log('🧹 [PhysicalRadioManager] 开始安全清理连接...');
    
    const rigToClean = this.rig;
    this.rig = null; // 立即清空引用，避免重复操作
    
    try {
      // 按顺序执行清理操作，避免并行调用导致内存损坏
      console.log('🧹 [PhysicalRadioManager] 正在关闭连接...');
      await Promise.race([
        rigToClean.close(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('关闭连接超时')), 5000)
        )
      ]);
      console.log('✅ [PhysicalRadioManager] 连接已关闭');
      
      // 短暂延迟后再销毁，让 Hamlib 有时间清理内部状态
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log('🧹 [PhysicalRadioManager] 正在销毁实例...');
      await Promise.race([
        rigToClean.destroy(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('销毁实例超时')), 3000)
        )
      ]);
      console.log('✅ [PhysicalRadioManager] 实例已销毁');
      
    } catch (error) {
      console.warn('⚠️ [PhysicalRadioManager] 清理连接时出现错误:', (error as Error).message);
      console.warn('⚠️ 这可能是由于设备已断开连接导致的正常现象');
    } finally {
      this.isCleaningUp = false;
    }
    
    console.log('🧹 [PhysicalRadioManager] 连接清理完成');
  }

  /**
   * 停止重连流程
   */
  private stopReconnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
    console.log('🛑 [PhysicalRadioManager] 已停止重连流程');
  }

  /**
   * 手动重连
   */
  async manualReconnect(): Promise<void> {
    console.log('🔄 [PhysicalRadioManager] 手动重连请求');
    
    // 停止自动重连
    this.stopReconnection();
    
    // 重置计数器
    this.resetReconnectAttempts();
    
    // 执行重连
    await this.applyConfig(this.currentConfig);
  }

  static listSupportedRigs() {
    return HamLib.getSupportedRigs();
  }
}
