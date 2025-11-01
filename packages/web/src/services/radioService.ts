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
  private eventListeners: Partial<Record<keyof DigitalRadioEngineEvents, Array<any>>> = {};

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
   * 注册事件监听器
   */
  on<K extends keyof DigitalRadioEngineEvents>(
    event: K,
    listener: DigitalRadioEngineEvents[K]
  ): void {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event]!.push(listener);
  }

  /**
   * 移除事件监听器
   */
  off<K extends keyof DigitalRadioEngineEvents>(event: K, listener?: DigitalRadioEngineEvents[K]): void {
    const listeners = this.eventListeners[event];
    if (!listeners) return;
    
    if (listener) {
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    } else {
      delete this.eventListeners[event];
    }
  }

  /**
   * 设置内部事件监听器，用于维护内部状态
   */
  private setupEventListeners(): void {
    // 监听WebSocket连接状态
    this.wsClient.onWSEvent('connected', () => {
      console.log('✅ WebSocket已连接到TX5DR服务器');
      this.eventListeners.connected?.forEach(listener => listener());
    });

    this.wsClient.onWSEvent('disconnected', () => {
      this._isDecoding = false;
      console.log('❌ WebSocket与TX5DR服务器断开连接');
      this.eventListeners.disconnected?.forEach(listener => listener());
    });

    this.wsClient.onWSEvent('error', (error: Error) => {
      console.error('🚨 WebSocket错误:', error);
      this.eventListeners.error?.forEach(listener => listener(error));
    });

    // 监听发射日志
    this.wsClient.onWSEvent('transmissionLog', (data: any) => {
      console.log('📝 收到发射日志:', data);
      this.eventListeners.transmissionLog?.forEach(listener => listener(data));
    });

    // 监听极简文本消息，直接弹出Toast（标题+正文）
    this.wsClient.onWSEvent('textMessage' as any, (payload: {
      title: string;
      text: string;
      color?: 'success' | 'warning' | 'danger' | 'default';
      timeout?: number | null;
    }) => {
      try {
        const title = payload?.title || '消息';
        const description = payload?.text || '';
        const color = payload?.color;
        const timeout = payload?.timeout;

        console.log(`💬 收到TEXT_MESSAGE消息: ${title} - ${description} (color=${color}, timeout=${timeout})`);

        addToast({
          title,
          description,
          color,
          timeout: timeout === null ? undefined : timeout, // null 表示不自动关闭（传 undefined 给 addToast）
        });
      } catch (e) {
        console.warn('⚠️ 处理TEXT_MESSAGE失败', e);
      }
    });

    // 监听SlotPack数据更新
    this.wsClient.onWSEvent('slotPackUpdated', (slotPack: SlotPack) => {
      console.log('📦 收到SlotPack数据:', slotPack);
      this.eventListeners.slotPackUpdated?.forEach(listener => listener(slotPack));
    });

    // 监听系统状态变化（包含时钟启动/停止状态）
    this.wsClient.onWSEvent('systemStatus', (status: any) => {
      // 更新内部解码状态
      this._isDecoding = status.isDecoding || false;
      
      // 通知所有监听器
      const listeners = this.eventListeners.systemStatus;
      if (listeners && listeners.length > 0) {
        listeners.forEach(listener => listener(status));
      }
    });

    // 监听解码错误
    this.wsClient.onWSEvent('decodeError', (errorInfo: any) => {
      console.warn('⚠️ 解码错误:', errorInfo);
      this.eventListeners.decodeError?.forEach(listener => listener(errorInfo));
    });

    // 监听模式变化
    this.wsClient.onWSEvent('modeChanged', (mode: any) => {
      console.log('🔄 模式变化:', mode);
      if (!mode || !mode.name) {
        console.warn('⚠️ 收到无效的模式数据:', mode);
        return;
      }
      this.eventListeners.modeChanged?.forEach(listener => listener(mode));
    });

    // 监听频率变化（用于清空历史数据并更新UI）
    this.wsClient.onWSEvent('frequencyChanged', (data: any) => {
      console.log('📻 频率变化:', data);
      (this.eventListeners as any).frequencyChanged?.forEach?.((listener: any) => listener(data));
    });

    // 监听PTT状态变化
    this.wsClient.onWSEvent('pttStatusChanged', (data: any) => {
      console.log('📡 PTT状态变化:', data);
      (this.eventListeners as any).pttStatusChanged?.forEach?.((listener: any) => listener(data));
    });

    // 监听电台数值表数据
    this.wsClient.onWSEvent('meterData', (data: any) => {
      // 数值表数据频率较高，不打印日志
      (this.eventListeners as any).meterData?.forEach?.((listener: any) => listener(data));
    });

    // 监听时隙开始事件
    this.wsClient.onWSEvent('slotStart', (slotInfo: SlotInfo, lastSlotPack: SlotPack | null) => {
      console.log('🎯 时隙开始:', slotInfo);
      this.eventListeners.slotStart?.forEach(listener => listener(slotInfo, lastSlotPack));
    });

    // 监听子窗口事件
    this.wsClient.onWSEvent('subWindow', (windowInfo: any) => {
      console.log('🔍 子窗口:', windowInfo);
      this.eventListeners.subWindow?.forEach(listener => listener(windowInfo));
    });

    // 监听频谱数据
    this.wsClient.onWSEvent('spectrumData', (spectrumData: any) => {
      // console.log('📊 频谱数据:', spectrumData);
      this.eventListeners.spectrumData?.forEach(listener => listener(spectrumData));
    });

    // 监听操作员列表
    this.wsClient.onWSEvent('operatorsList', (data: any) => {
      // console.log('📻 操作员列表:', data);
      this.eventListeners.operatorsList?.forEach(listener => listener(data));
    });

    // 监听操作员状态更新
    this.wsClient.onWSEvent('operatorStatusUpdate', (operatorStatus: any) => {
      // console.log('📻 操作员状态更新:', operatorStatus);
      this.eventListeners.operatorStatusUpdate?.forEach(listener => listener(operatorStatus));
    });

    // 监听音量变化事件
    this.wsClient.onWSEvent('volumeGainChanged', (data: number | { gain: number; gainDb: number }) => {
      console.log('🔊 音量变化:', data);
      this.eventListeners.volumeGainChanged?.forEach(listener => listener(data as any));
    });

    // 监听重连状态变化
    this.wsClient.onWSEvent('reconnecting' as any, (reconnectInfo: any) => {
      console.log('🔄 正在重连:', reconnectInfo);
      (this.eventListeners as any).reconnecting?.forEach?.((listener: any) => listener(reconnectInfo));
    });

    this.wsClient.onWSEvent('reconnectStopped' as any, (stopInfo: any) => {
      console.log('⏹️ 重连已停止:', stopInfo);
      (this.eventListeners as any).reconnectStopped?.forEach?.((listener: any) => listener(stopInfo));
    });

    // 监听电台状态变化事件
    this.wsClient.onWSEvent('radioStatusChanged' as any, (data: any) => {
      console.log('📡 电台状态变化:', data);
      (this.eventListeners as any).radioStatusChanged?.forEach?.((listener: any) => listener(data));
    });

    // 监听电台重连中事件
    this.wsClient.onWSEvent('radioReconnecting' as any, (data: any) => {
      console.log('🔄 电台重连中:', data);
      (this.eventListeners as any).radioReconnecting?.forEach?.((listener: any) => listener(data));
    });

    // 监听电台重连失败事件
    this.wsClient.onWSEvent('radioReconnectFailed' as any, (data: any) => {
      console.log('❌ 电台重连失败:', data);
      (this.eventListeners as any).radioReconnectFailed?.forEach?.((listener: any) => listener(data));
    });

    // 监听电台重连停止事件
    this.wsClient.onWSEvent('radioReconnectStopped' as any, (data: any) => {
      console.log('⏹️ 电台重连已停止:', data);
      (this.eventListeners as any).radioReconnectStopped?.forEach?.((listener: any) => listener(data));
    });

    // 监听电台错误事件
    this.wsClient.onWSEvent('radioError' as any, (data: any) => {
      console.log('⚠️ 电台错误:', data);
      (this.eventListeners as any).radioError?.forEach?.((listener: any) => listener(data));
    });

    // 监听电台发射中断开连接事件
    this.wsClient.onWSEvent('radioDisconnectedDuringTransmission' as any, (data: any) => {
      console.warn('🚨 电台在发射过程中断开连接:', data);
      (this.eventListeners as any).radioDisconnectedDuringTransmission?.forEach?.((listener: any) => listener(data));
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
