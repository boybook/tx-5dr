import { WSMessageType, ModeDescriptor, type SpectrumKind, type SpectrumZoomDirection } from '@tx5dr/contracts';
import { WSMessageHandler } from './WSMessageHandler.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WSClient');

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
  private jwt: string | null = null;

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
          logger.info('Connected');
          this.isConnecting = false;
          this.startHeartbeat();
          this.emitWSEvent('connected');
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleRawMessage(event.data);
        };

        this.ws.onclose = (event) => {
          logger.info(`Disconnected: code=${event.code} reason=${event.reason}`);
          this.isConnecting = false;
          this.stopHeartbeat();
          this.emitWSEvent('disconnected');
        };

        this.ws.onerror = (error) => {
          logger.error('Connection error:', error);
          this.isConnecting = false;
          this.emitWSEvent('error', new Error('WebSocket connection error'));
          reject(new Error('WebSocket connection failed'));
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
      logger.warn('Not connected, cannot send message');
    }
  }

  /**
   * 启动数字无线电引擎
   */
  startEngine(): void {
    logger.debug('Sending startEngine command');
    this.send(WSMessageType.START_ENGINE);
  }

  /**
   * 停止数字无线电引擎
   */
  stopEngine(): void {
    logger.debug('Sending stopEngine command');
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

  subscribeSpectrum(kind: SpectrumKind | null): void {
    this.send(WSMessageType.SUBSCRIBE_SPECTRUM, { kind });
  }

  stepSpectrumZoom(direction: SpectrumZoomDirection): void {
    this.send(WSMessageType.STEP_SPECTRUM_ZOOM, { direction });
  }

  /**
   * 强制停止发射
   * 立即停止PTT并清空音频播放队列
   */
  forceStopTransmission(): void {
    logger.debug('Sending forceStopTransmission command');
    this.send(WSMessageType.FORCE_STOP_TRANSMISSION);
  }

  /**
   * 从当前发射中移除单个操作员
   * 如果还有其他操作员在发射，重混音继续；否则停止PTT
   */
  removeOperatorFromTransmission(operatorId: string): void {
    logger.debug('Sending removeOperatorFromTransmission command', { operatorId });
    this.send(WSMessageType.REMOVE_OPERATOR_FROM_TRANSMISSION, { operatorId });
  }

  /**
   * 停止自动重连
   */
  stopReconnect(): void {
    logger.info('Sending stopReconnect command');
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
    logger.debug('Setting client enabled operators:', enabledOperatorIds);
    this.send('setClientEnabledOperators', { enabledOperatorIds });
  }

  /**
   * 发送客户端握手消息
   */
  sendHandshake(enabledOperatorIds: string[] | null, clientInstanceId: string): void {
    logger.info('Sending handshake:', { enabledOperatorIds, clientInstanceId });
    this.send('clientHandshake', {
      enabledOperatorIds,
      clientInstanceId,
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

  // ===== 认证相关方法 =====

  /**
   * 设置 JWT（登录成功后调用，下次连接/重连时自动发送）
   */
  setAuthToken(jwt: string | null): void {
    this.jwt = jwt;
  }

  /**
   * 获取当前 JWT
   */
  getAuthToken(): string | null {
    return this.jwt;
  }

  /**
   * 发送 JWT 进行认证（登录或在线权限升级）
   */
  sendAuthToken(jwt: string): void {
    this.send(WSMessageType.AUTH_TOKEN, { jwt });
  }

  /**
   * 请求以公开观察者模式接入（无需 Token）
   */
  sendAuthPublicViewer(): void {
    this.send(WSMessageType.AUTH_PUBLIC_VIEWER);
  }

  // ===== 语音模式命令 =====

  /**
   * 请求语音 PTT 锁
   * @param voiceAudioClientId - Voice audio WS client ID to associate with this PTT session
   */
  requestVoicePTT(voiceAudioClientId?: string): void {
    this.send(WSMessageType.VOICE_PTT_REQUEST, voiceAudioClientId ? { voiceAudioClientId } : undefined);
  }

  /**
   * 释放语音 PTT 锁
   */
  releaseVoicePTT(): void {
    this.send(WSMessageType.VOICE_PTT_RELEASE);
  }

  /**
   * 设置电台调制模式（语音模式下使用，如 USB/LSB/FM/AM）
   */
  setVoiceRadioMode(radioMode: string): void {
    this.send(WSMessageType.VOICE_SET_RADIO_MODE, { radioMode });
  }
} 
