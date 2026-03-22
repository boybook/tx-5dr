/* eslint-disable @typescript-eslint/no-explicit-any */
// WebSocket服务器 - 事件处理和消息传递需要使用any类型以保持灵活性

import { WSMessageType, RadioConnectionStatus, UserRole } from '@tx5dr/contracts';
import type {
  AudioMonitorCodec,
  DecodeErrorInfo,
  FT8Spectrum,
  JWTPayload,
  ModeDescriptor,
  SlotInfo,
  SlotPack,
  SubWindowInfo,
  SystemStatus
} from '@tx5dr/contracts';
import { WSMessageHandler } from '@tx5dr/core';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { ProcessMonitor } from '../services/ProcessMonitor.js';
import { globalEventBus } from '../utils/EventBus.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { AuthManager } from '../auth/AuthManager.js';
import { createLogger } from '../utils/logger.js';
import { createOpusMonitorEncoder } from '../audio/OpusMonitorEncoder.js';
import type { OpusMonitorEncoder } from '../audio/OpusMonitorEncoder.js';

const logger = createLogger('WSServer');

/**
 * WebSocket连接包装器
 * 为每个客户端连接提供消息处理能力
 */
/**
 * WebSocket 实例接口
 */
interface WebSocketInstance {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
}

export class WSConnection extends WSMessageHandler {
  private ws: WebSocketInstance; // WebSocket实例(支持不同的WebSocket库)
  private id: string;
  private enabledOperatorIds: Set<string> = new Set(); // 客户端启用的操作员ID列表
  private handshakeCompleted: boolean = false; // 握手是否完成

  // 认证状态
  private authenticated: boolean = false;
  private userRole: UserRole | null = null;
  private authorizedOperatorIds: Set<string> = new Set(); // Token 授予的操作员权限
  private authLabel: string = '';
  private tokenId: string | null = null; // 用于懒查询最新权限

  // 记录WebSocket事件监听器,用于清理 (修复内存泄漏)
  private wsListeners: Map<string, (...args: unknown[]) => void> = new Map();

  constructor(ws: WebSocketInstance, id: string) {
    super();
    this.ws = ws;
    this.id = id;

    // 监听WebSocket消息
    const handleMessage = (...args: unknown[]) => {
      const data = args[0] as string | Buffer;
      const message = typeof data === 'string' ? data : data.toString();
      this.handleRawMessage(message);
    };
    this.ws.on('message', handleMessage);
    this.wsListeners.set('message', handleMessage);

    // 监听WebSocket关闭
    const handleClose = () => {
      this.emitWSEvent('disconnected');
    };
    this.ws.on('close', handleClose);
    this.wsListeners.set('close', handleClose);

    // 监听WebSocket错误
    const handleError = (...args: unknown[]) => {
      const error = args[0] as Error;
      this.emitWSEvent('error', error);
    };
    this.ws.on('error', handleError);
    this.wsListeners.set('error', handleError);
  }

  /**
   * 发送消息到客户端
   */
  send(type: string, data?: any, id?: string): void {
    try {
      const messageStr = this.createAndSerializeMessage(type, data, id);
      this.ws.send(messageStr);
    } catch (error) {
      logger.error(`failed to send message to client ${this.id}`, error);
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
    // 移除所有WebSocket事件监听器 (修复内存泄漏)
    logger.debug(`removing ${this.wsListeners.size} WebSocket listeners for connection ${this.id}`);
    for (const [eventName, handler] of this.wsListeners.entries()) {
      this.ws.off(eventName, handler);
    }
    this.wsListeners.clear();

    // 关闭WebSocket连接
    this.ws.close();
  }

  /**
   * 获取连接ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * 检查连接是否活跃
   */
  get isAlive(): boolean {
    return this.ws.readyState === 1; // WebSocket.OPEN
  }

  /**
   * 设置启用的操作员列表
   */
  setEnabledOperators(operatorIds: string[]): void {
    this.enabledOperatorIds = new Set(operatorIds);
    logger.debug(`connection ${this.id} set enabled operators: [${operatorIds.join(', ')}]`);
  }

  /**
   * 检查操作员是否在该连接中启用
   */
  isOperatorEnabled(operatorId: string): boolean {
    // 直接检查操作员是否在启用列表中（握手时已经处理了null转换）
    return this.enabledOperatorIds.has(operatorId);
  }

  /**
   * 获取启用的操作员ID列表
   */
  getEnabledOperatorIds(): string[] {
    return Array.from(this.enabledOperatorIds);
  }

  /**
   * 完成握手
   */
  completeHandshake(enabledOperatorIds: string[]): void {
    this.enabledOperatorIds = new Set(enabledOperatorIds);
    this.handshakeCompleted = true;
    logger.debug(`connection ${this.id} handshake complete, enabled operators: [${enabledOperatorIds.join(', ')}]`);
  }

  /**
   * 检查握手是否完成
   */
  isHandshakeCompleted(): boolean {
    return this.handshakeCompleted;
  }

  // ===== 认证方法 =====

  /**
   * 设置为已认证用户
   */
  setAuthenticated(role: UserRole, operatorIds: string[], label: string, tokenId?: string): void {
    this.authenticated = true;
    this.userRole = role;
    this.authorizedOperatorIds = new Set(operatorIds);
    this.authLabel = label;
    if (tokenId) this.tokenId = tokenId;
    logger.debug(`connection ${this.id} authenticated: role=${role}, label=${label}, operators=[${operatorIds.join(', ')}]`);
  }

  /**
   * 设置为公开观察者（未认证但允许查看）
   */
  setPublicViewer(): void {
    this.authenticated = false;
    this.userRole = UserRole.VIEWER;
    this.authorizedOperatorIds = new Set(); // 公开观察者无操作员权限
    this.authLabel = 'public viewer';
    logger.info(`connection ${this.id} set as public viewer`);
  }

  /**
   * 设置为 Admin（认证未启用时）
   */
  setAdminBypass(): void {
    this.authenticated = true;
    this.userRole = UserRole.ADMIN;
    this.authorizedOperatorIds = new Set();
    this.authLabel = 'local admin';
  }

  isAuthenticated(): boolean { return this.authenticated; }
  getUserRole(): UserRole | null { return this.userRole; }
  getAuthLabel(): string { return this.authLabel; }
  getAuthorizedOperatorIds(): string[] { return Array.from(this.authorizedOperatorIds); }

  /**
   * 检查是否有最低角色权限
   */
  hasMinRole(minRole: UserRole): boolean {
    if (!this.userRole) return false;
    return AuthManager.hasMinRole(this.userRole, minRole);
  }

  /**
   * 检查是否有操作员访问权限（懒查询：实时从 AuthManager 获取最新 operatorIds）
   */
  hasOperatorAccess(operatorId: string): boolean {
    if (!this.userRole) return false;
    if (this.userRole === UserRole.ADMIN) return true;

    // 懒查询：优先使用 AuthManager 中的最新权限（处理操作员增删后的动态变化）
    if (this.tokenId) {
      const authManager = AuthManager.getInstance();
      const perms = authManager.getTokenCurrentPermissions(this.tokenId);
      if (perms) {
        return perms.operatorIds.includes(operatorId);
      }
    }

    // 降级：使用认证时的快照
    return this.authorizedOperatorIds.has(operatorId);
  }

  getTokenId(): string | null { return this.tokenId; }

  /**
   * 完成握手（考虑权限过滤）
   * Admin 不做交集过滤，其他角色取 requestedIds ∩ authorizedOperatorIds
   */
  completeHandshakeWithAuth(requestedIds: string[]): void {
    if (this.userRole === UserRole.ADMIN) {
      // Admin: 直接使用请求的 ID（不限制）
      this.enabledOperatorIds = new Set(requestedIds);
    } else {
      // 其他角色: 取交集（使用懒查询获取最新权限）
      const currentAuthorized = this.getCurrentAuthorizedOperatorIds();
      this.enabledOperatorIds = new Set(
        requestedIds.filter(id => currentAuthorized.has(id))
      );
    }
    this.handshakeCompleted = true;
    logger.debug(`connection ${this.id} handshake complete (with auth), enabled operators: [${this.getEnabledOperatorIds().join(', ')}]`);
  }

  /**
   * 获取当前最新的授权操作员 ID（优先从 AuthManager 懒查询）
   */
  private getCurrentAuthorizedOperatorIds(): Set<string> {
    if (this.tokenId) {
      const authManager = AuthManager.getInstance();
      const perms = authManager.getTokenCurrentPermissions(this.tokenId);
      if (perms) {
        return new Set(perms.operatorIds);
      }
    }
    return this.authorizedOperatorIds;
  }
}

/**
 * WebSocket服务器
 * 管理多个客户端连接和消息广播，集成业务逻辑处理
 */
/**
 * AudioMonitorWSServer 接口定义
 */
interface AudioMonitorWSServer {
  getAllClientIds(): string[];
  sendAudioData(clientId: string, opusBuffer: Buffer | null, pcmBuffer: ArrayBuffer): void;
  hasOpusClients(): boolean;
  getServerCodec(): AudioMonitorCodec;
}

export class WSServer extends WSMessageHandler {
  private connections = new Map<string, WSConnection>();
  private connectionIdCounter = 0;
  private digitalRadioEngine: DigitalRadioEngine;
  private audioMonitorWSServer: AudioMonitorWSServer; // AudioMonitorWSServer实例
  private processMonitor: ProcessMonitor | null = null;
  private audioMonitorListenersSetup = false; // 标记AudioMonitor监听器是否已设置
  private opusMonitorEncoder: OpusMonitorEncoder | null = null;
  private opusAccumBuffer: Float32Array = new Float32Array(0);
  private readonly OPUS_FRAME_SIZE = 960; // 20ms at 48kHz
  private commandHandlers: Partial<Record<WSMessageType, (data: unknown, connectionId: string) => Promise<void> | void>>;

