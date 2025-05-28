import { api, WSClient } from '@tx5dr/core';
import type { SlotPack, DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { getWebSocketUrl } from '../utils/config';

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
  }

  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    try {
      // 首先测试REST API连接
      await api.getHello();
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

    this.wsClient.onWSEvent('connectionError', (error: Error) => {
      console.error('🚨 WebSocket错误:', error);
      this.eventListeners.error?.(error);
    });

    // 监听SlotPack数据更新
    this.wsClient.onWSEvent('slotPackUpdated', (slotPack: SlotPack) => {
      console.log('📦 收到SlotPack数据:', slotPack);
      this.eventListeners.slotPackUpdated?.(slotPack);
    });

    // 监听解码引擎状态变化
    this.wsClient.onWSEvent('clockStarted', () => {
      this._isDecoding = true;
      console.log('🚀 解码引擎已启动');
      this.eventListeners.clockStarted?.();
    });

    this.wsClient.onWSEvent('clockStopped', () => {
      this._isDecoding = false;
      console.log('⏹️ 解码引擎已停止');
      this.eventListeners.clockStopped?.();
    });

    // 监听系统状态
    this.wsClient.onWSEvent('systemStatus', (status: any) => {
      console.log('📊 系统状态更新:', status);
      this.eventListeners.systemStatus?.(status);
    });

    // 监听解码错误
    this.wsClient.onWSEvent('decodeError', (errorInfo: any) => {
      console.warn('⚠️ 解码错误:', errorInfo);
      this.eventListeners.decodeError?.(errorInfo);
    });

    // 监听命令结果
    this.wsClient.onWSEvent('commandResult', (result: any) => {
      this.eventListeners.commandResult?.(result);
    });

    // 监听模式变化
    this.wsClient.onWSEvent('modeChanged', (mode: any) => {
      this.eventListeners.modeChanged?.(mode);
    });

    // 监听其他事件
    this.wsClient.onWSEvent('slotStart', (slotInfo: any) => {
      this.eventListeners.slotStart?.(slotInfo);
    });

    this.wsClient.onWSEvent('subWindow', (windowInfo: any) => {
      this.eventListeners.subWindow?.(windowInfo);
    });

    this.wsClient.onWSEvent('error', (error: any) => {
      this.eventListeners.error?.(new Error(error.message || String(error)));
    });
  }
} 