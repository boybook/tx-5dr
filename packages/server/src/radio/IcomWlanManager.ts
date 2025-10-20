import { IcomControl, AUDIO_RATE } from 'icom-wlan-node';
import { EventEmitter } from 'eventemitter3';
import { ConsoleLogger } from '../utils/console-logger.js';

export interface IcomWlanConfig {
  ip: string;
  port: number;
  userName: string;
  password: string;
}

interface IcomWlanManagerEvents {
  connected: () => void;
  disconnected: (reason?: string) => void;
  reconnecting: (attempt: number) => void;
  reconnectFailed: (error: Error, attempt: number) => void;
  error: (error: Error) => void;
  audioFrame: (pcm16: Buffer) => void;
}

/**
 * ICOM WLAN 电台管理器
 * 封装 icom-wlan-node 的连接和控制逻辑
 */
export class IcomWlanManager extends EventEmitter<IcomWlanManagerEvents> {
  private logger = ConsoleLogger.getInstance();
  private rig: IcomControl | null = null;
  private currentConfig: IcomWlanConfig | null = null;

  // 连接状态管理
  private isConnecting = false;
  private isReconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = -1; // -1 表示无上限
  private reconnectDelay = 3000; // 固定3秒
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionHealthy = true;
  private lastSuccessfulOperation = Date.now();

  constructor() {
    super();
  }