  constructor(digitalRadioEngine: DigitalRadioEngine, audioMonitorWSServer: AudioMonitorWSServer, processMonitor?: ProcessMonitor) {
    super();
    this.digitalRadioEngine = digitalRadioEngine;
    this.audioMonitorWSServer = audioMonitorWSServer;
    if (processMonitor) {
      this.processMonitor = processMonitor;
      processMonitor.setBroadcastCallback((snapshot) => {
        this.broadcast(WSMessageType.PROCESS_SNAPSHOT, snapshot);
      });
    }
    this.setupEngineEventListeners();
    this.setupAudioMonitorEventListeners(); // 初始化时设置音频监听事件（广播模式）

    this.commandHandlers = {
      [WSMessageType.START_ENGINE]: () => this.handleStartEngine(),
      [WSMessageType.STOP_ENGINE]: () => this.handleStopEngine(),
      [WSMessageType.GET_STATUS]: () => this.handleGetStatus(),
      [WSMessageType.SET_MODE]: (data) => this.handleSetMode((data as any)?.mode),
      [WSMessageType.GET_OPERATORS]: () => this.handleGetOperators(),
      [WSMessageType.SET_OPERATOR_CONTEXT]: (data) => this.handleSetOperatorContext(data),
      [WSMessageType.SET_OPERATOR_SLOT]: (data) => this.handleSetOperatorSlot(data),
      [WSMessageType.USER_COMMAND]: (data) => this.handleUserCommand(data),
      [WSMessageType.START_OPERATOR]: (data) => this.handleStartOperator(data),
      [WSMessageType.STOP_OPERATOR]: (data) => this.handleStopOperator(data),
      [WSMessageType.OPERATOR_REQUEST_CALL]: (data) => this.handleOperatorRequestCall(data),
      [WSMessageType.PING]: (_data, id) => { this.sendToConnection(id, WSMessageType.PONG); },
      [WSMessageType.SET_VOLUME_GAIN]: (data) => this.handleSetVolumeGain(data),
      [WSMessageType.SET_VOLUME_GAIN_DB]: (data) => this.handleSetVolumeGainDb(data),
      [WSMessageType.SET_CLIENT_ENABLED_OPERATORS]: (data, id) => this.handleSetClientEnabledOperators(id, data),
      [WSMessageType.CLIENT_HANDSHAKE]: (data, id) => this.handleClientHandshake(id, data),
      [WSMessageType.RADIO_MANUAL_RECONNECT]: () => this.handleRadioManualReconnect(),
      [WSMessageType.RADIO_STOP_RECONNECT]: () => this.handleRadioStopReconnect(),
      [WSMessageType.FORCE_STOP_TRANSMISSION]: () => this.handleForceStopTransmission(),
      [WSMessageType.AUTH_TOKEN]: (data, id) => this.handleAuthToken(id, data),
      [WSMessageType.AUTH_PUBLIC_VIEWER]: (_data, id) => this.handleAuthPublicViewer(id),
      [WSMessageType.VOICE_PTT_REQUEST]: (data, id) => this.handleVoicePttRequest(id, data),
      [WSMessageType.VOICE_PTT_RELEASE]: (_data, id) => this.handleVoicePttRelease(id),
      [WSMessageType.VOICE_SET_RADIO_MODE]: (data) => this.handleVoiceSetRadioMode(data),
    };
  }

