import { api, WSClient } from '@tx5dr/core';
import type {
  OperatorRuntimeSlot,
  SpectrumKind,
  WSSelectedFrame,
  WSSetOperatorContextMessage,
} from '@tx5dr/contracts';
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

    this.wsClient.onWSEvent('reconnecting', () => {
      this._isDecoding = false;
    });

    this.wsClient.onWSEvent('disconnected', () => {
      this._isDecoding = false;
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
      logger.warn('Auto-connect failed, WSClient reconnect will retry', error);
      // wsClient.connect() 内部已调用 scheduleReconnect()
    }
  }

  /**
   * 连接到服务器
   * @param options.requireHello 为 true 时 REST 健康检查失败会抛异常（用于手动重连诊断）
   */
  async connect(options?: { requireHello?: boolean }): Promise<void> {
    const apiBase = getApiBaseUrl();
    try {
      await api.getHello(apiBase);
      logger.info('REST API connected');
    } catch (error) {
      if (options?.requireHello) {
        throw error;
      }
      logger.warn('REST API health check failed, proceeding with WebSocket connection', error);
    }

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
   * 强制重建连接（用于"重连"按钮 / 认证变化等场景）
   * 会清理任何僵尸状态（pending connectPromise、卡住的 socket）再重新连接。
   */
  async forceReconnect(options?: { requireHello?: boolean }): Promise<void> {
    if (options?.requireHello) {
      const apiBase = getApiBaseUrl();
      await api.getHello(apiBase);
      logger.info('REST API reachable before force reconnect');
    }
    this._isDecoding = false;
    await this.wsClient.forceReconnect();
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

  getPluginRuntimeLogHistory(limit?: number): void {
    if (this.isConnected) {
      this.wsClient.getPluginRuntimeLogHistory(limit);
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
  setOperatorContext(
    operatorId: string,
    context: WSSetOperatorContextMessage['data']['context'],
  ): void {
    if (this.isConnected) {
      logger.info('UI command: setOperatorContext', { operatorId, context });
      this.wsClient.send('setOperatorContext', { operatorId, context });
    }
  }

  /**
   * 设置操作员策略运行时状态
   */
  setOperatorRuntimeState(operatorId: string, state: OperatorRuntimeSlot): void {
    if (this.isConnected) {
      logger.info('UI command: setOperatorRuntimeState', { operatorId, state });
      this.wsClient.send('setOperatorRuntimeState', { operatorId, state });
    }
  }

  /**
   * 设置操作员策略运行时槽位内容
   */
  setOperatorRuntimeSlotContent(operatorId: string, slot: OperatorRuntimeSlot, content: string): void {
    if (this.isConnected) {
      logger.info('UI command: setOperatorRuntimeSlotContent', { operatorId, slot, content });
      this.wsClient.send('setOperatorRuntimeSlotContent', { operatorId, slot, content });
    }
  }

  /**
   * 设置操作员发射周期
   */
  setOperatorTransmitCycles(operatorId: string, transmitCycles: number[]): void {
    if (this.isConnected) {
      logger.info('UI command: setOperatorTransmitCycles', { operatorId, transmitCycles });
      this.wsClient.send('setOperatorTransmitCycles', { operatorId, transmitCycles });
    }
  }

  /**
   * 发送插件自定义用户动作
   */
  sendPluginUserAction(
    pluginName: string,
    actionId: string,
    operatorId?: string,
    payload?: unknown,
  ): void {
    if (this.isConnected) {
      this.wsClient.send('pluginUserAction', { pluginName, actionId, operatorId, payload });
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

  setClientSelectedOperator(selectedOperatorId: string | null): void {
    if (this.isConnected) {
      logger.debug('Setting client selected operator:', selectedOperatorId);
      this.wsClient.setClientSelectedOperator(selectedOperatorId);
    }
  }

  /**
   * 发送握手消息
   */
  sendHandshake(
    enabledOperatorIds: string[] | null,
    selectedOperatorId: string | null,
    clientInstanceId: string,
  ): void {
    if (this.isConnected) {
      logger.debug('Sending handshake:', { enabledOperatorIds, selectedOperatorId, clientInstanceId });
      this.wsClient.sendHandshake(enabledOperatorIds, selectedOperatorId, clientInstanceId);
    }
  }

  /**
   * 操作员请求呼叫某人
   * @param operatorId 操作员ID
   * @param callsign 呼号
   */
  sendRequestCall(operatorId: string, callsign: string, selectedFrame?: WSSelectedFrame): void {
    if (this.isConnected) {
      logger.info('UI command: sendRequestCall', {
        operatorId,
        callsign,
        selectedFrameMessage: selectedFrame?.message ?? null,
      });
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

  /**
   * 立即重试音频 sidecar
   */
  retryAudioNow(): void {
    if (this.isConnected) {
      logger.debug('Sending audio retry-now command');
      this.wsClient.send('audioRetryNow');
    } else {
      logger.warn('Not connected to server, cannot send audio retry-now');
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

  playVoiceKeyer(callsign: string, slotId: string, repeat = false): void {
    if (this.isConnected) {
      this.wsClient.playVoiceKeyer(callsign, slotId, repeat);
    }
  }

  stopVoiceKeyer(): void {
    if (this.isConnected) {
      this.wsClient.stopVoiceKeyer();
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

// Module-level singleton: survives HMR re-mounts so duplicate connections are never created.
let _singleton: RadioService | null = null;

/**
 * Get or create the singleton RadioService instance.
 * Persists across Vite HMR and React Strict Mode re-mounts.
 */
export function getOrCreateRadioService(): RadioService {
  if (!_singleton) {
    _singleton = new RadioService();
  }
  return _singleton;
}

/**
 * Destroy the singleton (only for full app teardown, not HMR).
 */
export function destroyRadioService(): void {
  if (_singleton) {
    _singleton.disconnect();
    _singleton = null;
  }
}