  /**
   * 连接到 ICOM 电台
   */
  async connect(config: IcomWlanConfig): Promise<void> {
    if (this.rig) {
      await this.disconnect();
    }

    this.currentConfig = config;
    this.isConnecting = true;

    try {
      console.log(`📡 [IcomWlanManager] 连接到 ICOM 电台: ${config.ip}:${config.port}`);

      this.rig = new IcomControl({
        control: { ip: config.ip, port: config.port },
        userName: config.userName,
        password: config.password
      });

      // 设置事件监听器
      this.setupEventListeners();

      // 连接到电台
      await this.rig.connect();

      console.log(`✅ [IcomWlanManager] ICOM 电台连接成功`);

      this.connectionHealthy = true;
      this.lastSuccessfulOperation = Date.now();
      this.reconnectAttempts = 0;
      this.isConnecting = false;

      this.emit('connected');

    } catch (error) {
      this.isConnecting = false;
      this.rig = null;
      console.error(`❌ [IcomWlanManager] ICOM 电台连接失败:`, error);
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect(reason?: string): Promise<void> {
    this.stopReconnection();

    if (this.rig) {
      console.log('🔌 [IcomWlanManager] 正在断开 ICOM 电台连接...');

      try {
        await this.rig.disconnect();
      } catch (error) {
        console.warn('⚠️ [IcomWlanManager] 断开连接时出错:', error);
      }

      this.rig = null;
      this.currentConfig = null;
      console.log('✅ [IcomWlanManager] ICOM 电台连接已断开');

      this.emit('disconnected', reason);
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (!this.rig) return;

    // 登录结果
    this.rig.events.on('login', (res) => {
      if (res.ok) {
        console.log('✅ [IcomWlanManager] ICOM 登录成功');
      } else {
        console.error('❌ [IcomWlanManager] ICOM 登录失败:', res.errorCode);
        this.emit('error', new Error(`ICOM 登录失败: ${res.errorCode}`));
      }
    });

    // 状态信息
    this.rig.events.on('status', (s) => {
      console.log(`📊 [IcomWlanManager] ICOM 状态: CIV端口=${s.civPort}, 音频端口=${s.audioPort}`);
    });

    // 能力信息
    this.rig.events.on('capabilities', (c) => {
      console.log(`📋 [IcomWlanManager] ICOM 能力: CIV地址=${c.civAddress}, 音频名称=${c.audioName}`);
    });

    // 音频数据
    this.rig.events.on('audio', (frame) => {
      // 转发音频数据给适配器
      this.emit('audioFrame', frame.pcm16);
      this.lastSuccessfulOperation = Date.now();
    });

    // 错误处理
    this.rig.events.on('error', (err) => {
      console.error('❌ [IcomWlanManager] ICOM UDP 错误:', err);
      this.handleConnectionLoss(err.message);
    });
  }

  /**
   * 设置频率
   */
  async setFrequency(freq: number): Promise<boolean> {
    if (!this.rig) {
      console.error('❌ [IcomWlanManager] 电台未连接，无法设置频率');
      return false;
    }

    try {
      await this.rig.setFrequency(freq);
      console.log(`🔊 [IcomWlanManager] 频率设置成功: ${(freq / 1000000).toFixed(3)} MHz`);
      this.lastSuccessfulOperation = Date.now();
      return true;
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 设置频率失败:`, error);
      this.handleOperationError(error as Error, '设置频率');
      return false;
    }
  }

  /**
   * 获取当前频率
   */
  async getFrequency(): Promise<number> {
    if (!this.rig) {
      console.error('❌ [IcomWlanManager] 电台未连接，无法获取频率');
      return 0;
    }

    try {
      const freq = await this.rig.readOperatingFrequency({ timeout: 3000 });
      if (freq !== null) {
        this.lastSuccessfulOperation = Date.now();
        return freq;
      }
      throw new Error('获取频率返回 null');
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 获取频率失败:`, error);
      this.handleOperationError(error as Error, '获取频率');
      return 0;
    }
  }

  /**
   * 设置模式
   */
  async setMode(mode: string, dataMode?: boolean): Promise<void> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      // 将模式字符串映射到 ICOM 模式代码
      const modeCode = this.mapModeToIcom(mode);
      await this.rig.setMode(modeCode, { dataMode: dataMode ?? false });
      console.log(`📻 [IcomWlanManager] 模式设置成功: ${mode}${dataMode ? ' (Data)' : ''}`);
      this.lastSuccessfulOperation = Date.now();
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 设置模式失败:`, error);
      this.handleOperationError(error as Error, '设置模式');
      throw error;
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
      const result = await this.rig.readOperatingMode({ timeout: 3000 });
      if (result) {
        this.lastSuccessfulOperation = Date.now();
        return {
          mode: result.modeName || `Mode ${result.mode}`,
          bandwidth: result.filterName || 'Normal'
        };
      }
      throw new Error('获取模式返回 null');
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 获取模式失败:`, error);
      this.handleOperationError(error as Error, '获取模式');
      throw error;
    }
  }

  /**
   * 设置 PTT
   */
  async setPTT(state: boolean): Promise<void> {
    if (!this.rig) {
      console.error('❌ [IcomWlanManager] 电台未连接，无法设置PTT');
      return;
    }

    try {
      console.log(`📡 [IcomWlanManager] PTT ${state ? '启动发射' : '停止发射'}`);
      await this.rig.setPtt(state);
      console.log(`✅ [IcomWlanManager] PTT ${state ? '已启动' : '已停止'}`);
      this.lastSuccessfulOperation = Date.now();
    } catch (error) {
      console.error(`❌ [IcomWlanManager] PTT设置失败:`, error);
      this.handleOperationError(error as Error, 'PTT设置');
    }
  }

  /**
   * 发送音频数据
   */
  async sendAudio(samples: Float32Array): Promise<void> {
    if (!this.rig) {
      throw new Error('电台未连接');
    }

    try {
      this.rig.sendAudioFloat32(samples);
    } catch (error) {
      console.error('❌ [IcomWlanManager] 发送音频失败:', error);
      throw error;
    }
  }

  /**
   * 测试连接
   */
  async testConnection(): Promise<void> {
    if (!this.rig) {
      console.error('❌ [IcomWlanManager] 电台未连接，无法测试');
      return;
    }

    try {
      const freq = await this.rig.readOperatingFrequency({ timeout: 5000 });
      if (freq !== null) {
        console.log(`✅ [IcomWlanManager] 连接测试成功，当前频率: ${(freq / 1000000).toFixed(3)} MHz`);
        this.lastSuccessfulOperation = Date.now();
      } else {
        throw new Error('测试连接失败：无法获取频率');
      }
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 连接测试失败:`, error);
      this.handleOperationError(error as Error, '连接测试');
    }
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return !!this.rig;
  }

  /**
   * 获取重连状态
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
   * 手动重连
   */
  async manualReconnect(): Promise<void> {
    console.log('🔄 [IcomWlanManager] 手动重连请求');

    // 停止自动重连
    this.stopReconnection();

    // 重置计数器
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    this.connectionHealthy = true;

    // 执行重连
    if (this.currentConfig) {
      await this.connect(this.currentConfig);
    } else {
      throw new Error('无法重连：缺少配置信息');
    }
  }

  /**
   * 处理操作错误
   */
  private handleOperationError(error: Error, operation: string): void {
    console.warn(`⚠️ [IcomWlanManager] ${operation}失败:`, error.message);
    this.connectionHealthy = false;

    const errorMsg = error.message.toLowerCase();
    const isCriticalError = errorMsg.includes('timeout') ||
                           errorMsg.includes('connection') ||
                           errorMsg.includes('disconnect');

    if (isCriticalError) {
      console.error(`🚨 [IcomWlanManager] 检测到严重错误，触发重连: ${error.message}`);
      this.handleConnectionLoss();
    }
  }

  /**
   * 处理连接丢失
   */
  private handleConnectionLoss(reason?: string): void {
    if (this.isReconnecting || !this.currentConfig) {
      return;
    }

    console.warn('🔌 [IcomWlanManager] 检测到连接丢失，开始重连流程');

    this.rig = null;
    this.emit('disconnected', reason || '连接丢失');
    this.startReconnection();
  }

  /**
   * 开始重连流程
   */
  private startReconnection(): void {
    if (this.isReconnecting || !this.currentConfig) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts = 0;

    console.log('🔄 [IcomWlanManager] 开始自动重连...');
    this.attemptReconnection();
  }

  /**
   * 尝试重连
   */
  private async attemptReconnection(): Promise<void> {
    if (!this.isReconnecting || !this.currentConfig) {
      this.stopReconnection();
      return;
    }

    this.reconnectAttempts++;
    console.log(`🔄 [IcomWlanManager] 重连尝试 第${this.reconnectAttempts}次`);

    this.emit('reconnecting', this.reconnectAttempts);

    try {
      await this.connect(this.currentConfig);

      console.log('✅ [IcomWlanManager] 重连成功');
      this.isReconnecting = false;
      this.connectionHealthy = true;

    } catch (error) {
      console.warn(`❌ [IcomWlanManager] 重连尝试 ${this.reconnectAttempts} 失败:`, (error as Error).message);
      this.emit('reconnectFailed', error as Error, this.reconnectAttempts);

      // 继续重连
      console.log(`⏳ [IcomWlanManager] ${this.reconnectDelay}ms 后进行下次重连尝试`);

      this.reconnectTimer = setTimeout(() => {
        this.attemptReconnection();
      }, this.reconnectDelay);
    }
  }

  /**
   * 停止重连
   */
  private stopReconnection(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
    console.log('🛑 [IcomWlanManager] 已停止重连流程');
  }

  /**
   * 映射模式字符串到 ICOM 模式代码
   */
  private mapModeToIcom(mode: string): number {
    const modeMap: { [key: string]: number } = {
      'LSB': 0x00,
      'USB': 0x01,
      'AM': 0x02,
      'CW': 0x03,
      'RTTY': 0x04,
      'FM': 0x05,
      'WFM': 0x06,
      'CW-R': 0x07,
      'RTTY-R': 0x08,
      'DV': 0x17,
    };

    const upperMode = mode.toUpperCase();
    return modeMap[upperMode] ?? 0x01; // 默认 USB
  }

  /**
   * 获取音频采样率（ICOM WLAN 固定为 12kHz）
   */
  getAudioSampleRate(): number {
    return AUDIO_RATE; // 12000
  }
}
