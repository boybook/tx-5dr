import { WSMessageType, ModeDescriptor, type SpectrumKind, type WSSelectedFrame } from '@tx5dr/contracts';
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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private manualDisconnect = false;
  private connectPromise: Promise<void> | null = null;

  private static readonly RECONNECT_BASE_DELAY_MS = 1000;
  private static readonly RECONNECT_MAX_DELAY_MS = 8000;
  private static readonly HANDSHAKE_TIMEOUT_MS = 10000;

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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.manualDisconnect = false;
    this.stopReconnectTimer();
    this.isConnecting = true;

    this.connectPromise = new Promise((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.config.url);
      } catch (error) {
        this.isConnecting = false;
        this.connectPromise = null;
        reject(error);
        return;
      }

      this.ws = socket;
      let opened = false;
      let settled = false;
      let replacedBySelf = false;
      let handshakeTimer: NodeJS.Timeout | null = null;

      const clearHandshakeTimer = () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
      };

      // Per-socket replacement tracker (bound to this specific socket's lifetime)
      const replacementHandler = () => {
        if (this.ws === socket) {
          logger.info('Received connectionReplaced from server, marking for no-reconnect');
          replacedBySelf = true;
        }
      };
      this.onWSEvent('connectionReplaced', replacementHandler);

      const detachReplacementHandler = () => {
        this.offWSEvent('connectionReplaced', replacementHandler);
      };

      // Application-level handshake timeout — browsers don't enforce one, so if
      // the TCP socket is established but the HTTP 101 Upgrade never arrives,
      // WebSocket would sit in CONNECTING indefinitely. socket.close() triggers
      // onclose which does the rest of the cleanup + reconnect scheduling.
      handshakeTimer = setTimeout(() => {
        if (opened || settled) return;
        logger.warn('Handshake timeout after ' + WSClient.HANDSHAKE_TIMEOUT_MS + 'ms, closing socket');
        try { socket.close(); } catch { /* ignore */ }
      }, WSClient.HANDSHAKE_TIMEOUT_MS);

      socket.onopen = () => {
        clearHandshakeTimer();
        if (this.ws !== socket) {
          // Orphan: a newer socket already took over. Must reject to avoid
          // leaving connectPromise pending forever.
          if (!settled) {
            settled = true;
            reject(new Error('WebSocket orphaned by newer connection'));
          }
          detachReplacementHandler();
          try { socket.close(); } catch { /* ignore */ }
          return;
        }
        logger.info('Connected');
        opened = true;
        settled = true;
        this.isConnecting = false;
        this.connectPromise = null;
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        this.emitWSEvent('connected');
        resolve();
      };

      socket.onmessage = (event) => {
        this.handleRawMessage(event.data);
      };

      socket.onclose = (event) => {
        clearHandshakeTimer();
        detachReplacementHandler();
        const isCurrent = this.ws === socket;
        if (isCurrent) {
          this.ws = null;
          this.isConnecting = false;
          this.connectPromise = null;
          this.stopHeartbeat();
        }
        logger.info(`Disconnected: code=${event.code} reason=${event.reason}`);

        if (!opened && !settled) {
          settled = true;
          reject(new Error(`WebSocket closed before open: code=${event.code}`));
        }

        // Only the current socket's close should drive global reconnect state.
        if (!isCurrent) return;

        if (this.manualDisconnect || replacedBySelf || event.code === 4001) {
          if (replacedBySelf || event.code === 4001) {
            logger.info('Connection replaced by newer connection, will not reconnect');
          }
          this.emitWSEvent('disconnected');
          return;
        }

        this.scheduleReconnect();
      };

      socket.onerror = (error) => {
        logger.error('Connection error:', error);
        this.emitWSEvent('error', new Error('WebSocket connection error'));
        if (!opened && !settled) {
          settled = true;
          clearHandshakeTimer();
          if (this.ws === socket) {
            this.isConnecting = false;
            this.connectPromise = null;
          }
          reject(new Error('WebSocket connection failed'));
        }
      };
    });

    try {
      await this.connectPromise;
    } catch (error) {
      if (!this.manualDisconnect) {
        this.scheduleReconnect();
      }
      throw error;
    }
  }

  /**
   * 强制重建连接
   * 用于手动"重连"按钮路径：清理任何僵尸状态（pending connectPromise、卡在 CONNECTING 的 socket），
   * 然后重新连接。与 connect() 的区别是：connect() 若检测到现有 connectPromise 会短路返回它，
   * 而 forceReconnect() 会先打破短路条件。
   */
  async forceReconnect(): Promise<void> {
    logger.info('Force reconnect requested');
    this.stopReconnectTimer();
    this.connectPromise = null;
    this.isConnecting = false;
    this.manualDisconnect = false;
    if (this.ws) {
      const old = this.ws;
      // Detach before close so old.onclose sees this.ws !== socket and
      // leaves global state alone.
      this.ws = null;
      try { old.close(); } catch { /* ignore */ }
    }
    return this.connect();
  }

  /**
   * 断开WebSocket连接
   */
  disconnect(): void {
    this.manualDisconnect = true;
    this.stopReconnectTimer();
    this.stopHeartbeat();
    this.connectPromise = null;
    this.isConnecting = false;

    if (this.ws) {
      this.ws.close();
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

  getPluginRuntimeLogHistory(limit?: number): void {
    if (typeof limit === 'number') {
      this.send(WSMessageType.GET_PLUGIN_RUNTIME_LOG_HISTORY, { limit });
      return;
    }
    this.send(WSMessageType.GET_PLUGIN_RUNTIME_LOG_HISTORY);
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

  invokeSpectrumControl(id: string, action: 'in' | 'out' | 'toggle'): void {
    this.send(WSMessageType.INVOKE_SPECTRUM_CONTROL, { id, action });
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

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.reconnectTimer || this.isConnecting) {
      return;
    }

    const attempt = this.reconnectAttempt + 1;
    const exponentialDelay = Math.min(
      WSClient.RECONNECT_BASE_DELAY_MS * (2 ** (attempt - 1)),
      WSClient.RECONNECT_MAX_DELAY_MS,
    );
    const jitter = Math.round(exponentialDelay * 0.2 * Math.random());
    const delayMs = exponentialDelay + jitter;

    this.reconnectAttempt = attempt;
    logger.info('Scheduling reconnect', { attempt, delayMs });
    this.emitWSEvent('reconnecting', { attempt, delayMs });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        logger.warn('Reconnect attempt failed', error);
      });
    }, delayMs);
  }

  private stopReconnectTimer(): void {
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

  setClientSelectedOperator(selectedOperatorId: string | null): void {
    logger.debug('Setting client selected operator:', selectedOperatorId);
    this.send('setClientSelectedOperator', { selectedOperatorId });
  }

  /**
   * 发送客户端握手消息
   */
  sendHandshake(
    enabledOperatorIds: string[] | null,
    selectedOperatorId: string | null,
    clientInstanceId: string,
  ): void {
    logger.info('Sending handshake:', { enabledOperatorIds, selectedOperatorId, clientInstanceId });
    this.send('clientHandshake', {
      enabledOperatorIds,
      selectedOperatorId,
      clientInstanceId,
      clientVersion: '1.0.0',
      clientCapabilities: ['operatorFiltering', 'handshakeProtocol', 'selectedOperatorScopedAnalysis']
    });
  }

  /**
   * 操作员请求呼叫某人
   */
  requestCall(operatorId: string, callsign: string, selectedFrame?: WSSelectedFrame): void {
    this.send(WSMessageType.OPERATOR_REQUEST_CALL, { operatorId, callsign, selectedFrame });
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