  /**
   * 设置DigitalRadioEngine事件监听器
   */
  private setupEngineEventListeners(): void {
    // 监听引擎事件并广播给客户端
    this.digitalRadioEngine.on('modeChanged', (mode) => {
      logger.debug('modeChanged event received, broadcasting to clients');
      this.broadcastModeChanged(mode);
    });

    this.digitalRadioEngine.on('slotStart', (slotInfo) => {
      this.broadcastSlotStart(slotInfo);
    });

    this.digitalRadioEngine.on('subWindow', (windowInfo) => {
      this.broadcastSubWindow(windowInfo);
    });

    // 监听时序告警事件（由核心/操作员侧在判定"赶不上发射"时发出）
    this.digitalRadioEngine.on('timingWarning' as any, (data: any) => {
      try {
        const title = data?.title || 'Timing Warning';
        const text = data?.text || 'Operator auto-decision may not complete encoding in time for this transmission slot';
        this.broadcastTextMessage(title, text, undefined, undefined, 'timingAlert');
      } catch {}
    });

    this.digitalRadioEngine.on('slotPackUpdated', async (slotPack) => {
      await this.broadcastSlotPackUpdated(slotPack);
    });

    // 监听频谱数据事件（通过事件总线，优化路径）
    globalEventBus.on('bus:spectrumData', (spectrum) => {
      this.broadcastSpectrumData(spectrum);
    });

    this.digitalRadioEngine.on('decodeError', (errorInfo) => {
      this.broadcastDecodeError(errorInfo);
    });

    this.digitalRadioEngine.on('systemStatus', (status) => {
      // 如果引擎正在运行且AudioMonitor监听器未设置，尝试设置
      if (status.isRunning && !this.audioMonitorListenersSetup) {
        logger.debug('engine started, setting up AudioMonitor listeners');
        this.setupAudioMonitorEventListeners();
      }

      // 引擎停止时重置标志，确保下次启动时重新注册监听器到新的 AudioMonitorService 实例
      if (!status.isRunning && this.audioMonitorListenersSetup) {
        logger.debug('engine stopped, resetting AudioMonitor listener flag');
        this.audioMonitorListenersSetup = false;
      }

      this.broadcastSystemStatus(status);
    });

    // 监听发射日志事件
    this.digitalRadioEngine.on('transmissionLog' as any, (data) => {
      logger.debug('transmission log received, broadcasting to clients', data);
      this.broadcast(WSMessageType.TRANSMISSION_LOG, data);
    });

    // 监听操作员状态更新事件
    this.digitalRadioEngine.on('operatorStatusUpdate' as any, (operatorStatus) => {
      this.broadcastOperatorStatusUpdate(operatorStatus);
    });

    // 监听操作员列表更新事件
    this.digitalRadioEngine.on('operatorsList' as any, (data: { operators: any[] }) => {

      const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
      activeConnections.forEach(connection => {
        const filteredOperators = data.operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      });

    });

    // 监听音量变化事件
    this.digitalRadioEngine.on('volumeGainChanged', (data) => {
      // 支持向后兼容：如果data是数字，则为老版本格式
      if (typeof data === 'number') {
        this.broadcast(WSMessageType.VOLUME_GAIN_CHANGED, { gain: data });
      } else {
        // 新版本格式，同时发送线性和dB值
        this.broadcast(WSMessageType.VOLUME_GAIN_CHANGED, data);
      }
    });

    // 监听QSO记录添加事件
    this.digitalRadioEngine.on('qsoRecordAdded' as any, (data: { operatorId: string; logBookId: string; qsoRecord: any }) => {
      logger.debug('QSO record added event received', { callsign: data.qsoRecord.callsign });
      this.broadcastQSORecordAdded(data);
      // 向启用了该操作员的客户端发送简洁的Toast消息
      try {
        const qso = data.qsoRecord;
        const mhz = (qso.frequency / 1_000_000).toFixed(3);
        const gridPart = qso.grid ? ` ${qso.grid}` : '';
        const title = 'QSO Logged';
        const text = `${qso.callsign}${gridPart} • ${mhz} MHz • ${qso.mode}`;
        this.broadcastOperatorTextMessage(data.operatorId, title, text, 'success', 3000, 'qsoLogged');
      } catch (e) {
        logger.warn('failed to send QSO record toast', e);
      }
    });

    // 监听日志本更新事件
    this.digitalRadioEngine.on('logbookUpdated' as any, (data: { logBookId: string; statistics: any }) => {
      this.broadcastLogbookUpdated(data);
    });

    // 监听电台状态变化事件
    this.digitalRadioEngine.on('radioStatusChanged', (data) => {
      logger.debug('radio status changed event received', data);
      this.broadcast(WSMessageType.RADIO_STATUS_CHANGED, data);

      // 仅连接成功时推送 Toast（断开/失败由前端 RadioControl Alert 展示）
      if (data.connected) {
        this.broadcastTextMessage(
          'Radio Connected',
          data.reason || 'Radio connection successful',
          'success',
          3000,
          'radioConnected'
        );
      }
    });

    // 监听电台错误事件（通过专用 RADIO_ERROR 频道推送，不再使用 Toast）
    this.digitalRadioEngine.on('radioError', (data) => {
      logger.debug('radio error event received', data);
      this.broadcast(WSMessageType.RADIO_ERROR, data);
    });

    // 监听电台发射中断开连接事件
    this.digitalRadioEngine.on('radioDisconnectedDuringTransmission', (data) => {
      logger.debug('radio disconnected during transmission event received', data);
      this.broadcast(WSMessageType.RADIO_DISCONNECTED_DURING_TRANSMISSION, data);
    });

    // 监听频率变化事件
    this.digitalRadioEngine.on('frequencyChanged', (data) => {
      logger.debug('frequency changed event received', data);
      this.broadcast(WSMessageType.FREQUENCY_CHANGED, data);
    });

    // 监听PTT状态变化事件
    this.digitalRadioEngine.on('pttStatusChanged', (data) => {
      logger.debug(`PTT status changed: ${data.isTransmitting ? 'transmitting' : 'idle'}, operators=[${data.operatorIds?.join(', ') || ''}]`);
      this.broadcast(WSMessageType.PTT_STATUS_CHANGED, data);
    });

    // 监听电台数值表数据事件（通过事件总线，优化路径）
    globalEventBus.on('bus:meterData', (data) => {
      // 数值表数据频率较高，使用静默广播（不打印日志）
      this.broadcast(WSMessageType.METER_DATA, data);
    });

    // 监听天线调谐器状态变化事件
    const radioManager = this.digitalRadioEngine.getRadioManager();
    radioManager.on('tunerStatusChanged', (status: any) => {
      logger.debug('tuner status changed event received', status);
      this.broadcast(WSMessageType.TUNER_STATUS_CHANGED, status);
    });

    // 监听 Profile 变更事件
    this.digitalRadioEngine.on('profileChanged', (data: any) => {
      logger.debug(`profile switched: ${data.profile?.name} (id: ${data.profileId})`);
      this.broadcast(WSMessageType.PROFILE_CHANGED, data);
    });

    // 监听 Profile 列表更新事件
    this.digitalRadioEngine.on('profileListUpdated', (data: any) => {
      logger.debug(`profile list updated: ${data.profiles?.length} profiles`);
      this.broadcast(WSMessageType.PROFILE_LIST_UPDATED, data);
    });

    // 监听语音 PTT 锁状态变化事件
    this.digitalRadioEngine.on('voicePttLockChanged', (data) => {
      logger.debug('voice PTT lock changed', data);
      this.broadcast(WSMessageType.VOICE_PTT_LOCK_CHANGED, data);
    });

    // 监听语音电台模式变化事件
    this.digitalRadioEngine.on('voiceRadioModeChanged', (data) => {
      logger.debug('voice radio mode changed', data);
      this.broadcast(WSMessageType.VOICE_RADIO_MODE_CHANGED, data);
    });
  }

  // WebSocket 命令所需的最低角色
  private static readonly COMMAND_ROLES: Partial<Record<WSMessageType, UserRole>> = {
    [WSMessageType.START_ENGINE]: UserRole.ADMIN,
    [WSMessageType.STOP_ENGINE]: UserRole.ADMIN,
    [WSMessageType.SET_MODE]: UserRole.ADMIN,
    [WSMessageType.SET_VOLUME_GAIN]: UserRole.OPERATOR,
    [WSMessageType.SET_VOLUME_GAIN_DB]: UserRole.OPERATOR,
    [WSMessageType.RADIO_MANUAL_RECONNECT]: UserRole.ADMIN,
    [WSMessageType.RADIO_STOP_RECONNECT]: UserRole.ADMIN,
    [WSMessageType.FORCE_STOP_TRANSMISSION]: UserRole.ADMIN,
    [WSMessageType.VOICE_PTT_REQUEST]: UserRole.OPERATOR,
    [WSMessageType.VOICE_SET_RADIO_MODE]: UserRole.OPERATOR,
    [WSMessageType.START_OPERATOR]: UserRole.OPERATOR,
    [WSMessageType.STOP_OPERATOR]: UserRole.OPERATOR,
    [WSMessageType.SET_OPERATOR_CONTEXT]: UserRole.OPERATOR,
    [WSMessageType.SET_OPERATOR_SLOT]: UserRole.OPERATOR,
    [WSMessageType.USER_COMMAND]: UserRole.OPERATOR,
    [WSMessageType.OPERATOR_REQUEST_CALL]: UserRole.OPERATOR,
  };

  // 需要操作员访问权限检查的命令
  private static readonly OPERATOR_ACCESS_COMMANDS = new Set([
    WSMessageType.START_OPERATOR,
    WSMessageType.STOP_OPERATOR,
    WSMessageType.SET_OPERATOR_CONTEXT,
    WSMessageType.SET_OPERATOR_SLOT,
    WSMessageType.USER_COMMAND,
    WSMessageType.OPERATOR_REQUEST_CALL,
  ]);

