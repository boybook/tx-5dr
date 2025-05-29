import { WSMessageType } from '@tx5dr/contracts';
import { WSMessageHandler } from './WSMessageHandler.js';

/**
 * WebSocket客户端配置
 */
export interface WSClientConfig {
  url: string;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  heartbeatInterval?: number;
}

/**
 * WebSocket客户端
 * 提供统一的WebSocket连接管理和消息处理
 */
export class WSClient extends WSMessageHandler {
  private ws: WebSocket | null = null;
  private config: Required<WSClientConfig>;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: WSClientConfig) {
    super();
    
    this.config = {
      url: config.url,
      reconnectAttempts: config.reconnectAttempts ?? 5,
      reconnectDelay: config.reconnectDelay ?? 1000,
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
          this.reconnectAttempts = 0;
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
          
          // 自动重连
          if (this.reconnectAttempts < this.config.reconnectAttempts) {
            this.scheduleReconnect();
          }
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
    this.stopReconnect();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 发送消息到服务器
   */
  send(type: string, data?: any, id?: string): void {
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
  setMode(mode: any): void {
    this.send(WSMessageType.SET_MODE, { mode });
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
   * 安排重连
   */
  private scheduleReconnect(): void {
    this.stopReconnect();
    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`🔄 ${delay}ms后尝试第${this.reconnectAttempts}次重连...`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('重连失败:', error);
      });
    }, delay);
  }

  /**
   * 停止重连
   */
  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 获取连接状态
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * 销毁客户端
   */
  destroy(): void {
    this.disconnect();
    this.removeAllListeners();
  }
} 