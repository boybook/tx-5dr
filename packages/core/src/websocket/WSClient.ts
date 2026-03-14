import { WSMessageType, ModeDescriptor } from '@tx5dr/contracts';
import { WSMessageHandler } from './WSMessageHandler.js';

/**
 * WebSocket客户端配置
 */
export interface WSClientConfig {
  url: string;
  heartbeatInterval?: number;
}

/**
 * WebSocket客户端
 * 提供统一的WebSocket连接管理和消息处理
 */
export class WSClient extends WSMessageHandler {
  private ws: WebSocket | null = null;
  private config: Required<WSClientConfig>;
  private isConnecting = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(config: WSClientConfig) {
    super();

    this.config = {
      url: config.url,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
    };
  }

  /**
   * 连接到WebSocket服务器
   */
  async connect(): Promise<void> {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.onopen = () => {
          console.log('🔗 WebSocket连接已建立');
          this.isConnecting = false;
          this.startHeartbeat();
          this.emitWSEvent('connected');
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleRawMessage(event.data);
        };

        this.ws.onclose = (event) => {
          console.log('🔌 WebSocket连接已关闭', event.code, event.reason);
          this.isConnecting = false;
          this.stopHeartbeat();
          this.emitWSEvent('disconnected');
        };

        this.ws.onerror = (error) => {
          console.error('❌ WebSocket错误:', error);
          this.isConnecting = false;
          this.emitWSEvent('error', new Error('WebSocket连接错误'));
          reject(new Error('WebSocket连接失败'));
        };

      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * 断开WebSocket连接
   */
  disconnect(): void {
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 发送消息到服务器
   */
  send(type: string, data?: unknown, id?: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const messageStr = this.createAndSerializeMessage(type, data, id);
      this.ws.send(messageStr);
    } else {
      console.warn('WebSocket未连接，无法发送消息');
    }
  }

  /**
   * 启动数字无线电引擎
   */
  startEngine(): void {
    console.log('📤 WSClient.startEngine() - 发送startEngine命令');
    this.send(WSMessageType.START_ENGINE);
  }

  /**
   * 停止数字无线电引擎
   */
  stopEngine(): void {
    console.log('📤 WSClient.stopEngine() - 发送stopEngine命令');
    this.send(WSMessageType.STOP_ENGINE);
  }

  /**
   * 获取系统状态
   */
  getStatus(): void {
    this.send(WSMessageType.GET_STATUS);
  }

  /**
   * 设置模式
   */
  setMode(mode: ModeDescriptor): void {
    this.send(WSMessageType.SET_MODE, { mode });
  }

  /**
   * 强制停止发射
   * 立即停止PTT并清空音频播放队列
   */
  forceStopTransmission(): void {
    console.log('📤 WSClient.forceStopTransmission() - 发送强制停止发射命令');
    this.send(WSMessageType.FORCE_STOP_TRANSMISSION);
  }

  /**
   * 停止自动重连
   */
  stopReconnect(): void {
    console.log('📤 WSClient.stopReconnect() - 发送停止重连命令');
    this.send(WSMessageType.RADIO_STOP_RECONNECT);
  }

  /**
   * 发送ping消息
   */
  ping(): void {
    this.send('ping');
  }

  /**
   * 开始心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.ping();
    }, this.config.heartbeatInterval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }


  /**
   * 获取连接状态
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 获取是否正在连接
   */
  get connecting(): boolean {
    return this.isConnecting;
  }

  /**
   * 获取连接状态信息
   */
  get connectionInfo() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.connecting,
    };
  }

  /**
   * 销毁客户端
   */
  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }


  /**
   * 设置音量增益
   */
  setVolumeGain(gain: number): void {
    this.send('setVolumeGain', { gain });
  }

  /**
   * 设置客户端启用的操作员列表
   */
  setClientEnabledOperators(enabledOperatorIds: string[]): void {
    console.log('📤 [WSClient] 设置客户端启用操作员:', enabledOperatorIds);
    this.send('setClientEnabledOperators', { enabledOperatorIds });
  }

  /**
   * 发送客户端握手消息
   */
  sendHandshake(enabledOperatorIds: string[] | null): void {
    console.log('🤝 [WSClient] 发送握手消息:', { enabledOperatorIds });
    this.send('clientHandshake', {
      enabledOperatorIds,
      clientVersion: '1.0.0',
      clientCapabilities: ['operatorFiltering', 'handshakeProtocol']
    });
  }

  /**
   * 操作员请求呼叫某人
   */
  requestCall(operatorId: string, callsign: string): void {
    this.send(WSMessageType.OPERATOR_REQUEST_CALL, { operatorId, callsign });
  }
} 
