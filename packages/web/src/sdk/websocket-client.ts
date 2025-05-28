import type { SlotPack, ModeDescriptor } from '@tx5dr/contracts';

export interface WebSocketMessage {
  type: string;
  data?: any;
  timestamp: string;
  error?: string;
}

export interface DigitalRadioEngineEvents {
  modeChanged: (mode: ModeDescriptor) => void;
  clockStarted: () => void;
  clockStopped: () => void;
  slotStart: (slotInfo: any) => void;
  subWindow: (windowInfo: any) => void;
  slotPackUpdated: (slotPack: SlotPack) => void;
  decodeError: (errorInfo: any) => void;
  systemStatus: (status: any) => void;
  commandResult: (result: { command: string; success: boolean; error?: string }) => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

export class DigitalRadioWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private eventListeners: Partial<DigitalRadioEngineEvents> = {};
  private isConnecting = false;

  constructor(url: string) {
    this.url = url;
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
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('🔗 WebSocket连接已建立');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.eventListeners.connected?.();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: WebSocketMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('解析WebSocket消息失败:', error);
          }
        };

        this.ws.onclose = (event) => {
          console.log('🔌 WebSocket连接已关闭', event.code, event.reason);
          this.isConnecting = false;
          this.eventListeners.disconnected?.();
          
          // 自动重连
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (error) => {
          console.error('❌ WebSocket错误:', error);
          this.isConnecting = false;
          this.eventListeners.error?.(new Error('WebSocket连接错误'));
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 发送消息到服务器
   */
  send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket未连接，无法发送消息');
    }
  }

  /**
   * 启动数字无线电引擎
   */
  startEngine(): void {
    this.send({ type: 'startEngine' });
  }

  /**
   * 停止数字无线电引擎
   */
  stopEngine(): void {
    this.send({ type: 'stopEngine' });
  }

  /**
   * 获取系统状态
   */
  getStatus(): void {
    this.send({ type: 'getStatus' });
  }

  /**
   * 发送ping消息
   */
  ping(): void {
    this.send({ type: 'ping' });
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
   * 处理接收到的消息
   */
  private handleMessage(message: WebSocketMessage): void {
    console.log('📨 收到WebSocket消息:', message);

    switch (message.type) {
      case 'welcome':
        console.log('🎉 服务器欢迎消息:', message);
        break;

      case 'modeChanged':
        this.eventListeners.modeChanged?.(message.data);
        break;

      case 'clockStarted':
        this.eventListeners.clockStarted?.();
        break;

      case 'clockStopped':
        this.eventListeners.clockStopped?.();
        break;

      case 'slotStart':
        this.eventListeners.slotStart?.(message.data);
        break;

      case 'subWindow':
        this.eventListeners.subWindow?.(message.data);
        break;

      case 'slotPackUpdated':
        this.eventListeners.slotPackUpdated?.(message.data);
        break;

      case 'decodeError':
        this.eventListeners.decodeError?.(message.data);
        break;

      case 'systemStatus':
        this.eventListeners.systemStatus?.(message.data);
        break;

      case 'commandResult':
        this.eventListeners.commandResult?.(message.data);
        break;

      case 'pong':
        console.log('🏓 收到pong响应');
        break;

      case 'error':
        console.error('❌ 服务器错误:', message);
        break;

      default:
        console.log('❓ 未知消息类型:', message);
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`🔄 ${delay}ms后尝试第${this.reconnectAttempts}次重连...`);
    
    setTimeout(() => {
      this.connect().catch((error) => {
        console.error('重连失败:', error);
      });
    }, delay);
  }

  /**
   * 获取连接状态
   */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
} 