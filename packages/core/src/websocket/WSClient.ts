import { WSMessageType } from '@tx5dr/contracts';
import { WSMessageHandler } from './WSMessageHandler.js';

/**
 * WebSocket客户端配置
 */
export interface WSClientConfig {
  url: string;
  reconnectAttempts?: number; // 设置为 -1 表示无限重连
  reconnectDelay?: number;
  heartbeatInterval?: number;
  maxReconnectDelay?: number; // 最大重连延迟，避免延迟过长
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
      reconnectAttempts: config.reconnectAttempts ?? -1, // 默认无限重连
      reconnectDelay: config.reconnectDelay ?? 1000,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      maxReconnectDelay: config.maxReconnectDelay ?? 30000, // 最大30秒延迟
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
          
          // 自动重连 (-1 表示无限重连)
          if (this.config.reconnectAttempts === -1 || this.reconnectAttempts < this.config.reconnectAttempts) {
            this.scheduleReconnect();
          } else {
            console.log('🛑 已达到最大重连次数，停止重连');
            this.emitWSEvent('reconnectStopped' as any, {
              reason: 'maxAttemptsReached',
              finalAttempt: this.reconnectAttempts
            });
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
    
         // 计算延迟：指数退避，但限制最大延迟
     const exponentialDelay = this.config.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 6)); // 最多2^6倍延迟
     const delay = Math.min(exponentialDelay, this.config.maxReconnectDelay || 30000);
    
    const isInfiniteReconnect = this.config.reconnectAttempts === -1;
    console.log(`🔄 ${delay}ms后尝试第${this.reconnectAttempts}次重连${isInfiniteReconnect ? ' (无限重连模式)' : ''}...`);
    
    // 发射重连开始事件
    this.emitWSEvent('reconnecting' as any, {
      attempt: this.reconnectAttempts,
      maxAttempts: this.config.reconnectAttempts,
      delay,
      nextAttemptAt: Date.now() + delay
    });
    
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error('重连失败:', error);
        
        // 如果不是无限重连且达到最大重连次数，发射重连停止事件
        if (this.config.reconnectAttempts !== -1 && this.reconnectAttempts >= this.config.reconnectAttempts) {
          this.emitWSEvent('reconnectStopped' as any, {
            reason: 'maxAttemptsReached',
            finalAttempt: this.reconnectAttempts
          });
        }
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
   * 重置重连计数器，用于手动重试
   */
  resetReconnectAttempts(): void {
    console.log('🔄 重置重连计数器');
    this.reconnectAttempts = 0;
    this.stopReconnect();
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
   * 获取是否正在重连
   */
  get isReconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  /**
   * 获取当前重连尝试次数
   */
  get currentReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * 获取最大重连尝试次数
   */
  get maxReconnectAttempts(): number {
    return this.config.reconnectAttempts;
  }

  /**
   * 获取连接状态信息
   */
  get connectionInfo() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.connecting,
      isReconnecting: this.isReconnecting,
      reconnectAttempts: this.currentReconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      hasReachedMaxAttempts: this.config.reconnectAttempts !== -1 && this.currentReconnectAttempts >= this.maxReconnectAttempts
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
   * 处理原始WebSocket消息
   */
  public handleRawMessage(messageStr: string): void {
    try {
      const message = JSON.parse(messageStr);
      
      // 发射原始消息事件
      this.emitRawMessage(message);
      
      // 根据消息类型处理
      switch (message.type) {
        case WSMessageType.PONG:
          // 不发射 pong 事件，因为它不是 DigitalRadioEngineEvents 的一部分
          break;
          
        case WSMessageType.ERROR:
          this.emitWSEvent('error', new Error(message.data?.message || '未知错误'));
          break;
          
        case WSMessageType.MODE_CHANGED:
          this.emitWSEvent('modeChanged', message.data);
          break;
          
        case WSMessageType.SLOT_START:
          // 从 SlotPackManager 获取最新的 SlotPack
          this.emitWSEvent('slotStart', message.data, null);
          break;
          
        case WSMessageType.SUB_WINDOW:
          this.emitWSEvent('subWindow', message.data);
          break;
          
        case WSMessageType.SLOT_PACK_UPDATED:
          this.emitWSEvent('slotPackUpdated', message.data);
          break;
          
        case WSMessageType.SPECTRUM_DATA:
          this.emitWSEvent('spectrumData', message.data);
          break;
          
        case WSMessageType.DECODE_ERROR:
          this.emitWSEvent('decodeError', message.data);
          break;
          
        case WSMessageType.SYSTEM_STATUS:
          this.emitWSEvent('systemStatus', message.data);
          break;
          
        case WSMessageType.OPERATORS_LIST:
          this.emitWSEvent('operatorsList', message.data);
          break;
          
        case WSMessageType.OPERATOR_STATUS_UPDATE:
          this.emitWSEvent('operatorStatusUpdate', message.data);
          break;

        case WSMessageType.TRANSMISSION_LOG:
          console.log('📝 [WSClient] 收到发射日志:', message.data);
          this.emitWSEvent('transmissionLog', message.data);
          break;

        case WSMessageType.VOLUME_GAIN_CHANGED:
          console.log('🔊 [WSClient] 收到音量变化:', message.data.gain);
          this.emitWSEvent('volumeGainChanged', message.data.gain);
          break;

        case 'serverHandshakeComplete':
          console.log('🤝 [WSClient] 服务器握手完成:', message.data);
          this.emitWSEvent('handshakeComplete' as any, message.data);
          break;
      }
    } catch (error) {
      console.error('❌ 处理WebSocket消息失败:', error);
      this.emitWSEvent('error', error instanceof Error ? error : new Error('消息处理失败'));
    }
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