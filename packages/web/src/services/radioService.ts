import { api, WSClient } from '@tx5dr/core';
import { getWebSocketUrl, getApiBaseUrl } from '../utils/config';
import type { 
  DigitalRadioEngineEvents, 
  SlotPack, 
  SlotInfo 
} from '@tx5dr/contracts';

/**
 * 无线电数据服务
 * 专注于WebSocket连接和实时数据流管理
 * 直接暴露WebSocket客户端的事件接口，不做额外抽象
 */
export class RadioService {
  private wsClient: WSClient;
  private _isDecoding = false;
  private eventListeners: Partial<DigitalRadioEngineEvents> = {};

  constructor() {
    // 创建WebSocket客户端
    const wsUrl = getWebSocketUrl();
    console.log('🔧 RadioService WebSocket URL:', wsUrl);
    this.wsClient = new WSClient({
      url: wsUrl,
      reconnectAttempts: 5,
      reconnectDelay: 1000,
      heartbeatInterval: 30000
    });
    this.setupEventListeners();
    
    // 自动尝试连接
    this.autoConnect();
  }

  /**
   * 自动连接到服务器
   */
  private async autoConnect(): Promise<void> {
    try {
      console.log('🚀 RadioService 自动连接中...');
      await this.connect();
      console.log('✅ RadioService 自动连接成功');
    } catch (error) {
      console.warn('⚠️ RadioService 自动连接失败，将通过重连机制重试:', error);
      // 不抛出错误，让WebSocket的自动重连机制处理
    }
  }

  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    try {
      // 首先测试REST API连接
      const apiBase = getApiBaseUrl();
      await api.getHello(apiBase);
      console.log('✅ REST API连接成功');
      
      // 然后建立WebSocket连接
      await this.wsClient.connect();
      
    } catch (error) {
      throw error;
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.wsClient.disconnect();
    this._isDecoding = false;
  }

  /**
   * 启动解码引擎
   */
  startDecoding(): void {
    if (this.isConnected) {
      this.wsClient.startEngine();
    }
  }

  /**
   * 停止解码引擎
   */
  stopDecoding(): void {
    if (this.isConnected) {
      this.wsClient.stopEngine();
    }
  }

  /**
   * 获取系统状态
   */
  getSystemStatus(): void {
    if (this.isConnected) {
      this.wsClient.getStatus();
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      isDecoding: this.isDecoding
    };
  }

  /**
   * 获取实时连接状态（基于WebSocket状态）
   */
  get isConnected(): boolean {
    return this.wsClient.isConnected;
  }

  /**
   * 获取实时解码状态
   */
  get isDecoding(): boolean {
    return this._isDecoding;
  }

