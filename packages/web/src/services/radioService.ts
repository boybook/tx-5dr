import { api, WSClient } from '@tx5dr/core';
import type { SpectrumKind, WSSelectedFrame } from '@tx5dr/contracts';
import { getApiBaseUrl, getWebSocketUrl } from '../utils/config';
import { createLogger } from '../utils/logger';

const logger = createLogger('RadioService');

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
    logger.info('WebSocket URL:', wsUrl);
    this.wsClient = new WSClient({
      url: wsUrl,
      heartbeatInterval: 30000
    });

    // 监听系统状态变化以更新内部解码状态
    this.wsClient.onWSEvent('systemStatus', (status: unknown) => {
      const systemStatus = status as { isDecoding?: boolean };
      this._isDecoding = systemStatus.isDecoding || false;
    });

    // 自动尝试连接
    this.autoConnect();
  }

  /**
   * 自动连接到服务器
   */
  private async autoConnect(): Promise<void> {
    try {
      logger.info('Auto-connecting...');
      await this.connect();
      logger.info('Auto-connect succeeded');
    } catch (error) {
      logger.warn('Auto-connect failed, will retry via reconnect mechanism:', error);
      // 不抛出错误，让WebSocket的自动重连机制处理
    }
  }

  /**
   * 连接到服务器
   */
  async connect(): Promise<void> {
    // 首先测试REST API连接
    const apiBase = getApiBaseUrl();
    await api.getHello(apiBase);
    logger.info('REST API connected');

    // 然后建立WebSocket连接
    await this.wsClient.connect();
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

  subscribeSpectrum(kind: SpectrumKind | null): void {
    if (this.isConnected) {
      this.wsClient.subscribeSpectrum(kind);
    }
  }

  invokeSpectrumControl(id: string, action: 'in' | 'out' | 'toggle'): void {
    if (this.isConnected) {
      this.wsClient.invokeSpectrumControl(id, action);
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
    logger.debug('getOperators called, isConnected:', this.isConnected);
    if (this.isConnected) {
      logger.debug('Sending getOperators');
      this.wsClient.send('getOperators');
    } else {
      logger.warn('Not connected, cannot get operator list');
    }
  }

  /**
   * 设置操作员上下文
   */
  setOperatorContext(operatorId: string, context: Record<string, unknown>): void {
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
  sendUserCommand(operatorId: string, command: string, args: Record<string, unknown> | string): void {
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
   * 强制停止发射
   * 立即停止PTT并清空音频播放队列
   */
  forceStopTransmission(): void {
    if (this.isConnected) {
      this.wsClient.forceStopTransmission();
    }
  }

  /**
   * 从当前发射中移除单个操作员的音频
   */
  removeOperatorFromTransmission(operatorId: string): void {
    if (this.isConnected) {
      this.wsClient.removeOperatorFromTransmission(operatorId);
    }
  }

  /**
   * 停止自动重连
   */
  stopReconnect(): void {
    if (this.isConnected) {
      this.wsClient.stopReconnect();
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
      logger.debug('Setting client enabled operators:', enabledOperatorIds);
      this.wsClient.send('setClientEnabledOperators', { enabledOperatorIds });
    }
  }

  /**
   * 发送握手消息
   */
  sendHandshake(enabledOperatorIds: string[] | null, clientInstanceId: string): void {
    if (this.isConnected) {
      logger.debug('Sending handshake:', { enabledOperatorIds, clientInstanceId });
      this.wsClient.send('clientHandshake', {
        enabledOperatorIds,
        clientInstanceId,
        clientVersion: '1.0.0',
        clientCapabilities: ['operatorFiltering', 'handshakeProtocol']
      });
    }
  }

  /**
   * 操作员请求呼叫某人
   * @param operatorId 操作员ID
   * @param callsign 呼号
   */
  sendRequestCall(operatorId: string, callsign: string, selectedFrame?: WSSelectedFrame): void {
    if (this.isConnected) {
      this.wsClient.requestCall(operatorId, callsign, selectedFrame);
    }
  }

  /**
   * 手动重连电台
   */
  radioManualReconnect(): void {
    if (this.isConnected) {
      logger.debug('Sending radio manual reconnect command');
      this.wsClient.send('radioManualReconnect');
    } else {
      logger.warn('Not connected to server, cannot send radio manual reconnect');
    }
  }

  // ===== Voice Mode Methods =====

  /**
   * 请求语音 PTT 锁
   */
  requestVoicePTT(participantIdentity?: string): void {
    if (this.isConnected) {
      this.wsClient.requestVoicePTT(participantIdentity);
    }
  }

  /**
   * 释放语音 PTT 锁
   */
  releaseVoicePTT(): void {
    if (this.isConnected) {
      this.wsClient.releaseVoicePTT();
    }
  }

  /**
   * 设置电台调制模式（语音模式使用，如 USB/LSB/FM/AM）
   */
  setVoiceRadioMode(radioMode: string): void {
    if (this.isConnected) {
      this.wsClient.setVoiceRadioMode(radioMode);
    }
  }

}
