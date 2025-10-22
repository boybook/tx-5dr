import { IcomControl, AUDIO_RATE } from 'icom-wlan-node';
import { EventEmitter } from 'eventemitter3';
import { ConsoleLogger } from '../utils/console-logger.js';

export interface IcomWlanConfig {
  ip: string;
  port: number;
  userName: string;
  password: string;
}

interface MeterData {
  swr: { raw: number; swr: number; alert: boolean } | null;
  alc: { raw: number; percent: number; alert: boolean } | null;
  level: { raw: number; percent: number } | null;
  power: { raw: number; percent: number } | null;
}

interface IcomWlanManagerEvents {
  connected: () => void;
  disconnected: (reason?: string) => void;
  reconnecting: (attempt: number) => void;
  reconnectFailed: (error: Error, attempt: number) => void;
  error: (error: Error) => void;
  audioFrame: (pcm16: Buffer) => void;
  meterData: (data: MeterData) => void;
}

/**
 * ICOM WLAN 电台管理器
 * 封装 icom-wlan-node 的连接和控制逻辑
 */
export class IcomWlanManager extends EventEmitter<IcomWlanManagerEvents> {
  private logger = ConsoleLogger.getInstance();
  private rig: IcomControl | null = null;
  private currentConfig: IcomWlanConfig | null = null;
  private isConnecting = false;

  // 数值表轮询相关
  private meterPollingInterval: NodeJS.Timeout | null = null;
  private meterPollingIntervalMs = 300; // 300ms 轮询间隔

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

      // 配置连接监控和自动重连
      this.rig.configureMonitoring({
        timeout: 8000,              // 会话超时 8 秒
        checkInterval: 1000,        // 每秒检查
        autoReconnect: true,        // 启用自动重连
        maxReconnectAttempts: undefined, // 无限重连
        reconnectBaseDelay: 3000,   // 3 秒基础延迟
        reconnectMaxDelay: 30000    // 最大 30 秒
      });

      console.log(`✅ [IcomWlanManager] ICOM 电台连接成功`);
      this.isConnecting = false;

      // 启动数值表轮询
      this.startMeterPolling();

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
    // 停止数值表轮询
    this.stopMeterPolling();

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
    });

    // 连接丢失（库的自动重连会处理）
    this.rig.events.on('connectionLost', (info) => {
      console.warn(`🔌 [IcomWlanManager] 连接丢失: ${info.sessionType}, 空闲 ${info.timeSinceLastData}ms`);
      this.emit('disconnected', `连接丢失: ${info.sessionType}`);
    });

    // 连接恢复
    this.rig.events.on('connectionRestored', (info) => {
      console.log(`✅ [IcomWlanManager] 连接已恢复，停机时间 ${info.downtime}ms`);
      this.emit('connected');
    });

    // 重连尝试
    this.rig.events.on('reconnectAttempting', (info) => {
      console.log(`🔄 [IcomWlanManager] 重连尝试 #${info.attemptNumber}，延迟 ${info.delay}ms`);
      this.emit('reconnecting', info.attemptNumber);
    });

    // 重连失败
    this.rig.events.on('reconnectFailed', (info) => {
      console.error(`❌ [IcomWlanManager] 重连尝试 #${info.attemptNumber} 失败: ${info.error.message}`);
      if (!info.willRetry) {
        console.error('🚨 [IcomWlanManager] 已达到最大重连次数，放弃重连');
      }
      this.emit('reconnectFailed', info.error, info.attemptNumber);
    });

    // 错误处理
    this.rig.events.on('error', (err) => {
      console.error('❌ [IcomWlanManager] ICOM UDP 错误:', err);
      this.emit('error', err);
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
      return true;
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 设置频率失败:`, error);
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
        return freq;
      }
      throw new Error('获取频率返回 null');
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 获取频率失败:`, error);
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
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 设置模式失败:`, error);
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
        return {
          mode: result.modeName || `Mode ${result.mode}`,
          bandwidth: result.filterName || 'Normal'
        };
      }
      throw new Error('获取模式返回 null');
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 获取模式失败:`, error);
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
    } catch (error) {
      console.error(`❌ [IcomWlanManager] PTT设置失败:`, error);
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
      } else {
        throw new Error('测试连接失败：无法获取频率');
      }
    } catch (error) {
      console.error(`❌ [IcomWlanManager] 连接测试失败:`, error);
      throw error;
    }
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    if (!this.rig) return false;
    const phase = this.rig.getConnectionPhase();
    return phase === 'CONNECTED';
  }

  /**
   * 获取连接状态和指标
   */
  getReconnectInfo() {
    if (!this.rig) {
      return {
        isReconnecting: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 0,
        hasReachedMaxAttempts: false,
        connectionHealthy: false,
        nextReconnectDelay: 0,
        phase: 'IDLE',
        uptime: 0
      };
    }

    const metrics = this.rig.getConnectionMetrics();
    const phase = this.rig.getConnectionPhase();

    return {
      isReconnecting: phase === 'RECONNECTING',
      reconnectAttempts: 0, // 库内部管理，暂不暴露
      maxReconnectAttempts: 0, // 配置为无限重连
      hasReachedMaxAttempts: false,
      connectionHealthy: phase === 'CONNECTED',
      nextReconnectDelay: 3000, // 基础延迟
      phase: metrics.phase,
      uptime: metrics.uptime,
      sessions: metrics.sessions
    };
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

  /**
   * 启动数值表轮询
   */
  private startMeterPolling(): void {
    if (this.meterPollingInterval) {
      console.log('⚠️ [IcomWlanManager] 数值表轮询已在运行');
      return;
    }

    console.log(`📊 [IcomWlanManager] 启动数值表轮询，间隔 ${this.meterPollingIntervalMs}ms`);

    this.meterPollingInterval = setInterval(async () => {
      await this.pollMeters();
    }, this.meterPollingIntervalMs);
  }

  /**
   * 停止数值表轮询
   */
  private stopMeterPolling(): void {
    if (this.meterPollingInterval) {
      console.log('🛑 [IcomWlanManager] 停止数值表轮询');
      clearInterval(this.meterPollingInterval);
      this.meterPollingInterval = null;
    }
  }

  /**
   * 轮询数值表数据
   */
  private async pollMeters(): Promise<void> {
    if (!this.rig) return;

    try {
      // 并行读取四个数值表
      const [swr, alc, level, power] = await Promise.all([
        this.rig.readSWR({ timeout: 200 }).catch(() => null),
        this.rig.readALC({ timeout: 200 }).catch(() => null),
        this.rig.getLevelMeter({ timeout: 200 }).catch(() => null),
        this.rig.readPowerLevel({ timeout: 200 }).catch(() => null),
      ]);

      // 发射数值表数据事件
      this.emit('meterData', {
        swr,
        alc,
        level,
        power,
      });
    } catch (error) {
      // 静默失败，避免日志过多
    }
  }
}