  /**
   * 注册事件监听器
   */
  on<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener: DigitalRadioEngineEvents[K]
  ): void {
    this.eventListeners[event] = listener;
  }

  /**
   * 移除事件监听器
   */
  off<K extends keyof DigitalRadioEngineEvents>(event: K): void {
    delete this.eventListeners[event];
  }

  /**
   * 设置内部事件监听器，用于维护内部状态
   */
  private setupEventListeners(): void {
    // 监听WebSocket连接状态
    this.wsClient.onWSEvent('connected', () => {
      console.log('✅ WebSocket已连接到TX5DR服务器');
      this.eventListeners.connected?.();
    });

    this.wsClient.onWSEvent('disconnected', () => {
      this._isDecoding = false;
      console.log('❌ WebSocket与TX5DR服务器断开连接');
      this.eventListeners.disconnected?.();
    });

    this.wsClient.onWSEvent('error', (error: Error) => {
      console.error('🚨 WebSocket错误:', error);
      this.eventListeners.error?.(error);
    });

    // 监听发射日志
    this.wsClient.onWSEvent('transmissionLog', (data: any) => {
      console.log('📝 收到发射日志:', data);
      this.eventListeners.transmissionLog?.(data);
    });

    // 监听SlotPack数据更新
    this.wsClient.onWSEvent('slotPackUpdated', (slotPack: SlotPack) => {
      console.log('📦 收到SlotPack数据:', slotPack);
      this.eventListeners.slotPackUpdated?.(slotPack);
    });

    // 监听系统状态变化（包含时钟启动/停止状态）
    this.wsClient.onWSEvent('systemStatus', (status: any) => {
      console.log('📊 系统状态更新:', status);
      
      // 更新内部解码状态
      this._isDecoding = status.isDecoding || false;
      
      this.eventListeners.systemStatus?.(status);
    });

    // 监听解码错误
    this.wsClient.onWSEvent('decodeError', (errorInfo: any) => {
      console.warn('⚠️ 解码错误:', errorInfo);
      this.eventListeners.decodeError?.(errorInfo);
    });

    // 监听模式变化
    this.wsClient.onWSEvent('modeChanged', (mode: any) => {
      console.log('🔄 模式变化:', mode);
      if (!mode || !mode.name) {
        console.warn('⚠️ 收到无效的模式数据:', mode);
        return;
      }
      this.eventListeners.modeChanged?.(mode);
    });

    // 监听时隙开始事件
    this.wsClient.onWSEvent('slotStart', (slotInfo: SlotInfo, lastSlotPack: SlotPack | null) => {
      console.log('🎯 时隙开始:', slotInfo);
      this.eventListeners.slotStart?.(slotInfo, lastSlotPack);
    });

    // 监听子窗口事件
    this.wsClient.onWSEvent('subWindow', (windowInfo: any) => {
      console.log('🔍 子窗口:', windowInfo);
      this.eventListeners.subWindow?.(windowInfo);
    });

    // 监听频谱数据
    this.wsClient.onWSEvent('spectrumData', (spectrumData: any) => {
      // console.log('📊 频谱数据:', spectrumData);
      this.eventListeners.spectrumData?.(spectrumData);
    });

    // 监听操作员列表
    this.wsClient.onWSEvent('operatorsList', (data: any) => {
      // console.log('📻 操作员列表:', data);
      this.eventListeners.operatorsList?.(data);
    });

    // 监听操作员状态更新
    this.wsClient.onWSEvent('operatorStatusUpdate', (operatorStatus: any) => {
      // console.log('📻 操作员状态更新:', operatorStatus);
      this.eventListeners.operatorStatusUpdate?.(operatorStatus);
    });

    // 监听音量变化事件
    this.wsClient.onWSEvent('volumeGainChanged', (gain: number) => {
      console.log('🔊 音量变化:', gain);
      this.eventListeners.volumeGainChanged?.(gain);
    });
  }

  /**
   * 获取操作员列表
   */
  getOperators(): void {
    console.log('📤 [RadioService] getOperators 调用，isConnected:', this.isConnected);
    if (this.isConnected) {
      console.log('📤 [RadioService] 发送 getOperators 消息');
      this.wsClient.send('getOperators');
    } else {
      console.warn('⚠️ [RadioService] 未连接，无法获取操作员列表');
    }
  }

  /**
   * 设置操作员上下文
   */
  setOperatorContext(operatorId: string, context: any): void {
    if (this.isConnected) {
      this.wsClient.send('setOperatorContext', { operatorId, context });
    }
  }

  /**
   * 设置操作员时隙
   */
  setOperatorSlot(operatorId: string, slot: string): void {
    if (this.isConnected) {
      this.wsClient.send('setOperatorSlot', { operatorId, slot });
    }
  }

  /**
   * 发送用户命令到操作员
   */
  sendUserCommand(operatorId: string, command: string, args: any): void {
    if (this.isConnected) {
      this.wsClient.send('userCommand', { operatorId, command, args });
    }
  }
  
  /**
   * 启动操作员发射
   */
  startOperator(operatorId: string): void {
    if (this.isConnected) {
      this.wsClient.send('startOperator', { operatorId });
    }
  }

  /**
   * 停止操作员发射
   */
  stopOperator(operatorId: string): void {
    if (this.isConnected) {
      this.wsClient.send('stopOperator', { operatorId });
    }
  }

  /**
   * 设置音量增益
   */
  setVolumeGain(gain: number): void {
    if (this.isConnected) {
      this.wsClient.send('setVolumeGain', { gain });
    }
  }

  /**
   * 设置客户端启用的操作员列表
   */
  setClientEnabledOperators(enabledOperatorIds: string[]): void {
    if (this.isConnected) {
      console.log('📤 [RadioService] 设置客户端启用操作员:', enabledOperatorIds);
      this.wsClient.send('setClientEnabledOperators', { enabledOperatorIds });
    }
  }

  /**
   * 发送握手消息
   */
  sendHandshake(enabledOperatorIds: string[] | null): void {
    if (this.isConnected) {
      console.log('🤝 [RadioService] 发送握手消息:', { enabledOperatorIds });
      this.wsClient.send('clientHandshake', {
        enabledOperatorIds,
        clientVersion: '1.0.0',
        clientCapabilities: ['operatorFiltering', 'handshakeProtocol']
      });
    }
  }
}