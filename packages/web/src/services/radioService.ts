import { api, WSClient } from '@tx5dr/core';
import { addToast } from '@heroui/toast';
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

  constructor() {
    // 创建WebSocket客户端
    const wsUrl = getWebSocketUrl();
    console.log('🔧 RadioService WebSocket URL:', wsUrl);
    this.wsClient = new WSClient({
      url: wsUrl,
      reconnectAttempts: -1, // 无限重连
      reconnectDelay: 1000,
      heartbeatInterval: 30000
    });

    // 监听系统状态变化以更新内部解码状态
    this.wsClient.onWSEvent('systemStatus', (status: any) => {
      this._isDecoding = status.isDecoding || false;
    });

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
      
      // 1.5秒后主动请求状态确认，确保前端状态同步
      setTimeout(() => {
        this.getSystemStatus();
      }, 1500);
    }
  }

  /**
   * 停止解码引擎
   */
  stopDecoding(): void {
    if (this.isConnected) {
      this.wsClient.stopEngine();
      
      // 1.5秒后主动请求状态确认，确保前端状态同步
      setTimeout(() => {
        this.getSystemStatus();
      }, 1500);
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
    const connectionInfo = this.wsClient.connectionInfo;
    return {
      isDecoding: this.isDecoding,
      ...connectionInfo
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
   * 获取底层 WSClient 实例
   * 用于 RadioProvider 和组件直接订阅事件
   */
  get wsClientInstance(): WSClient {
    return this.wsClient;
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
   * 设置音量增益（线性单位）
   */
  setVolumeGain(gain: number): void {
    if (this.isConnected) {
      this.wsClient.send('setVolumeGain', { gain });
    }
  }

  /**
   * 设置音量增益（dB单位）
   */
  setVolumeGainDb(gainDb: number): void {
    if (this.isConnected) {
      this.wsClient.send('setVolumeGainDb', { gainDb });
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

  /**
   * 重置重连计数器
   */
  resetReconnectAttempts(): void {
    this.wsClient.resetReconnectAttempts();
  }
  
  /**
   * 操作员请求呼叫某人
   * @param operatorId 操作员ID
   * @param callsign 呼号
   */
  sendRequestCall(operatorId: string, callsign: string): void {
    if (this.isConnected) {
      this.wsClient.requestCall(operatorId, callsign);
    }
  }

  /**
   * 手动重连电台
   */
  radioManualReconnect(): void {
    if (this.isConnected) {
      console.log('📤 [RadioService] 发送手动重连电台命令');
      this.wsClient.send('radioManualReconnect');
    } else {
      console.warn('⚠️ [RadioService] 未连接到服务器，无法手动重连电台');
    }
  }
}