  /**
   * 处理客户端命令（含权限检查）
   */
  private async handleClientCommand(connectionId: string, message: { type: string; data: unknown }): Promise<void> {

    const connection = this.getConnection(connectionId);
    if (!connection) return;

    const msgType = message.type as WSMessageType;

    // 认证命令始终允许
    if (msgType === WSMessageType.AUTH_TOKEN || msgType === WSMessageType.AUTH_PUBLIC_VIEWER) {
      const handler = this.commandHandlers[msgType];
      if (handler) await handler(message.data, connectionId);
      return;
    }

    // 角色权限检查
    const requiredRole = WSServer.COMMAND_ROLES[msgType];
    if (requiredRole && !connection.hasMinRole(requiredRole)) {
      connection.send(WSMessageType.ERROR, {
        message: 'insufficient_permission',
        code: 'FORBIDDEN',
        details: { command: message.type, requiredRole },
      });
      return;
    }

    // 操作员访问权限检查
    if (WSServer.OPERATOR_ACCESS_COMMANDS.has(msgType)) {
      const data = message.data as any;
      const operatorId = data?.operatorId;
      if (operatorId && !connection.hasOperatorAccess(operatorId)) {
        connection.send(WSMessageType.ERROR, {
          message: 'no_operator_access',
          code: 'FORBIDDEN',
          details: { operatorId },
        });
        return;
      }
    }

    const handler = this.commandHandlers[msgType];
    if (handler) {
      await handler(message.data, connectionId);
    } else {
      logger.warn('unknown message type', { type: message.type });
    }
  }

  /**
   * 📊 Day14：统一的错误处理辅助方法
   * 将错误转换为RadioError，广播错误信息和系统状态
   */
  private handleCommandError(
    error: unknown,
    commandName: string,
    defaultErrorCode: RadioErrorCode = RadioErrorCode.INVALID_OPERATION
  ): void {
    logger.error(`${commandName} failed`, error);

    // 转换为RadioError以提供友好的错误信息
    const radioError = error instanceof RadioError
      ? error
      : RadioError.from(error, defaultErrorCode);

    // 广播详细的错误信息（包括用户消息和建议）
    this.broadcast(WSMessageType.ERROR, {
      message: radioError.message,
      userMessage: radioError.userMessage,
      code: radioError.code,
      severity: radioError.severity,
      suggestions: radioError.suggestions,
      timestamp: radioError.timestamp,
      context: { command: commandName }
    });

    // 错误后广播系统状态，确保前端状态同步
    try {
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);
      logger.debug('system status broadcasted after error');
    } catch (statusError) {
      logger.error('failed to broadcast system status after error', statusError);
    }
  }

