import { EventEmitter } from 'eventemitter3';
import type { FT8Frame, DecodeResult } from '@tx5dr/contracts';

export interface WebSocketClientEvents {
  'frame': (frame: FT8Frame, slotId: string) => void;
  'fft': (fftData: Float32Array, timestamp: number) => void;
  'decodeComplete': (result: DecodeResult) => void;
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: Error) => void;
}

/**
 * TX-5DR WebSocket 客户端
 * 处理与服务器的实时数据连接
 */
export class WebSocketClient extends EventEmitter<WebSocketClientEvents> {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private isConnected = false;
  private reconnectTimer: number | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  
  constructor(wsUrl: string) {
    super();
    this.wsUrl = wsUrl;
  }
  
  /**
   * 连接到 WebSocket 服务器
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);
        
        this.ws.onopen = () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit('connected');
          resolve();
        };
        
        this.ws.onclose = () => {
          this.isConnected = false;
          this.emit('disconnected');
          this.scheduleReconnect();
        };
        
        this.ws.onerror = (event) => {
          const error = new Error('WebSocket 连接错误');
          this.emit('error', error);
          if (!this.isConnected) {
            reject(error);
          }
        };
        
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
          } catch (error) {
            this.emit('error', new Error('解析 WebSocket 消息失败'));
          }
        };
        
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  
  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
  }
  
  /**
   * 发送消息到服务器
   */
  send(data: any): void {
    if (this.ws && this.isConnected) {
      this.ws.send(JSON.stringify(data));
    } else {
      throw new Error('WebSocket 未连接');
    }
  }
  
  /**
   * 获取连接状态
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts
    };
  }
  
  /**
   * 处理接收到的消息
   */
  private handleMessage(data: any): void {
    switch (data.type) {
      case 'frame':
        this.emit('frame', data.frame, data.slotId);
        break;
      case 'fft':
        this.emit('fft', new Float32Array(data.fftData), data.timestamp);
        break;
      case 'decodeComplete':
        this.emit('decodeComplete', data.result);
        break;
      default:
        console.warn('未知的 WebSocket 消息类型:', data.type);
    }
  }
  
  /**
   * 调度重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('error', new Error('达到最大重连次数'));
      return;
    }
    
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    
    this.reconnectTimer = window.setTimeout(() => {
      this.connect().catch(() => {
        // 重连失败，会自动调度下次重连
      });
    }, delay);
  }
} 