  /**
   * 处理启动引擎命令
   * 📊 Day14优化：完善错误处理，添加错误后的状态广播和友好提示
   */
  private async handleStartEngine(): Promise<void> {
    logger.debug('startEngine command received');
    try {
      // 始终调用引擎方法，让引擎内部处理重复调用情况
      await this.digitalRadioEngine.start();
      logger.debug('digitalRadioEngine.start() completed');

      // 强制发送最新状态确保同步
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);
      logger.debug('system status broadcasted after start', { isDecoding: status.isDecoding });
    } catch (error) {
      // 📊 Day14：使用统一的错误处理方法
      this.handleCommandError(error, 'startEngine', RadioErrorCode.INVALID_OPERATION);
    }
  }

  /**
   * 处理停止引擎命令
   * 📊 Day14优化：完善错误处理，添加错误后的状态广播和友好提示
   */
  private async handleStopEngine(): Promise<void> {
    logger.debug('stopEngine command received');
    try {
      // 始终调用引擎方法，让引擎内部处理重复调用情况
      await this.digitalRadioEngine.stop();
      logger.debug('digitalRadioEngine.stop() completed');

      // 强制发送最新状态确保同步
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);
      logger.debug('system status broadcasted after stop', { isDecoding: status.isDecoding });
    } catch (error) {
      // 📊 Day14：使用统一的错误处理方法
      this.handleCommandError(error, 'stopEngine', RadioErrorCode.INVALID_OPERATION);
    }
  }

  /**
   * 处理获取状态命令
   */
  private async handleGetStatus(): Promise<void> {
    const currentStatus = this.digitalRadioEngine.getStatus();
    this.broadcastSystemStatus(currentStatus);
  }

  /**
   * 处理设置模式命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetMode(mode: ModeDescriptor | string): Promise<void> {
    try {
      await this.digitalRadioEngine.setMode(mode);
    } catch (error) {
      this.handleCommandError(error, 'setMode', RadioErrorCode.UNSUPPORTED_MODE);
    }
  }

  /**
   * 处理获取操作员列表命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleGetOperators(): Promise<void> {
    logger.debug('getOperators request received');
    try {
      const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();

      // 只向已完成握手的客户端发送过滤后的操作员列表
      const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
      activeConnections.forEach(connection => {
        const filteredOperators = operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      });

    } catch (error) {
      this.handleCommandError(error, 'getOperators');
    }
  }

  /**
   * 处理设置操作员上下文命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetOperatorContext(data: any): Promise<void> {
    try {
      const { operatorId, context } = data;
      await this.digitalRadioEngine.operatorManager.updateOperatorContext(operatorId, context);
    } catch (error) {
      this.handleCommandError(error, 'setOperatorContext');
    }
  }

  /**
   * 处理设置操作员时隙命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetOperatorSlot(data: any): Promise<void> {
    try {
      const { operatorId, slot } = data;
      this.digitalRadioEngine.operatorManager.setOperatorSlot(operatorId, slot);
    } catch (error) {
      this.handleCommandError(error, 'setOperatorSlot');
    }
  }

  /**
   * 处理用户命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleUserCommand(data: any): Promise<void> {
    try {
      const { operatorId, command, args } = data;
      const operator = this.digitalRadioEngine.operatorManager.getOperator(operatorId);
      if (!operator) {
        throw new Error(`Operator ${operatorId} does not exist`);
      }

      // 如果是update_context命令，先持久化到配置文件（此时内存还未更新，可以检测到变化）
      if (command === 'update_context') {
        await this.digitalRadioEngine.operatorManager.updateOperatorContext(operatorId, args);
        logger.debug('update_context command persisted to config file');
      }

      // 然后调用operator更新内存状态
      operator.userCommand({ command, args });
      logger.debug(`user command executed: operator=${operatorId}, command=${command}`, args);
    } catch (error) {
      this.handleCommandError(error, 'userCommand');
    }
  }

  /**
   * 处理启动操作员命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleStartOperator(data: any): Promise<void> {
    try {
      const { operatorId } = data;
      this.digitalRadioEngine.operatorManager.startOperator(operatorId);
      logger.debug(`operator started: ${operatorId}`);
    } catch (error) {
      this.handleCommandError(error, 'startOperator');
    }
  }

  /**
   * 处理停止操作员命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleStopOperator(data: any): Promise<void> {
    try {
      const { operatorId } = data;
      this.digitalRadioEngine.operatorManager.stopOperator(operatorId);
      logger.debug(`operator stopped: ${operatorId}`);
    } catch (error) {
      this.handleCommandError(error, 'stopOperator');
    }
  }

  /**
   * 处理操作员请求呼叫命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleOperatorRequestCall(data: any): Promise<void> {
    try {
      const { operatorId, callsign } = data;
      const operator = this.digitalRadioEngine.operatorManager.getOperator(operatorId);
      if (!operator) {
        throw new Error(`Operator ${operatorId} does not exist`);
      }
      const lastMessage = this.digitalRadioEngine.getSlotPackManager().getLastMessageFromCallsign(callsign);
      operator.requestCall(callsign, lastMessage);
      // 调用manager中的start，来启用中途发射
      this.digitalRadioEngine.operatorManager.startOperator(operatorId);
    } catch (error) {
      this.handleCommandError(error, 'operatorRequestCall');
    }
  }

  // ===== 语音模式命令处理 =====

  private async handleVoicePttRequest(connectionId: string, data: any): Promise<void> {
    try {
      const voiceSessionManager = this.digitalRadioEngine.getVoiceSessionManager();
      if (!voiceSessionManager) {
        throw new Error('Voice session manager not available');
      }

      const connection = this.getConnection(connectionId);
      const label = connection?.getAuthLabel() || connectionId;
      const voiceAudioClientId = data?.voiceAudioClientId as string | undefined;
      const result = await voiceSessionManager.startTransmit(connectionId, label, voiceAudioClientId);

      if (!result.success) {
        this.sendToConnection(connectionId, WSMessageType.ERROR, {
          message: result.reason || 'PTT request failed',
          code: 'VOICE_PTT_DENIED',
        });
      }
    } catch (error) {
      this.handleCommandError(error, 'voicePttRequest');
    }
  }

  private async handleVoicePttRelease(connectionId: string): Promise<void> {
    try {
      const voiceSessionManager = this.digitalRadioEngine.getVoiceSessionManager();
      if (!voiceSessionManager) {
        throw new Error('Voice session manager not available');
      }

      await voiceSessionManager.stopTransmit(connectionId);
    } catch (error) {
      this.handleCommandError(error, 'voicePttRelease');
    }
  }

  private async handleVoiceSetRadioMode(data: any): Promise<void> {
    try {
      const voiceSessionManager = this.digitalRadioEngine.getVoiceSessionManager();
      if (!voiceSessionManager) {
        throw new Error('Voice session manager not available');
      }

      const { radioMode } = data as { radioMode: string };
      if (!radioMode) {
        throw new Error('radioMode is required');
      }

      await voiceSessionManager.setRadioMode(radioMode);
    } catch (error) {
      this.handleCommandError(error, 'voiceSetRadioMode');
    }
  }

  /**
   * 添加新的客户端连接
   */
  addConnection(ws: any): WSConnection {
    const id = `conn_${++this.connectionIdCounter}`;
    const connection = new WSConnection(ws, id);

    // 转发连接事件
    connection.onWSEvent('disconnected', () => {
      this.removeConnection(id);
    });

    // 监听客户端消息并处理
    connection.onRawMessage((message) => {
      this.handleClientCommand(id, message as { type: string; data: unknown });
    });

    this.connections.set(id, connection);
    logger.info('new connection', { id });

    // 阶段1: 发送基础状态信息（不包括需要过滤的数据）

    // 1. 发送当前系统状态
    const status = this.digitalRadioEngine.getStatus();
    connection.send(WSMessageType.SYSTEM_STATUS, status);

    // 2. 发送当前模式信息
    connection.send(WSMessageType.MODE_CHANGED, status.currentMode);

    // 3. 发送当前音量增益
    try {
      const volumeGain = this.digitalRadioEngine.getVolumeGain();
      const volumeGainDb = this.digitalRadioEngine.getVolumeGainDb();
      connection.send(WSMessageType.VOLUME_GAIN_CHANGED, {
        gain: volumeGain,
        gainDb: volumeGainDb
      });
    } catch (error) {
      logger.error('failed to send volume gain', error);
    }

    // 4. 发送当前电台连接状态（确保前端获取 connecting/reconnecting 等中间状态）
    try {
      const radioManager = this.digitalRadioEngine.getRadioManager();
      const radioConnectionStatus = radioManager.getConnectionStatus();
      connection.send(WSMessageType.RADIO_STATUS_CHANGED, {
        connected: radioManager.isConnected(),
        status: radioConnectionStatus,
        radioInfo: null,
        radioConfig: radioManager.getConfig(),
        connectionHealth: radioManager.getConnectionHealth(),
      });
    } catch (error) {
      logger.error('failed to send radio connection status', error);
    }

    // 认证流程
    const authManager = AuthManager.getInstance();
    if (!authManager.isAuthEnabled()) {
      // 认证未启用 → 直接作为 Admin（向后兼容）
      connection.setAdminBypass();
      logger.info(`connection ${id} basic state sent (auth disabled, Admin mode), waiting for client handshake`);
    } else {
      // 认证已启用 → 发送 AUTH_REQUIRED
      connection.send(WSMessageType.AUTH_REQUIRED, {
        allowPublicViewing: authManager.isPublicViewingAllowed(),
      });
      logger.info(`connection ${id} AUTH_REQUIRED sent, waiting for client authentication`);
    }

    return connection;
  }

  /**
   * 移除客户端连接
   */
  removeConnection(id: string): void {
    const connection = this.connections.get(id);
    if (connection) {
      connection.removeAllListeners();
      this.connections.delete(id);
      logger.info('connection disconnected', { id });

      // Auto-release voice PTT if this client held it
      const voiceSessionManager = this.digitalRadioEngine.getVoiceSessionManager();
      if (voiceSessionManager) {
        voiceSessionManager.handleClientDisconnect(id).catch((err) => {
          logger.error('failed to handle voice client disconnect', err);
        });
      }

      // 广播客户端数量变化（客户端断开连接）
      this.broadcastClientCount();
    }
  }

  /**
   * 获取指定连接
   */
  getConnection(id: string): WSConnection | undefined {
    return this.connections.get(id);
  }

  /**
   * 获取所有活跃连接
   */
  getActiveConnections(): WSConnection[] {
    return Array.from(this.connections.values()).filter(conn => conn.isAlive);
  }

  /**
   * 广播消息到所有客户端
   */
  broadcast(type: string, data?: any, id?: string): void {
    const activeConnections = this.getActiveConnections();

    activeConnections.forEach(connection => {
      connection.send(type, data, id);
    });
  }

  /**
   * 广播客户端连接数量变化
   * 只统计已完成握手的活跃客户端
   */
  private broadcastClientCount(): void {
    const activeConnections = this.getActiveConnections();
    const handshakeCompletedCount = activeConnections.filter(conn => conn.isHandshakeCompleted()).length;

    logger.debug(`broadcasting client count: ${handshakeCompletedCount} connected clients`);

    this.broadcast(WSMessageType.CLIENT_COUNT_CHANGED, {
      count: handshakeCompletedCount,
      timestamp: Date.now()
    });
  }

  /**
   * 发送消息到指定客户端
   */
  sendToConnection(connectionId: string, type: string, data?: any, id?: string): boolean {
    const connection = this.getConnection(connectionId);
    if (connection && connection.isAlive) {
      connection.send(type, data, id);
      return true;
    }
    return false;
  }

  // ===== 统一的广播方法 =====

  /**
   * 广播模式变化事件
   */
  broadcastModeChanged(mode: ModeDescriptor): void {
    this.broadcast(WSMessageType.MODE_CHANGED, mode);
  }

  /**
   * 广播时隙开始事件
   */
  broadcastSlotStart(slotInfo: SlotInfo): void {
    this.broadcast(WSMessageType.SLOT_START, slotInfo);
  }

  /**
   * 广播子窗口事件
   */
  broadcastSubWindow(windowInfo: SubWindowInfo): void {
    this.broadcast(WSMessageType.SUB_WINDOW, windowInfo);
  }

  /**
   * 广播极简文本消息（标题+正文）
   * @param title 标题
   * @param text 内容
   * @param color 颜色类型: success/warning/danger/default
   * @param timeout 显示时长（毫秒），null 表示需要手动关闭
   */
  broadcastTextMessage(
    title: string,
    text: string,
    color?: 'success' | 'warning' | 'danger' | 'default',
    timeout?: number | null,
    key?: string,
    params?: Record<string, string>
  ): void {
    logger.debug(`broadcasting text message: ${title} - ${text}`, { color, timeout });
    this.broadcast(WSMessageType.TEXT_MESSAGE, {
      title,
      text,
      color,
      timeout,
      key,
      params
    });
  }

  /**
   * 仅向启用了指定操作员的客户端广播极简文本消息
   * @param operatorId 操作员ID
   * @param title 标题
   * @param text 内容
   * @param color 颜色类型: success/warning/danger/default
   * @param timeout 显示时长（毫秒），null 表示需要手动关闭
   */
  broadcastOperatorTextMessage(
    operatorId: string,
    title: string,
    text: string,
    color?: 'success' | 'warning' | 'danger' | 'default',
    timeout?: number | null,
    key?: string,
    params?: Record<string, string>
  ): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
    const targets = activeConnections.filter(conn => conn.isOperatorEnabled(operatorId));
    targets.forEach(conn => {
      conn.send(WSMessageType.TEXT_MESSAGE, {
        title,
        text,
        color,
        timeout,
        key,
        params
      });
    });
    logger.debug(`sent text message to ${targets.length} clients with operator ${operatorId} enabled: ${title} - ${text}`, { color, timeout });
  }

  /**
   * 广播时隙包更新事件（为每个客户端定制化数据）
   */
  async broadcastSlotPackUpdated(slotPack: SlotPack): Promise<void> {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());

    // 为每个客户端分别生成定制化的SlotPack
    const customizedPromises = activeConnections.map(async (connection) => {
      try {
        const customizedSlotPack = await this.customizeSlotPackForClient(connection, slotPack);
        connection.send(WSMessageType.SLOT_PACK_UPDATED, customizedSlotPack);
      } catch (error) {
        logger.error(`failed to customize SlotPack for connection ${connection.getId()}`, error);
        // 发送原始数据作为后备
        connection.send(WSMessageType.SLOT_PACK_UPDATED, slotPack);
      }
    });

    await Promise.all(customizedPromises);
    logger.debug(`sent customized slot pack to ${activeConnections.length} clients`);
  }

  /**
   * 为特定客户端定制化SlotPack数据
   */
  private async customizeSlotPackForClient(connection: WSConnection, slotPack: SlotPack): Promise<SlotPack> {
    // 获取该客户端启用的操作员
    const enabledOperatorIds = connection.getEnabledOperatorIds();
    if (enabledOperatorIds.length === 0) {
      // 如果没有启用任何操作员，返回原始数据（不带logbook分析）
      return slotPack;
    }

    // 复制SlotPack以避免修改原始数据
    const customizedSlotPack = JSON.parse(JSON.stringify(slotPack));

    // 获取该连接启用的操作员的呼号列表，用于过滤该连接用户自己发射的内容
    const myOperatorCallsigns = new Set<string>();
    const operatorManager = this.digitalRadioEngine.operatorManager;
    for (const operatorId of enabledOperatorIds) {
      const operator = operatorManager.getOperator(operatorId);
      if (operator && operator.config.myCallsign) {
        myOperatorCallsigns.add(operator.config.myCallsign.toUpperCase());
      }
    }

    // 过滤和处理frames
    const framePromises = customizedSlotPack.frames.map(async (frame: any) => {
      try {
        // 过滤掉收到的自己发射的内容（排除发射帧SNR=-999）
        if (frame.snr !== -999) {
          const { FT8MessageParser } = await import('@tx5dr/core');
          try {
            const parsedMessage = FT8MessageParser.parseMessage(frame.message);

            // 检查是否为该连接用户自己发射的消息（通过sender呼号匹配）
            const senderCallsign = (parsedMessage as any).senderCallsign;
            if (senderCallsign && myOperatorCallsigns.has(senderCallsign.toUpperCase())) {
              logger.debug(`filtered own message for connection ${connection.getId()}: "${frame.message}" (${senderCallsign})`);
              return null; // 标记为过滤掉
            }
          } catch (parseError) {
            // 解析失败时保留原frame，不影响其他处理
            logger.warn(`failed to parse message for filtering: "${frame.message}"`, parseError);
          }
        }

        // 添加logbook分析
        const logbookAnalysis = await this.analyzeFrameForOperators(frame, enabledOperatorIds);
        if (logbookAnalysis) {
          frame.logbookAnalysis = logbookAnalysis;
        }
      } catch (error) {
        logger.warn(`failed to analyze frame: ${frame.message}`, error);
        // 继续处理，不影响其他frame
      }
      return frame;
    });

    const processedFrames = await Promise.all(framePromises);
    // 过滤掉被标记为null的frames（即被过滤的自己发射的内容）
    customizedSlotPack.frames = processedFrames.filter(frame => frame !== null);

    return customizedSlotPack;
  }


  /**
   * 分析单个frame对所有启用操作员的日志本情况
   */
  private async analyzeFrameForOperators(frame: any, enabledOperatorIds: string[]): Promise<any> {
    const { FT8MessageParser, getBandFromFrequency } = await import('@tx5dr/core');
    const { ConfigManager } = await import('../config/config-manager.js');

    // 解析FT8消息
    const parsedMessage = FT8MessageParser.parseMessage(frame.message);

    // 提取呼号和网格信息
    let callsign: string | undefined;
    let grid: string | undefined;

    // 根据消息类型提取呼号和网格
    if (parsedMessage.type === 'cq') {
      callsign = parsedMessage.senderCallsign;
      grid = parsedMessage.grid;
    } else if (parsedMessage.type === 'call') {
      callsign = parsedMessage.senderCallsign;
      grid = parsedMessage.grid;
    } else if (parsedMessage.type === 'signal_report') {
      callsign = parsedMessage.senderCallsign;
    } else if (parsedMessage.type === 'roger_report') {
      callsign = parsedMessage.senderCallsign;
    } else if (parsedMessage.type === 'rrr') {
      callsign = parsedMessage.senderCallsign;
    } else if (parsedMessage.type === '73') {
      callsign = parsedMessage.senderCallsign;
    }

    if (!callsign) {
      // 如果没有呼号信息，不进行分析
      return null;
    }

    // 计算当前系统频段（用于按频段判断"是否新呼号"）
    let band: string = 'Unknown';
    try {
      const cfg = ConfigManager.getInstance();
      const last = cfg.getLastSelectedFrequency();
      if (last && last.frequency && last.frequency > 1_000_000) {
        band = getBandFromFrequency(last.frequency);
      }
    } catch {}

    // 对每个启用的操作员检查日志本（按该频段）
    const operatorManager = this.digitalRadioEngine.operatorManager;
    const logManager = operatorManager.getLogManager();

    // 合并所有操作员的分析结果
    let isNewCallsign = true;
    let isNewPrefix = true;
    let isNewGrid = true;
    let prefix: string | undefined;

    for (const operatorId of enabledOperatorIds) {
      try {
        const logBook = await logManager.getOperatorLogBook(operatorId);
        if (logBook) {
          const analysis = await logBook.provider.analyzeCallsign(callsign, grid, { operatorId, band });

          // 如果任一操作员已通联过，则不是新的
          if (!analysis.isNewCallsign) {
            isNewCallsign = false;
          }
          if (!analysis.isNewPrefix) {
            isNewPrefix = false;
          }
          if (grid && !analysis.isNewGrid) {
            isNewGrid = false;
          }

          // 记录前缀信息
          if (analysis.prefix) {
            prefix = analysis.prefix;
          }
        }
      } catch (error) {
        logger.warn(`failed to analyze logbook for operator ${operatorId}`, error);
        // 继续处理其他操作员
      }
    }

    return {
      isNewCallsign,
      isNewPrefix,
      isNewGrid: grid ? isNewGrid : undefined,
      callsign,
      grid,
      prefix
    };
  }

  /**
   * 广播频谱数据事件
   */
  broadcastSpectrumData(spectrumData: FT8Spectrum): void {
    this.broadcast(WSMessageType.SPECTRUM_DATA, spectrumData);
  }

  /**
   * 广播解码错误事件
   */
  broadcastDecodeError(errorInfo: DecodeErrorInfo): void {
    this.broadcast(WSMessageType.DECODE_ERROR, errorInfo);
  }

  /**
   * 广播系统状态事件
   */
  broadcastSystemStatus(status: SystemStatus): void {
    this.broadcast(WSMessageType.SYSTEM_STATUS, status);
  }

  /**
   * 广播操作员状态更新事件
   */
  broadcastOperatorStatusUpdate(operatorStatus: any): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());

    activeConnections.forEach(connection => {
      if (connection.isOperatorEnabled(operatorStatus.id)) {
        connection.send(WSMessageType.OPERATOR_STATUS_UPDATE, operatorStatus);
      }
    });

    logger.debug(`sent operator status update to ${activeConnections.filter(conn => conn.isOperatorEnabled(operatorStatus.id)).length} clients with operator ${operatorStatus.id} enabled`);
  }

  /**
   * 广播QSO记录添加事件
   */
  broadcastQSORecordAdded(data: { operatorId: string; logBookId: string; qsoRecord: any }): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());

    // 只向启用了相关操作员的客户端发送
    activeConnections.forEach(connection => {
      if (connection.isOperatorEnabled(data.operatorId)) {
        connection.send(WSMessageType.QSO_RECORD_ADDED, data);
      }
    });

    const targetConnections = activeConnections.filter(conn => conn.isOperatorEnabled(data.operatorId));
    logger.debug(`sent QSO record added event to ${targetConnections.length} clients with operator ${data.operatorId} enabled`, { callsign: data.qsoRecord.callsign });
  }

  /**
   * 广播日志本更新事件
   */
  broadcastLogbookUpdated(data: { logBookId: string; statistics: any }): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());

    // 发送给所有已握手的客户端（日志本统计信息通常所有客户端都需要）
    activeConnections.forEach(connection => {
      connection.send(WSMessageType.LOGBOOK_UPDATED, data);
    });

    logger.debug(`sent logbook updated event to ${activeConnections.length} clients`, { logBookId: data.logBookId });
  }

  /**
   * 处理设置音量增益命令（线性单位）
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetVolumeGain(data: any): Promise<void> {
    try {
      const { gain } = data;
      logger.debug(`setting volume gain (linear): ${gain.toFixed(3)}`);
      this.digitalRadioEngine.setVolumeGain(gain);
    } catch (error) {
      this.handleCommandError(error, 'setVolumeGain', RadioErrorCode.AUDIO_DEVICE_ERROR);
    }
  }

  /**
   * 处理设置音量增益命令（dB单位）
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetVolumeGainDb(data: any): Promise<void> {
    try {
      const { gainDb } = data;
      logger.debug(`setting volume gain (dB): ${gainDb.toFixed(1)}dB`);
      this.digitalRadioEngine.setVolumeGainDb(gainDb);
    } catch (error) {
      this.handleCommandError(error, 'setVolumeGainDb', RadioErrorCode.AUDIO_DEVICE_ERROR);
    }
  }

  /**
   * 处理设置客户端启用操作员命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetClientEnabledOperators(connectionId: string, data: any): Promise<void> {
    try {
      const { enabledOperatorIds } = data;
      const connection = this.getConnection(connectionId);
      if (connection) {
        connection.setEnabledOperators(enabledOperatorIds);
        logger.debug(`connection ${connectionId} set enabled operators: [${enabledOperatorIds.join(', ')}]`);

        // 立即发送过滤后的操作员列表给该客户端
        const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        const filteredOperators = operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      }
    } catch (error) {
      this.handleCommandError(error, 'setClientEnabledOperators');
    }
  }

  /**
   * 处理手动重连电台命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleRadioManualReconnect(): Promise<void> {
    try {
      logger.debug('radio manual reconnect command received');

      const radioManager = this.digitalRadioEngine.getRadioManager();
      await radioManager.reconnect();

      logger.info('radio manual reconnect succeeded');

      // 广播最新的系统状态
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);

    } catch (error) {
      this.handleCommandError(error, 'radioManualReconnect', RadioErrorCode.CONNECTION_FAILED);

      // 广播电台断开状态，确保前端状态同步
      try {
        const radioManager = this.digitalRadioEngine.getRadioManager();
        const connectionHealth = radioManager.getConnectionHealth();

        this.broadcast(WSMessageType.RADIO_STATUS_CHANGED, {
          connected: false,
          status: RadioConnectionStatus.DISCONNECTED,
          reason: 'manual reconnect failed',
          radioInfo: null,
          radioConfig: radioManager.getConfig(),
          connectionHealth
        });
      } catch {}
    }
  }

  /**
   * 处理停止自动重连命令
   */
  private handleRadioStopReconnect(): void {
    logger.debug('stop reconnect command received');
    const radioManager = this.digitalRadioEngine.getRadioManager();
    radioManager.stopReconnect();
  }

  /**
   * 处理强制停止发射命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleForceStopTransmission(): Promise<void> {
    try {
      logger.debug('force stop transmission command received');

      await this.digitalRadioEngine.forceStopTransmission();

      logger.debug('force stop transmission completed');

      // PTT状态变化事件会自动通过 pttStatusChanged 广播

    } catch (error) {
      this.handleCommandError(error, 'forceStopTransmission', RadioErrorCode.PTT_ACTIVATION_FAILED);
    }
  }

  /**
   * 设置AudioMonitorService事件监听器（广播模式）
   * 支持延迟设置和自动重试
   */
  private setupAudioMonitorEventListeners(): void {
    // 如果已经设置过，直接返回
    if (this.audioMonitorListenersSetup) {
      return;
    }

    const audioMonitorService = this.digitalRadioEngine.getAudioMonitorService();
    if (!audioMonitorService) {
      logger.warn('AudioMonitorService not initialized, listeners will be set up when engine starts');
      return;
    }

    logger.info('setting up AudioMonitorService event listeners (broadcast mode)');

    // Initialize Opus encoder asynchronously
    createOpusMonitorEncoder(48000, 1).then((encoder) => {
      this.opusMonitorEncoder = encoder;
      if (encoder) {
        logger.info('Opus monitor encoder ready for audio broadcast');
      }
    }).catch((err) => {
      logger.warn('Failed to create Opus monitor encoder', err);
    });

    // 监听音频数据事件（广播给所有已连接的客户端）
    let audioDataCount = 0;
    audioMonitorService.on('audioData', (data) => {
      // 获取所有已连接的音频WebSocket客户端
      const clientIds = this.audioMonitorWSServer.getAllClientIds();

      if (clientIds.length === 0) {
        return; // 没有客户端连接，跳过广播
      }

      audioDataCount++;

      // 1. 广播元数据到所有控制WebSocket（JSON）
      this.broadcast(WSMessageType.AUDIO_MONITOR_DATA, {
        sampleRate: data.sampleRate,
        samples: data.samples,
        timestamp: data.timestamp
      });

      // 2. Determine codec path
      const useOpus =
        this.audioMonitorWSServer.getServerCodec() === 'opus' &&
        this.audioMonitorWSServer.hasOpusClients() &&
        this.opusMonitorEncoder;

      if (!useOpus) {
        // PCM path: send raw data directly
        clientIds.forEach((clientId: string) => {
          this.audioMonitorWSServer.sendAudioData(clientId, null, data.audioData);
        });
        return;
      }

      // Opus path: encode 960-sample frames
      const pcmFloat32 = new Float32Array(data.audioData);
      if (pcmFloat32.length === 0) return;

      if (audioDataCount === 1) {
        logger.info('First audio frame for Opus encoding', { samples: pcmFloat32.length });
      }

      const sendOpusFrame = (frame: Float32Array) => {
        const opusBuffer = this.opusMonitorEncoder!.encode(frame);
        const pcmFallback = frame.buffer as ArrayBuffer;
        clientIds.forEach((clientId: string) => {
          this.audioMonitorWSServer.sendAudioData(clientId, opusBuffer, pcmFallback);
        });
      };

      // Fast path: frame is exactly 960 samples and no leftover — skip accumulation
      if (this.opusAccumBuffer.length === 0 && pcmFloat32.length === this.OPUS_FRAME_SIZE) {
        sendOpusFrame(pcmFloat32);
        return;
      }

      // Slow path: accumulate partial frames
      const newBuf = new Float32Array(this.opusAccumBuffer.length + pcmFloat32.length);
      newBuf.set(this.opusAccumBuffer);
      newBuf.set(pcmFloat32, this.opusAccumBuffer.length);
      this.opusAccumBuffer = newBuf;

      while (this.opusAccumBuffer.length >= this.OPUS_FRAME_SIZE) {
        const frame = this.opusAccumBuffer.slice(0, this.OPUS_FRAME_SIZE);
        this.opusAccumBuffer = this.opusAccumBuffer.slice(this.OPUS_FRAME_SIZE);
        sendOpusFrame(frame);
      }
    });

    // 监听统计信息事件（广播给所有客户端）
    audioMonitorService.on('stats', (stats) => {
      this.broadcast(WSMessageType.AUDIO_MONITOR_STATS, stats);
    });

    // 标记监听器已成功设置
    this.audioMonitorListenersSetup = true;
    logger.info('AudioMonitor event listeners set up successfully');
  }

  /**
   * 处理客户端握手命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleClientHandshake(connectionId: string, data: any): Promise<void> {
    try {
      const { enabledOperatorIds } = data;
      const connection = this.getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection ${connectionId} does not exist`);
      }

      // 处理客户端发送的操作员偏好设置
      let requestedOperatorIds: string[];

      if (enabledOperatorIds === null) {
        // 新客户端：null表示没有本地偏好，默认启用所有操作员
        const allOperators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        requestedOperatorIds = allOperators.map(op => op.id);
        logger.debug(`new client ${connectionId}, enabling all operators by default: [${requestedOperatorIds.join(', ')}]`);
      } else {
        // 已配置的客户端：直接使用发送的列表（可能为空数组表示全部禁用）
        requestedOperatorIds = enabledOperatorIds;
        logger.debug(`configured client ${connectionId}, enabled operators: [${enabledOperatorIds.join(', ')}]`);
      }

      // 完成握手（带权限过滤：requestedIds ∩ authorizedOperatorIds）
      connection.completeHandshakeWithAuth(requestedOperatorIds);
      const finalEnabledOperatorIds = connection.getEnabledOperatorIds();

      // 广播客户端数量变化（新客户端握手完成）
      this.broadcastClientCount();

      // 阶段2: 发送过滤后的完整数据

      // 1. 发送过滤后的操作员列表
      try {
        const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        const filteredOperators = operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      } catch (error) {
        logger.error('failed to send operators list', error);
      }

      // 2. 发送最近的时隙包数据（如果有）
      try {
        const activeSlotPacks = this.digitalRadioEngine.getActiveSlotPacks();
        if (activeSlotPacks.length > 0) {
          // 发送最近的几个时隙包（最多10个）
          const recentSlotPacks = activeSlotPacks.slice(-10);
          for (const slotPack of recentSlotPacks) {
            connection.send(WSMessageType.SLOT_PACK_UPDATED, slotPack);
          }
        }
      } catch (error) {
        logger.error('failed to send slot pack data', error);
      }

      // 3. 发送握手完成消息
      connection.send('serverHandshakeComplete', {
        serverVersion: '1.0.0',
        supportedFeatures: ['operatorFiltering', 'handshakeProtocol'],
        finalEnabledOperatorIds: enabledOperatorIds === null ? finalEnabledOperatorIds : undefined // 新客户端需要保存最终的操作员列表
      });

      // 3.5 发送进程监控历史数据
      if (this.processMonitor) {
        connection.send(WSMessageType.PROCESS_SNAPSHOT_HISTORY, this.processMonitor.getHistoryPayload());
      }

      // 4. 如果引擎正在运行，发送额外的状态同步
      const status = this.digitalRadioEngine.getStatus();
      if (status.isRunning) {
        connection.send(WSMessageType.SYSTEM_STATUS, status);
        logger.debug(`sent running status sync to connection ${connectionId}`);
      }

      logger.info(`connection ${connectionId} handshake complete`);

    } catch (error) {
      this.handleCommandError(error, 'clientHandshake');
    }
  }

  // ===== 认证处理 =====

  /**
   * 处理客户端发送 JWT 进行认证
   */
  private async handleAuthToken(connectionId: string, data: any): Promise<void> {
    const connection = this.getConnection(connectionId);
    if (!connection) return;

    const { jwt } = data;
    if (!jwt) {
      connection.send(WSMessageType.AUTH_RESULT, { success: false, error: 'missing_jwt' });
      return;
    }

    try {
      const authManager = AuthManager.getInstance();

      // 使用 @fastify/jwt 的验证逻辑无法直接在 WS 层使用，手动验证
      // 简单导入 jsonwebtoken 来验证
      const { default: fjwt } = await import('fast-jwt');
      const verifier = fjwt.createVerifier({ key: authManager.getJwtSecret() });
      const decoded = verifier(jwt) as JWTPayload;

      // 检查引用的 token 是否仍有效
      if (!authManager.isTokenStillValid(decoded.tokenId)) {
        connection.send(WSMessageType.AUTH_RESULT, { success: false, error: 'token_revoked_or_expired' });
        return;
      }

      // 获取最新权限
      const perms = authManager.getTokenCurrentPermissions(decoded.tokenId);
      if (!perms) {
        connection.send(WSMessageType.AUTH_RESULT, { success: false, error: 'token_invalid' });
        return;
      }

      const tokenInfo = authManager.getTokenById(decoded.tokenId);
      const label = tokenInfo?.label || '';

      // 更新连接的认证状态
      const wasAuthenticated = connection.isAuthenticated();
      connection.setAuthenticated(perms.role, perms.operatorIds, label, decoded.tokenId);

      connection.send(WSMessageType.AUTH_RESULT, {
        success: true,
        role: perms.role,
        label,
        operatorIds: perms.operatorIds,
      });

      // 如果是在线升级（之前已经握手完成），重新发送操作员列表
      if (wasAuthenticated || connection.isHandshakeCompleted()) {
        // 重新应用权限过滤（hasOperatorAccess 会懒查询最新权限）
        const allOperators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        const visibleOps = perms.role === UserRole.ADMIN
          ? allOperators
          : allOperators.filter(op => connection.hasOperatorAccess(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: visibleOps });
      }

      logger.info(`connection ${connectionId} authenticated: ${label} (${perms.role})`);
    } catch (error) {
      logger.error('JWT verification failed', { connectionId, error });
      connection.send(WSMessageType.AUTH_RESULT, { success: false, error: 'jwt_invalid_or_expired' });
    }
  }

  /**
   * 处理客户端选择公开观察者模式
   */
  private handleAuthPublicViewer(connectionId: string): void {
    const connection = this.getConnection(connectionId);
    if (!connection) return;

    const authManager = AuthManager.getInstance();
    if (!authManager.isPublicViewingAllowed()) {
      connection.send(WSMessageType.AUTH_RESULT, { success: false, error: 'public_view_not_allowed' });
      connection.close();
      return;
    }

    connection.setPublicViewer();
    connection.send(WSMessageType.AUTH_RESULT, {
      success: true,
      role: UserRole.VIEWER,
      label: 'public viewer',
      operatorIds: [],
    });

    logger.info(`connection ${connectionId} entered public viewer mode`);
  }

  /**
   * 清理所有连接
   */
  cleanup(): void {
    logger.info('cleaning up all WebSocket connections');
    this.connections.forEach(connection => {
      connection.close();
    });
    this.connections.clear();
  }

  /**
   * 获取连接统计信息
   */
  getStats() {
    const total = this.connections.size;
    const active = this.getActiveConnections().length;
    return {
      total,
      active,
      inactive: total - active
    };
  }
}
