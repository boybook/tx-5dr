/* eslint-disable @typescript-eslint/no-explicit-any */
// WebSocket服务器 - 事件处理和消息传递需要使用any类型以保持灵活性

import { ServerMessageKey, WSMessageType, RadioConnectionStatus, UserRole, type AppAction, type AppSubject } from '@tx5dr/contracts';
import type {
  ClockStatusSummary,
  DecodeErrorInfo,
  FrameMessage,
  JWTPayload,
  ModeDescriptor,
  SlotInfo,
  SlotPack,
  SpectrumCapabilities,
  SpectrumFrame,
  SpectrumKind,
  SubWindowInfo,
  SystemStatus
} from '@tx5dr/contracts';
import { FT8MessageParser, WSMessageHandler } from '@tx5dr/core';
import { getBandFromFrequency } from '@tx5dr/core';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { ProcessMonitor } from '../services/ProcessMonitor.js';
import { globalEventBus } from '../utils/EventBus.js';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';
import { OpenWebRXStationManager } from '../openwebrx/OpenWebRXStationManager.js';
import { AuthManager } from '../auth/AuthManager.js';
import { buildAbility, emptyAbility, canWithData, type AppAbility } from '../auth/ability.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { SpectrumCoordinator } from '../spectrum/SpectrumCoordinator.js';
import { SpectrumSessionCoordinator } from '../spectrum/SpectrumSessionCoordinator.js';
import { buildRadioStatusPayload } from '../radio/buildRadioStatusPayload.js';
import { OperatorScopedSlotPackProjectionService } from './OperatorScopedSlotPackProjectionService.js';

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
  close(code?: number, reason?: string): void;
  readyState: number;
}

export class WSConnection extends WSMessageHandler {
  private ws: WebSocketInstance; // WebSocket实例(支持不同的WebSocket库)
  private id: string;
  private clientInstanceId: string | null = null;
  private enabledOperatorIds: Set<string> = new Set(); // 客户端启用的操作员ID列表
  private selectedOperatorId: string | null = null;
  private handshakeCompleted: boolean = false; // 握手是否完成

  // 认证状态
  private authenticated: boolean = false;
  private userRole: UserRole | null = null;
  private authorizedOperatorIds: Set<string> = new Set(); // Token 授予的操作员权限
  private authLabel: string = '';
  private tokenId: string | null = null; // 用于懒查询最新权限
  private ability: AppAbility = emptyAbility();

  // 记录WebSocket事件监听器,用于清理 (修复内存泄漏)
  private wsListeners: Map<string, (...args: unknown[]) => void> = new Map();
  private spectrumSubscription: SpectrumKind | null = null;

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
  close(code?: number, reason?: string): void {
    // 移除所有WebSocket事件监听器 (修复内存泄漏)
    logger.debug(`removing ${this.wsListeners.size} WebSocket listeners for connection ${this.id}`);
    for (const [eventName, handler] of this.wsListeners.entries()) {
      this.ws.off(eventName, handler);
    }
    this.wsListeners.clear();

    // 关闭WebSocket连接
    this.ws.close(code, reason);
  }

  /**
   * 获取连接ID
   */
  getId(): string {
    return this.id;
  }

  setClientInstanceId(clientInstanceId: string): void {
    this.clientInstanceId = clientInstanceId;
  }

  getClientInstanceId(): string | null {
    return this.clientInstanceId;
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

  setSelectedOperatorId(operatorId: string | null): void {
    this.selectedOperatorId = operatorId;
  }

  getSelectedOperatorId(): string | null {
    return this.selectedOperatorId;
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

  setSpectrumSubscription(kind: SpectrumKind | null): void {
    this.spectrumSubscription = kind;
  }

  getSpectrumSubscription(): SpectrumKind | null {
    return this.spectrumSubscription;
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
    // Build CASL ability with latest permissions
    const authManager = AuthManager.getInstance();
    const perms = tokenId ? authManager.getTokenCurrentPermissions(tokenId) : null;
    this.ability = buildAbility({
      role,
      operatorIds,
      permissionGrants: perms?.permissionGrants,
    });
    logger.debug(`connection ${this.id} authenticated: role=${role}, label=${label}, operators=[${operatorIds.join(', ')}]`);
  }

  /**
   * 设置为公开观察者（未认证但允许查看）
   */
  setPublicViewer(): void {
    this.authenticated = false;
    this.userRole = UserRole.VIEWER;
    this.authorizedOperatorIds = new Set();
    this.authLabel = 'public viewer';
    this.ability = buildAbility({ role: UserRole.VIEWER });
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
    this.ability = buildAbility({ role: UserRole.ADMIN });
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

  /**
   * CASL ability check with lazy refresh from AuthManager
   */
  canPerform(action: AppAction, subject: AppSubject, data?: Record<string, unknown>): boolean {
    // Lazy refresh: rebuild ability from latest token permissions
    if (this.tokenId) {
      const authManager = AuthManager.getInstance();
      const perms = authManager.getTokenCurrentPermissions(this.tokenId);
      if (perms) {
        this.ability = buildAbility({
          role: perms.role,
          operatorIds: perms.operatorIds,
          permissionGrants: perms.permissionGrants,
        });
      }
    }
    return data
      ? canWithData(this.ability, action as string, subject as string, data)
      : this.ability.can(action as string, subject as string);
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
export class WSServer extends WSMessageHandler {
  private static instance: WSServer | null = null;
  private connections = new Map<string, WSConnection>();
  private clientInstanceConnections = new Map<string, string>();
  private connectionIdCounter = 0;
  private digitalRadioEngine: DigitalRadioEngine;
  private processMonitor: ProcessMonitor | null = null;
  private spectrumCoordinator: SpectrumCoordinator;
  private spectrumSessionCoordinator: SpectrumSessionCoordinator;
  private slotPackProjectionService: OperatorScopedSlotPackProjectionService;
  private commandHandlers: Partial<Record<WSMessageType, (data: unknown, connectionId: string) => Promise<void> | void>>;

  static getInstance(): WSServer | null {
    return WSServer.instance;
  }

  constructor(digitalRadioEngine: DigitalRadioEngine, processMonitor?: ProcessMonitor) {
    super();
    WSServer.instance = this;
    this.digitalRadioEngine = digitalRadioEngine;
    if (processMonitor) {
      this.processMonitor = processMonitor;
      processMonitor.setBroadcastCallback((snapshot) => {
        this.broadcast(WSMessageType.PROCESS_SNAPSHOT, snapshot);
      });
    }
    this.spectrumCoordinator = new SpectrumCoordinator(digitalRadioEngine);
    this.spectrumSessionCoordinator = new SpectrumSessionCoordinator(digitalRadioEngine, this.spectrumCoordinator);
    this.slotPackProjectionService = new OperatorScopedSlotPackProjectionService({
      callsignTracker: digitalRadioEngine.callsignTracker,
      logManager: digitalRadioEngine.operatorManager.getLogManager(),
    });
    this.setupEngineEventListeners();
    this.setupOpenWebRXEventListeners();

    this.commandHandlers = {
      [WSMessageType.START_ENGINE]: () => this.handleStartEngine(),
      [WSMessageType.STOP_ENGINE]: () => this.handleStopEngine(),
      [WSMessageType.GET_STATUS]: () => this.handleGetStatus(),
      [WSMessageType.SET_MODE]: (data) => this.handleSetMode((data as any)?.mode),
      [WSMessageType.GET_PLUGIN_RUNTIME_LOG_HISTORY]: (data, id) => this.handleGetPluginRuntimeLogHistory(id, data),
      [WSMessageType.SUBSCRIBE_SPECTRUM]: (data, id) => this.handleSubscribeSpectrum(id, data),
      [WSMessageType.INVOKE_SPECTRUM_CONTROL]: (data: unknown, id: string) => this.handleInvokeSpectrumControl(id, data),
      [WSMessageType.GET_OPERATORS]: () => this.handleGetOperators(),
      [WSMessageType.SET_OPERATOR_CONTEXT]: (data, id) => this.handleSetOperatorContext(data, id),
      [WSMessageType.SET_OPERATOR_RUNTIME_STATE]: (data, id) => this.handleSetOperatorRuntimeState(data, id),
      [WSMessageType.SET_OPERATOR_RUNTIME_SLOT_CONTENT]: (data, id) => this.handleSetOperatorRuntimeSlotContent(data, id),
      [WSMessageType.SET_OPERATOR_TRANSMIT_CYCLES]: (data, id) => this.handleSetOperatorTransmitCycles(data, id),
      [WSMessageType.START_OPERATOR]: (data, id) => this.handleStartOperator(data, id),
      [WSMessageType.STOP_OPERATOR]: (data, id) => this.handleStopOperator(data, id),
      [WSMessageType.OPERATOR_REQUEST_CALL]: (data, id) => this.handleOperatorRequestCall(data, id),
      [WSMessageType.PLUGIN_USER_ACTION]: (data, id) => this.handlePluginUserAction(data, id),
      [WSMessageType.PING]: (_data, id) => { this.sendToConnection(id, WSMessageType.PONG); },
      [WSMessageType.SET_VOLUME_GAIN]: (data) => this.handleSetVolumeGain(data),
      [WSMessageType.SET_VOLUME_GAIN_DB]: (data) => this.handleSetVolumeGainDb(data),
      [WSMessageType.SET_CLIENT_ENABLED_OPERATORS]: (data, id) => this.handleSetClientEnabledOperators(id, data),
      [WSMessageType.SET_CLIENT_SELECTED_OPERATOR]: (data, id) => this.handleSetClientSelectedOperator(id, data),
      [WSMessageType.CLIENT_HANDSHAKE]: (data, id) => this.handleClientHandshake(id, data),
      [WSMessageType.RADIO_MANUAL_RECONNECT]: () => this.handleRadioManualReconnect(),
      [WSMessageType.RADIO_STOP_RECONNECT]: () => this.handleRadioStopReconnect(),
      [WSMessageType.AUDIO_RETRY_NOW]: () => this.handleAudioRetryNow(),
      [WSMessageType.WRITE_RADIO_CAPABILITY]: (data, id) => this.handleWriteRadioCapability(id, data),
      [WSMessageType.REFRESH_RADIO_CAPABILITIES]: () => this.handleRefreshRadioCapabilities(),
      [WSMessageType.FORCE_STOP_TRANSMISSION]: () => this.handleForceStopTransmission(),
      [WSMessageType.REMOVE_OPERATOR_FROM_TRANSMISSION]: (data) => this.handleRemoveOperatorFromTransmission(data),
      [WSMessageType.AUTH_TOKEN]: (data, id) => this.handleAuthToken(id, data),
      [WSMessageType.AUTH_PUBLIC_VIEWER]: (_data, id) => this.handleAuthPublicViewer(id),
      [WSMessageType.VOICE_PTT_REQUEST]: (data, id) => this.handleVoicePttRequest(id, data),
      [WSMessageType.VOICE_PTT_RELEASE]: (_data, id) => this.handleVoicePttRelease(id),
      [WSMessageType.VOICE_SET_RADIO_MODE]: (data) => this.handleVoiceSetRadioMode(data),
      [WSMessageType.VOICE_KEYER_PLAY]: (data, id) => this.handleVoiceKeyerPlay(id, data),
      [WSMessageType.VOICE_KEYER_STOP]: () => this.handleVoiceKeyerStop(),
      [WSMessageType.OPENWEBRX_PROFILE_SELECT_RESPONSE]: async (data: any) => {
        const adapter = this.digitalRadioEngine.getOpenWebRXAudioAdapter();
        if (!adapter) {
          logger.warn('No OpenWebRX adapter available for profile verification');
          return;
        }
        const response = data as { requestId: string; profileId: string; targetFrequency: number };
        logger.info('Processing manual profile selection', {
          requestId: response.requestId,
          profileId: response.profileId,
        });
        const result = await adapter.verifyAndApplyProfile(response.profileId, response.targetFrequency);
        const profileName = adapter.getProfiles().find(p => p.id === response.profileId)?.name;
        this.broadcast(WSMessageType.OPENWEBRX_PROFILE_VERIFY_RESULT, {
          requestId: response.requestId,
          success: result.success,
          profileId: response.profileId,
          profileName,
          centerFreq: result.centerFreq,
          sampRate: result.sampRate,
          error: result.error,
        });
      },
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
      this.broadcastCurrentSlotSnapshot();
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

    this.spectrumCoordinator.on('frame', (frame) => {
      this.broadcastSpectrumFrame(frame);
    });

    this.spectrumCoordinator.on('capabilitiesChanged', (capabilities) => {
      this.broadcastSpectrumCapabilities(capabilities);
    });

    this.spectrumSessionCoordinator.on('stateChanged', () => {
      void this.broadcastSpectrumSessionStates();
    });

    this.digitalRadioEngine.on('decodeError', (errorInfo) => {
      this.broadcastDecodeError(errorInfo);
    });

    this.digitalRadioEngine.on('systemStatus', (status) => {
      this.broadcastSystemStatus(status);
    });

    this.digitalRadioEngine.getNtpCalibrationService().on('statusChanged', (status) => {
      this.broadcastClockStatusChanged(status);
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
      this.broadcastQSOToast(data.operatorId, data.qsoRecord, ServerMessageKey.QSO_LOGGED);
    });

    this.digitalRadioEngine.on('qsoRecordUpdated' as any, (data: { operatorId: string; logBookId: string; qsoRecord: any }) => {
      logger.debug('QSO record updated event received', { callsign: data.qsoRecord.callsign });
      this.broadcastQSORecordUpdated(data);
      this.broadcastQSOToast(data.operatorId, data.qsoRecord, ServerMessageKey.QSO_UPDATED);
    });

    // 监听日志本更新事件
    this.digitalRadioEngine.on('logbookUpdated' as any, (data: { logBookId: string; statistics: any; operatorId?: string }) => {
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

    // 监听电源操作进度事件
    this.digitalRadioEngine.on('radioPowerState', (data) => {
      logger.debug('radio power state event received', data);
      this.broadcast(WSMessageType.RADIO_POWER_STATE, data);
    });

    // 监听音频 sidecar 状态变化
    this.digitalRadioEngine.on('audioSidecarStatusChanged', (data) => {
      logger.debug('audio sidecar status changed event received', { status: data.status, retryAttempt: data.retryAttempt });
      this.broadcast(WSMessageType.AUDIO_SIDECAR_STATUS_CHANGED, data);
    });

    // 监听 rigctld 桥接状态变化，推送给客户端用于 UI 实时显示
    this.digitalRadioEngine.on('rigctldStatus' as any, (data: any) => {
      logger.debug('rigctld status event received');
      this.broadcast(WSMessageType.RIGCTLD_STATUS, data);
    });

    // 监听电台发射中断开连接事件
    this.digitalRadioEngine.on('radioDisconnectedDuringTransmission', (data) => {
      logger.debug('radio disconnected during transmission event received', data);
      this.broadcast(WSMessageType.RADIO_DISCONNECTED_DURING_TRANSMISSION, data);
    });

    this.digitalRadioEngine.on('realtimeConnectivityIssue' as any, (data: any) => {
      const issue = data as {
        code?: string;
        userMessage?: string;
        technicalDetails?: string;
        context?: Record<string, string>;
      };
      const key = issue.code === 'NO_AUDIO_TRACK'
        ? ServerMessageKey.REALTIME_NO_AUDIO
        : ServerMessageKey.REALTIME_BRIDGE_DOWN;
      this.broadcastTextMessage(
        'Realtime connectivity issue',
        issue.userMessage || 'Realtime voice service encountered an error',
        'danger',
        null,
        key,
        {
          details: issue.technicalDetails || issue.userMessage || 'Unknown realtime error',
          signalingUrl: issue.context?.signalingUrl || 'unknown',
          signalingPort: issue.context?.signalingPort || 'unknown',
          rtcTcpPort: issue.context?.rtcTcpPort || 'unknown',
          udpPortRange: issue.context?.udpPortRange || 'unknown',
        },
      );
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

    this.digitalRadioEngine.on('squelchStatusChanged', (data) => {
      this.broadcast(WSMessageType.SQUELCH_STATUS_CHANGED, data);
    });

    // 监听电台数值表数据事件（通过事件总线，优化路径）
    globalEventBus.on('bus:meterData', (data) => {
      // 数值表数据频率较高，使用静默广播（不打印日志）
      this.broadcast(WSMessageType.METER_DATA, data);
    });

    // 监听天线调谐器状态变化事件
    // 监听统一能力系统事件
    this.digitalRadioEngine.on('radioCapabilityList', (data: any) => {
      this.broadcast(WSMessageType.RADIO_CAPABILITY_LIST, data);
    });
    this.digitalRadioEngine.on('radioCapabilityChanged', (state: any) => {
      this.broadcast(WSMessageType.RADIO_CAPABILITY_CHANGED, state);
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

    this.digitalRadioEngine.on('voiceKeyerStatusChanged', (data) => {
      logger.debug('voice keyer status changed', data);
      this.broadcast(WSMessageType.VOICE_KEYER_STATUS_CHANGED, data);
    });
  }

  // CASL ability requirements for WebSocket commands
  private static readonly COMMAND_ABILITIES: Partial<Record<WSMessageType, { action: AppAction; subject: AppSubject }>> = {
    // Capability-based (delegatable from admin)
    [WSMessageType.START_ENGINE]: { action: 'execute', subject: 'Engine' },
    [WSMessageType.STOP_ENGINE]: { action: 'execute', subject: 'Engine' },
    [WSMessageType.SET_MODE]: { action: 'execute', subject: 'ModeSwitch' },
    [WSMessageType.RADIO_MANUAL_RECONNECT]: { action: 'execute', subject: 'RadioReconnect' },
    [WSMessageType.RADIO_STOP_RECONNECT]: { action: 'execute', subject: 'RadioReconnect' },
    [WSMessageType.AUDIO_RETRY_NOW]: { action: 'execute', subject: 'Engine' },
    [WSMessageType.FORCE_STOP_TRANSMISSION]: { action: 'execute', subject: 'Engine' },
    [WSMessageType.WRITE_RADIO_CAPABILITY]: { action: 'execute', subject: 'RadioControl' },
    [WSMessageType.REFRESH_RADIO_CAPABILITIES]: { action: 'execute', subject: 'RadioControl' },
    [WSMessageType.INVOKE_SPECTRUM_CONTROL]: { action: 'execute', subject: 'RadioControl' },
    [WSMessageType.OPENWEBRX_PROFILE_SELECT_RESPONSE]: { action: 'execute', subject: 'RadioFrequency' },
    // Operator-level commands (use Operator subject with conditions)
    [WSMessageType.SET_VOLUME_GAIN]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.SET_VOLUME_GAIN_DB]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.VOICE_PTT_REQUEST]: { action: 'manage', subject: 'Transmission' },
    [WSMessageType.VOICE_KEYER_PLAY]: { action: 'manage', subject: 'Transmission' },
    [WSMessageType.VOICE_KEYER_STOP]: { action: 'manage', subject: 'Transmission' },
    [WSMessageType.VOICE_SET_RADIO_MODE]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.START_OPERATOR]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.STOP_OPERATOR]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.SET_OPERATOR_CONTEXT]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.SET_OPERATOR_RUNTIME_STATE]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.SET_OPERATOR_RUNTIME_SLOT_CONTENT]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.SET_OPERATOR_TRANSMIT_CYCLES]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.OPERATOR_REQUEST_CALL]: { action: 'manage', subject: 'Operator' },
    [WSMessageType.REMOVE_OPERATOR_FROM_TRANSMISSION]: { action: 'manage', subject: 'Transmission' },
    [WSMessageType.PLUGIN_USER_ACTION]: { action: 'manage', subject: 'Operator' },
  };

  // Commands that need operatorId-level data for CASL condition checks
  private static readonly OPERATOR_DATA_COMMANDS = new Set([
    WSMessageType.START_OPERATOR,
    WSMessageType.STOP_OPERATOR,
    WSMessageType.SET_OPERATOR_CONTEXT,
    WSMessageType.SET_OPERATOR_RUNTIME_STATE,
    WSMessageType.SET_OPERATOR_RUNTIME_SLOT_CONTENT,
    WSMessageType.SET_OPERATOR_TRANSMIT_CYCLES,
    WSMessageType.OPERATOR_REQUEST_CALL,
    WSMessageType.REMOVE_OPERATOR_FROM_TRANSMISSION,
    WSMessageType.PLUGIN_USER_ACTION,
  ]);

  /**
   * 处理客户端命令（含 CASL 权限检查）
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

    // CASL ability check
    const required = WSServer.COMMAND_ABILITIES[msgType];
    if (required) {
      // For operator-level commands, include operatorId in CASL data for condition matching
      if (WSServer.OPERATOR_DATA_COMMANDS.has(msgType)) {
        const data = message.data as any;
        const operatorId = data?.operatorId;
        if (operatorId) {
          const conditionKey = required.subject === 'Transmission' ? 'operatorId' : 'id';
          if (!connection.canPerform(required.action, required.subject, { [conditionKey]: operatorId })) {
            connection.send(WSMessageType.ERROR, {
              message: 'no_operator_access',
              code: 'FORBIDDEN',
              details: { operatorId },
            });
            return;
          }
        }
      } else if (!connection.canPerform(required.action, required.subject)) {
        connection.send(WSMessageType.ERROR, {
          message: 'insufficient_permission',
          code: 'FORBIDDEN',
          details: { command: message.type },
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
   * Audit log helper for operator-mutating WS commands.
   * Records connectionId, clientInstanceId, role, label, tokenId so that
   * any state change can be traced back to the originating client.
   * Kept at info level — these are low-frequency user actions.
   */
  private logOperatorCommand(
    commandName: string,
    connectionId: string,
    payload: { operatorId?: string; [key: string]: unknown },
  ): void {
    const conn = this.getConnection(connectionId);
    logger.info(`WS command: ${commandName}`, {
      connectionId,
      clientInstanceId: conn?.getClientInstanceId() ?? null,
      role: conn?.getUserRole() ?? null,
      label: conn?.getAuthLabel() ?? '',
      tokenId: conn?.getTokenId() ?? null,
      ...payload,
    });
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
      userMessageKey: radioError.userMessageKey,
      userMessageParams: radioError.userMessageParams,
      code: radioError.code,
      severity: radioError.severity,
      suggestions: radioError.suggestions,
      timestamp: radioError.timestamp,
      context: { ...(radioError.context ?? {}), command: commandName }
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
    this.broadcastClockStatusChanged(this.digitalRadioEngine.getNtpCalibrationService().getBroadcastStatus());
  }

  private handleGetPluginRuntimeLogHistory(connectionId: string, data: unknown): void {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    const requestedLimit = (data as { limit?: unknown } | undefined)?.limit;
    const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
      ? requestedLimit
      : undefined;
    const entries = this.digitalRadioEngine.pluginManager.getRuntimeLogHistory(limit);
    connection.send(WSMessageType.PLUGIN_RUNTIME_LOG_HISTORY, { entries });
  }

  private async handleSubscribeSpectrum(connectionId: string, data: unknown): Promise<void> {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    const requestedKind = (data as { kind?: SpectrumKind | null } | undefined)?.kind ?? null;
    const capabilities = await this.spectrumCoordinator.getCapabilities();
    const requestedSource = requestedKind
      ? capabilities.sources.find(source => source.kind === requestedKind)
      : null;

    const effectiveKind = requestedKind && requestedSource?.available ? requestedKind : null;

    await this.spectrumCoordinator.setConnectionSubscription(connectionId, effectiveKind);
    connection.setSpectrumSubscription(effectiveKind);

    if (requestedKind && effectiveKind === null) {
      connection.send(WSMessageType.SPECTRUM_CAPABILITIES, capabilities);
    }

    await this.sendSpectrumSessionStateToConnection(connection);
  }

  private async handleInvokeSpectrumControl(connectionId: string, data: unknown): Promise<void> {
    const connection = this.getConnection(connectionId);
    if (!connection) {
      return;
    }

    const id = (data as { id?: string } | undefined)?.id;
    const action = (data as { action?: 'in' | 'out' | 'toggle' } | undefined)?.action;
    if (!id || (action !== 'in' && action !== 'out' && action !== 'toggle')) {
      this.sendToConnection(connectionId, WSMessageType.ERROR, {
        message: 'invokeSpectrumControl: invalid control payload',
      });
      return;
    }

    try {
      await this.spectrumSessionCoordinator.invokeControl(connection.getSpectrumSubscription(), id, action);
      await this.sendSpectrumSessionStateToConnection(connection);
    } catch (error) {
      logger.warn('invokeSpectrumControl failed', error);
      this.sendToConnection(connectionId, WSMessageType.ERROR, {
        message: `Failed to invoke spectrum control: ${(error as Error).message}`,
      });
    }
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
  private async handleSetOperatorContext(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId, context } = data;
      this.logOperatorCommand('setOperatorContext', connectionId, { operatorId, context });
      await this.digitalRadioEngine.operatorManager.updateOperatorContext(operatorId, context);
    } catch (error) {
      this.handleCommandError(error, 'setOperatorContext');
    }
  }

  /**
   * 处理设置操作员策略运行时状态命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetOperatorRuntimeState(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId, state } = data;
      this.logOperatorCommand('setOperatorRuntimeState', connectionId, { operatorId, requestedState: state });
      this.digitalRadioEngine.operatorManager.setOperatorRuntimeState(operatorId, state);
    } catch (error) {
      this.handleCommandError(error, 'setOperatorRuntimeState');
    }
  }

  /**
   * 处理设置操作员策略运行时槽位内容命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleSetOperatorRuntimeSlotContent(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId, slot, content } = data;
      this.logOperatorCommand('setOperatorRuntimeSlotContent', connectionId, { operatorId, slot, content });
      this.digitalRadioEngine.operatorManager.setOperatorRuntimeSlotContent(operatorId, slot, content);
    } catch (error) {
      this.handleCommandError(error, 'setOperatorRuntimeSlotContent');
    }
  }

  /**
   * 处理设置操作员发射周期命令
   */
  private async handleSetOperatorTransmitCycles(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId, transmitCycles } = data;
      this.logOperatorCommand('setOperatorTransmitCycles', connectionId, { operatorId, transmitCycles });
      await this.digitalRadioEngine.operatorManager.setOperatorTransmitCycles(operatorId, transmitCycles);
    } catch (error) {
      this.handleCommandError(error, 'setOperatorTransmitCycles');
    }
  }

  private async handlePluginUserAction(data: any, connectionId: string): Promise<void> {
    try {
      const { pluginName, actionId, operatorId, payload } = data ?? {};
      this.logOperatorCommand('pluginUserAction', connectionId, { operatorId, pluginName, actionId });
      this.digitalRadioEngine.pluginManager.handlePluginUserAction(
        pluginName,
        actionId,
        operatorId,
        payload,
      );
    } catch (error) {
      this.handleCommandError(error, 'pluginUserAction');
    }
  }

  /**
   * 处理启动操作员命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleStartOperator(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId } = data;
      this.logOperatorCommand('startOperator', connectionId, { operatorId });
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
  private async handleStopOperator(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId } = data;
      this.logOperatorCommand('stopOperator', connectionId, { operatorId });
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
  private async handleOperatorRequestCall(data: any, connectionId: string): Promise<void> {
    try {
      const { operatorId, callsign, selectedFrame } = data;
      this.logOperatorCommand('operatorRequestCall', connectionId, {
        operatorId,
        callsign,
        selectedFrameMessage: selectedFrame?.message ?? null,
        selectedFrameSlotStartMs: selectedFrame?.slotStartMs ?? null,
      });
      const operator = this.digitalRadioEngine.operatorManager.getOperator(operatorId);
      if (!operator) {
        throw new Error(`Operator ${operatorId} does not exist`);
      }
      const currentMode = this.digitalRadioEngine.getStatus().currentMode;
      const lastMessage = selectedFrame
        ? {
            message: {
              message: selectedFrame.message,
              snr: selectedFrame.snr,
              dt: selectedFrame.dt,
              freq: selectedFrame.freq,
              confidence: 1,
            } as FrameMessage,
            slotInfo: {
              id: `manual-${selectedFrame.slotStartMs}`,
              startMs: selectedFrame.slotStartMs,
              phaseMs: 0,
              driftMs: 0,
              cycleNumber: Math.floor(selectedFrame.slotStartMs / currentMode.slotMs) % 2,
              utcSeconds: Math.floor(selectedFrame.slotStartMs / 1000),
              mode: currentMode.name,
            } as SlotInfo,
          }
        : this.digitalRadioEngine.getSlotPackManager().getLastMessageFromCallsign(callsign, operatorId);
      this.digitalRadioEngine.pluginManager.requestCall(operatorId, callsign, lastMessage);
      this.digitalRadioEngine.operatorManager.emitOperatorStatusUpdate(operatorId);
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
      const lock = voiceSessionManager.getPTTLockState();
      if (lock.locked && typeof lock.lockedBy === 'string' && lock.lockedBy.startsWith('voice-keyer:')) {
        await this.digitalRadioEngine.getVoiceKeyerManager()?.preemptForManualPtt();
      }
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

  private async handleVoiceKeyerPlay(connectionId: string, data: any): Promise<void> {
    try {
      const manager = this.digitalRadioEngine.getVoiceKeyerManager();
      if (!manager) {
        throw new Error('Voice keyer manager not available');
      }

      const connection = this.getConnection(connectionId);
      const label = connection?.getAuthLabel() || connectionId;
      const callsign = String(data?.callsign || '');
      const slotId = String(data?.slotId || '');
      if (!callsign || !slotId) {
        throw new Error('callsign and slotId are required');
      }

      await manager.play({
        callsign,
        slotId,
        repeat: Boolean(data?.repeat),
        startImmediately: data?.startImmediately !== false,
        connectionId,
        label,
      });
    } catch (error) {
      this.handleCommandError(error, 'voiceKeyerPlay');
    }
  }

  private async handleVoiceKeyerStop(): Promise<void> {
    try {
      await this.digitalRadioEngine.getVoiceKeyerManager()?.stopActive('stopped by client');
    } catch (error) {
      this.handleCommandError(error, 'voiceKeyerStop');
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
    connection.send(
      WSMessageType.CLOCK_STATUS_CHANGED,
      this.digitalRadioEngine.getNtpCalibrationService().getBroadcastStatus(),
    );

    // 2. 发送当前模式信息
    connection.send(WSMessageType.MODE_CHANGED, status.currentMode);

    // 2.1 发送当前频率信息，避免客户端在首次进入时错过服务端启动阶段的切频广播
    const initialFrequencyState = this.buildInitialFrequencyState(status);
    if (initialFrequencyState) {
      connection.send(WSMessageType.FREQUENCY_CHANGED, initialFrequencyState);
    }

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

    // 3.5 发送当前实际静噪状态
    try {
      connection.send(WSMessageType.SQUELCH_STATUS_CHANGED, this.digitalRadioEngine.getSquelchStatus());
    } catch (error) {
      logger.error('failed to send squelch status', error);
    }

    // 4. 发送当前电台连接状态（确保前端获取 connecting/reconnecting 等中间状态）
    try {
      const radioManager = this.digitalRadioEngine.getRadioManager();
      const radioConnectionStatus = radioManager.getConnectionStatus();
      connection.send(WSMessageType.RADIO_STATUS_CHANGED, buildRadioStatusPayload({
        connected: radioManager.isConnected(),
        status: radioConnectionStatus,
        radioInfo: null,
        radioManager,
      }));
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
  removeConnection(id: string, options: { closeSocket?: boolean; closeCode?: number; closeReason?: string } = {}): void {
    const connection = this.connections.get(id);
    if (connection) {
      const clientInstanceId = connection.getClientInstanceId();
      if (clientInstanceId && this.clientInstanceConnections.get(clientInstanceId) === id) {
        this.clientInstanceConnections.delete(clientInstanceId);
      }

      connection.removeAllListeners();
      this.connections.delete(id);
      void this.spectrumCoordinator.removeConnection(id);
      logger.info('connection disconnected', {
        id,
        clientInstanceId,
        spectrumSubscription: connection.getSpectrumSubscription(),
        closeSocket: options.closeSocket ?? false,
      });

      if (options.closeSocket) {
        try {
          connection.close(options.closeCode, options.closeReason);
        } catch (error) {
          logger.warn('failed to close replaced websocket connection', {
            id,
            clientInstanceId,
            error,
          });
        }
      }

      // Auto-release voice PTT if this client held it
      const voiceSessionManager = this.digitalRadioEngine.getVoiceSessionManager();
      if (voiceSessionManager) {
        voiceSessionManager.handleClientDisconnect(id).catch((err) => {
          logger.error('failed to handle voice client disconnect', err);
        });
      }
      const voiceKeyerManager = this.digitalRadioEngine.getVoiceKeyerManager();
      if (voiceKeyerManager) {
        voiceKeyerManager.handleClientDisconnect(id).catch((err) => {
          logger.error('failed to handle voice keyer client disconnect', err);
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

  private buildInitialFrequencyState(status: SystemStatus): {
    frequency: number;
    mode: string;
    band: string;
    description: string;
    radioMode?: string;
    radioConnected: boolean;
    source: 'program' | 'radio';
  } | null {
    const radioManager = this.digitalRadioEngine.getRadioManager();
    const configManager = ConfigManager.getInstance();
    const engineMode = this.digitalRadioEngine.getEngineMode();
    const savedFrequency = engineMode === 'voice'
      ? configManager.getLastVoiceFrequency()
      : configManager.getLastSelectedFrequency();
    const knownFrequency = radioManager.getKnownFrequency();
    const frequency = knownFrequency ?? savedFrequency?.frequency ?? null;

    if (typeof frequency !== 'number' || !Number.isFinite(frequency) || frequency <= 0) {
      return null;
    }

    const mode = engineMode === 'voice'
      ? 'VOICE'
      : (savedFrequency?.frequency === frequency && 'mode' in (savedFrequency ?? {})
          ? (savedFrequency as { mode?: string }).mode || status.currentMode.name
          : status.currentMode.name);
    const band = savedFrequency?.frequency === frequency
      ? (savedFrequency.band || this.resolveBandLabel(frequency))
      : this.resolveBandLabel(frequency);
    const description = savedFrequency?.frequency === frequency
      ? (savedFrequency.description || `${(frequency / 1000000).toFixed(3)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`)
      : `${(frequency / 1000000).toFixed(3)} MHz${band !== 'Unknown' ? ` ${band}` : ''}`;

    return {
      frequency,
      mode,
      band,
      description,
      radioMode: savedFrequency?.radioMode,
      radioConnected: radioManager.isConnected(),
      source: radioManager.isConnected() ? 'radio' : 'program',
    };
  }

  private resolveBandLabel(frequency: number): string {
    try {
      return getBandFromFrequency(frequency);
    } catch {
      return 'Unknown';
    }
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
   * 向单个新连接补发当前时隙快照，用于处理中途打开页面的进度同步。
   */
  private sendCurrentSlotSnapshot(connection: WSConnection): void {
    const slotInfo = this.digitalRadioEngine.getCurrentSlotInfo();
    if (!slotInfo) {
      return;
    }

    connection.send(WSMessageType.SLOT_START, slotInfo);
  }

  /**
   * 广播当前时隙快照，用于模式切换后立即同步新的 slotMs/phase。
   */
  private broadcastCurrentSlotSnapshot(): void {
    const slotInfo = this.digitalRadioEngine.getCurrentSlotInfo();
    if (!slotInfo) {
      return;
    }

    this.broadcastSlotStart(slotInfo);
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
    const selectedOperatorId = connection.getSelectedOperatorId();
    const projectedSlotPack = await this.slotPackProjectionService.projectSlotPack(
      slotPack,
      selectedOperatorId,
    );
    const myOperatorCallsigns = this.getSelectedOperatorCallsigns(selectedOperatorId);
    if (myOperatorCallsigns.size === 0) {
      return projectedSlotPack;
    }

    const filteredFrames = projectedSlotPack.frames.filter((frame) => {
      if (frame.snr === -999) {
        return true;
      }

      try {
        const parsedMessage = FT8MessageParser.parseMessage(frame.message);
        const senderCallsign = 'senderCallsign' in parsedMessage
          ? parsedMessage.senderCallsign
          : undefined;
        if (senderCallsign && myOperatorCallsigns.has(senderCallsign.toUpperCase())) {
          logger.debug(`filtered own message for connection ${connection.getId()}: "${frame.message}" (${senderCallsign})`);
          return false;
        }
      } catch (error) {
        logger.warn(`failed to parse message for filtering: "${frame.message}"`, error);
      }

      return true;
    });

    return {
      ...projectedSlotPack,
      frames: filteredFrames,
    };
  }

  private getSelectedOperatorCallsigns(selectedOperatorId: string | null): Set<string> {
    const myOperatorCallsigns = new Set<string>();
    if (!selectedOperatorId) {
      return myOperatorCallsigns;
    }

    const operator = this.digitalRadioEngine.operatorManager.getOperator(selectedOperatorId);
    if (operator?.config.myCallsign) {
      myOperatorCallsigns.add(operator.config.myCallsign.toUpperCase());
    }

    return myOperatorCallsigns;
  }

  private getVisibleOperatorIds(connection: WSConnection): string[] {
    return this.digitalRadioEngine.operatorManager.getOperatorsStatus()
      .filter((operator) => connection.isOperatorEnabled(operator.id))
      .map((operator) => operator.id);
  }

  private resolveSelectedOperatorId(
    connection: WSConnection,
    requestedSelectedOperatorId: string | null | undefined,
  ): string | null {
    const visibleOperatorIds = this.getVisibleOperatorIds(connection);
    if (requestedSelectedOperatorId && visibleOperatorIds.includes(requestedSelectedOperatorId)) {
      return requestedSelectedOperatorId;
    }
    return visibleOperatorIds[0] ?? null;
  }

  private sendFilteredOperatorsList(connection: WSConnection): void {
    const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
    const filteredOperators = operators.filter((operator) => connection.isOperatorEnabled(operator.id));
    connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
  }

  private async sendProjectedRecentSlotPacks(
    connection: WSConnection,
    options?: { reset?: boolean; limit?: number },
  ): Promise<void> {
    const { reset = false, limit = 50 } = options ?? {};
    if (reset) {
      connection.send(WSMessageType.SLOT_PACKS_RESET, { phase: 'start' });
    }

    try {
      const activeSlotPacks = this.digitalRadioEngine.getActiveSlotPacks();
      if (activeSlotPacks.length === 0) {
        return;
      }

      const recentSlotPacks = activeSlotPacks.slice(-limit);
      for (const slotPack of recentSlotPacks) {
        const customizedSlotPack = await this.customizeSlotPackForClient(connection, slotPack);
        connection.send(WSMessageType.SLOT_PACK_UPDATED, customizedSlotPack);
      }
    } finally {
      if (reset) {
        connection.send(WSMessageType.SLOT_PACKS_RESET, { phase: 'complete' });
      }
    }
  }

  broadcastSpectrumCapabilities(capabilities: SpectrumCapabilities): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
    activeConnections.forEach(connection => {
      connection.send(WSMessageType.SPECTRUM_CAPABILITIES, capabilities);
    });
  }

  broadcastSpectrumFrame(frame: SpectrumFrame): void {
    const targetConnectionIds = this.spectrumCoordinator.getSubscribedConnectionIds(frame.kind);
    for (const connectionId of targetConnectionIds) {
      this.sendToConnection(connectionId, WSMessageType.SPECTRUM_FRAME, frame);
    }
  }

  private async sendSpectrumSessionStateToConnection(connection: WSConnection): Promise<void> {
    try {
      const state = await this.spectrumSessionCoordinator.refresh(connection.getSpectrumSubscription());
      connection.send(WSMessageType.SPECTRUM_SESSION_STATE_CHANGED, state);
    } catch (error) {
      logger.warn('failed to send spectrum session state', error);
    }
  }

  private async broadcastSpectrumSessionStates(): Promise<void> {
    const activeConnections = this.getActiveConnections().filter(connection => connection.isHandshakeCompleted());
    await Promise.all(activeConnections.map(connection => this.sendSpectrumSessionStateToConnection(connection)));
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
   * 广播时钟状态摘要事件
   */
  broadcastClockStatusChanged(status: ClockStatusSummary): void {
    this.broadcast(WSMessageType.CLOCK_STATUS_CHANGED, status);
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
   * 广播QSO记录更新事件
   */
  broadcastQSORecordUpdated(data: { operatorId: string; logBookId: string; qsoRecord: any }): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());

    activeConnections.forEach(connection => {
      if (connection.isOperatorEnabled(data.operatorId)) {
        connection.send(WSMessageType.QSO_RECORD_UPDATED, data);
      }
    });

    const targetConnections = activeConnections.filter(conn => conn.isOperatorEnabled(data.operatorId));
    logger.debug(`sent QSO record updated event to ${targetConnections.length} clients with operator ${data.operatorId} enabled`, { callsign: data.qsoRecord.callsign });
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

  private broadcastQSOToast(operatorId: string, qso: any, key: ServerMessageKey.QSO_LOGGED | ServerMessageKey.QSO_UPDATED): void {
    try {
      const mhz = (qso.frequency / 1_000_000).toFixed(3);
      const reportSent = qso.reportSent || '--';
      const reportReceived = qso.reportReceived || '--';
      const summaryParts = [qso.callsign];
      if (qso.grid) {
        summaryParts.push(qso.grid);
      }
      summaryParts.push(`${mhz} MHz`);
      summaryParts.push(qso.mode);
      if (qso.reportSent || qso.reportReceived) {
        summaryParts.push(`${reportSent}/${reportReceived}`);
      }

      const summary = summaryParts.join(' • ');
      const title = key === ServerMessageKey.QSO_UPDATED ? 'QSO Updated' : 'QSO Logged';
      this.broadcastOperatorTextMessage(
        operatorId,
        title,
        summary,
        'success',
        3500,
        key,
        { summary }
      );
    } catch (error) {
      logger.warn('failed to send QSO toast', error);
    }
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
        const selectedOperatorId = this.resolveSelectedOperatorId(
          connection,
          connection.getSelectedOperatorId(),
        );
        connection.setSelectedOperatorId(selectedOperatorId);
        logger.debug(`connection ${connectionId} set enabled operators: [${enabledOperatorIds.join(', ')}]`);

        this.sendFilteredOperatorsList(connection);
        await this.sendProjectedRecentSlotPacks(connection, { reset: true });
      }
    } catch (error) {
      this.handleCommandError(error, 'setClientEnabledOperators');
    }
  }

  private async handleSetClientSelectedOperator(connectionId: string, data: any): Promise<void> {
    try {
      const connection = this.getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection ${connectionId} does not exist`);
      }

      const nextSelectedOperatorId = this.resolveSelectedOperatorId(
        connection,
        data?.selectedOperatorId ?? null,
      );
      if (nextSelectedOperatorId === connection.getSelectedOperatorId()) {
        return;
      }

      connection.setSelectedOperatorId(nextSelectedOperatorId);
      await this.sendProjectedRecentSlotPacks(connection, { reset: true });
    } catch (error) {
      this.handleCommandError(error, 'setClientSelectedOperator');
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

        this.broadcast(WSMessageType.RADIO_STATUS_CHANGED, buildRadioStatusPayload({
          connected: false,
          status: RadioConnectionStatus.DISCONNECTED,
          reason: 'manual reconnect failed',
          radioInfo: null,
          connectionHealth,
          radioManager,
        }));
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
   * 处理立即重试音频 sidecar 命令
   */
  private async handleAudioRetryNow(): Promise<void> {
    try {
      logger.debug('audio retry-now command received');
      await this.digitalRadioEngine.retryAudioSidecar();
    } catch (error) {
      logger.error('audio retry-now failed', error);
    }
  }

  /**
   * 处理写入电台能力命令
   * 权限: execute:RadioControl（由 COMMAND_ABILITIES 映射）
   */
  private async handleWriteRadioCapability(connectionId: string, data: unknown): Promise<void> {
    try {
      const payload = data as { id?: string; value?: boolean | number; action?: boolean };
      if (!payload?.id) {
        this.sendToConnection(connectionId, WSMessageType.ERROR, {
          message: 'writeRadioCapability: missing capability id',
        });
        return;
      }

      logger.info('writeRadioCapability command', { id: payload.id, value: payload.value, action: payload.action });

      const radioManager = this.digitalRadioEngine.getRadioManager();
      await radioManager.writeCapability(payload.id, payload.value, payload.action);
    } catch (error) {
      logger.error('writeRadioCapability failed', error);
      this.sendToConnection(connectionId, WSMessageType.ERROR, {
        message: `Failed to write capability: ${(error as Error).message}`,
      });
    }
  }

  /**
   * 处理刷新所有电台能力值命令
   * 权限: execute:RadioControl（由 COMMAND_ABILITIES 映射）
   */
  private async handleRefreshRadioCapabilities(): Promise<void> {
    try {
      logger.info('refreshRadioCapabilities command');
      const radioManager = this.digitalRadioEngine.getRadioManager();
      await radioManager.refreshCapabilities();
    } catch (error) {
      logger.error('refreshRadioCapabilities failed', error);
    }
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

  private async handleRemoveOperatorFromTransmission(data: any): Promise<void> {
    try {
      const operatorId = data?.operatorId;
      if (!operatorId) {
        logger.warn('removeOperatorFromTransmission: missing operatorId');
        return;
      }
      logger.debug('remove operator from transmission', { operatorId });
      await this.digitalRadioEngine.removeOperatorFromTransmission(operatorId);
    } catch (error) {
      this.handleCommandError(error, 'removeOperatorFromTransmission', RadioErrorCode.PTT_ACTIVATION_FAILED);
    }
  }

  private setupOpenWebRXEventListeners(): void {
    const stationManager = OpenWebRXStationManager.getInstance();
    stationManager.on('listenStatusChanged', (status) => {
      this.broadcast(WSMessageType.OPENWEBRX_LISTEN_STATUS, status);
    });

    // ===== 插件系统事件 =====
    this.digitalRadioEngine.on('pluginList' as any, (data: any) => {
      this.broadcast(WSMessageType.PLUGIN_LIST, data);
    });
    this.digitalRadioEngine.on('pluginStatusChanged' as any, (data: any) => {
      this.broadcast(WSMessageType.PLUGIN_STATUS_CHANGED, data);
    });
    this.digitalRadioEngine.on('pluginData' as any, (data: any) => {
      this.broadcast(WSMessageType.PLUGIN_DATA, data);
    });
    this.digitalRadioEngine.on('pluginLog' as any, (data: any) => {
      this.broadcast(WSMessageType.PLUGIN_LOG, data);
    });
    this.digitalRadioEngine.on('pluginRuntimeLog' as any, (data: any) => {
      this.broadcast(WSMessageType.PLUGIN_RUNTIME_LOG, data);
    });
    this.digitalRadioEngine.on('pluginPagePush', (data) => {
      this.broadcast(WSMessageType.PLUGIN_PAGE_PUSH, data);
    });
    this.digitalRadioEngine.on('pluginPanelMeta' as any, (data: any) => {
      this.broadcast(WSMessageType.PLUGIN_PANEL_META, data);
    });

    // Forward profile select requests from engine to clients
    this.digitalRadioEngine.on('openwebrxProfileSelectRequest' as any, (data: any) => {
      logger.info('OpenWebRX profile select required, broadcasting to clients', {
        requestId: data.requestId,
        targetFrequency: data.targetFrequency,
      });
      this.broadcast(WSMessageType.OPENWEBRX_PROFILE_SELECT_REQUEST, data);
    });

    // Forward OpenWebRX client count changes to frontend
    this.digitalRadioEngine.on('openwebrxClientCount' as any, (data: any) => {
      this.broadcast(WSMessageType.OPENWEBRX_CLIENT_COUNT, data);
    });

    // Forward OpenWebRX cooldown notices to frontend
    this.digitalRadioEngine.on('openwebrxCooldownNotice' as any, (data: any) => {
      this.broadcast(WSMessageType.OPENWEBRX_COOLDOWN_NOTICE, data);
    });
  }

  /**
   * 处理客户端握手命令
   * 📊 Day14优化：使用统一的错误处理方法
   */
  private async handleClientHandshake(connectionId: string, data: any): Promise<void> {
    try {
      const {
        enabledOperatorIds,
        selectedOperatorId,
        clientInstanceId,
      } = data;
      const connection = this.getConnection(connectionId);
      if (!connection) {
        throw new Error(`Connection ${connectionId} does not exist`);
      }
      if (!clientInstanceId || typeof clientInstanceId !== 'string') {
        throw new Error('clientInstanceId is required');
      }

      connection.setClientInstanceId(clientInstanceId);
      const existingConnectionId = this.clientInstanceConnections.get(clientInstanceId);
      if (existingConnectionId && existingConnectionId !== connectionId) {
        logger.warn('replacing stale websocket connection for client instance', {
          clientInstanceId,
          previousConnectionId: existingConnectionId,
          nextConnectionId: connectionId,
        });
        // Notify the old connection before closing so the client knows not to reconnect
        const existingConnection = this.connections.get(existingConnectionId);
        if (existingConnection) {
          try {
            existingConnection.send(WSMessageType.CONNECTION_REPLACED, {
              reason: 'replaced_by_new_connection',
            });
          } catch {
            // Best effort — the connection may already be broken
          }
        }
        this.removeConnection(existingConnectionId, { closeSocket: true, closeCode: 4001, closeReason: 'replaced' });
      }
      this.clientInstanceConnections.set(clientInstanceId, connectionId);

      // 处理客户端发送的操作员偏好设置
      let requestedOperatorIds: string[];

      if (enabledOperatorIds === null) {
        // 新客户端：null表示没有本地偏好，默认启用所有操作员
        const allOperators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        requestedOperatorIds = allOperators.map(op => op.id);
        logger.debug(`new client ${connectionId}, enabling all operators by default: [${requestedOperatorIds.join(', ')}]`, {
          clientInstanceId,
        });
      } else {
        // 已配置的客户端：直接使用发送的列表（可能为空数组表示全部禁用）
        requestedOperatorIds = enabledOperatorIds;
        logger.debug(`configured client ${connectionId}, enabled operators: [${enabledOperatorIds.join(', ')}]`, {
          clientInstanceId,
        });
      }

      // 完成握手（带权限过滤：requestedIds ∩ authorizedOperatorIds）
      connection.completeHandshakeWithAuth(requestedOperatorIds);
      const finalEnabledOperatorIds = connection.getEnabledOperatorIds();
      const finalSelectedOperatorId = this.resolveSelectedOperatorId(connection, selectedOperatorId);
      connection.setSelectedOperatorId(finalSelectedOperatorId);

      // 广播客户端数量变化（新客户端握手完成）
      this.broadcastClientCount();

      // 阶段2: 发送过滤后的完整数据

      // 1. 发送过滤后的操作员列表
      try {
        this.sendFilteredOperatorsList(connection);
      } catch (error) {
        logger.error('failed to send operators list', error);
      }

      // 2. 发送最近的时隙包数据（如果有）
      try {
        await this.sendProjectedRecentSlotPacks(connection, { reset: true });
      } catch (error) {
        logger.error('failed to send slot pack data', error);
      }

      // 2.5 发送插件系统快照
      try {
        connection.send(WSMessageType.PLUGIN_LIST, this.digitalRadioEngine.pluginManager.getSnapshot());
      } catch (error) {
        logger.error('failed to send plugin snapshot', error);
      }

      // 3. 发送握手完成消息
      connection.send('serverHandshakeComplete', {
        serverVersion: '1.0.0',
        supportedFeatures: [
          'operatorFiltering',
          'handshakeProtocol',
          'spectrumSubscriptions',
          'selectedOperatorScopedAnalysis',
        ],
        finalEnabledOperatorIds,
        finalSelectedOperatorId,
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
        this.sendCurrentSlotSnapshot(connection);
      }

      // 4.5 推送当前实际静噪状态
      try {
        connection.send(WSMessageType.SQUELCH_STATUS_CHANGED, this.digitalRadioEngine.getSquelchStatus());
      } catch (error) {
        logger.warn('failed to send squelch status snapshot', error);
      }

      // 5. 推送当前能力快照（电台已连接时有意义，未连接时为空列表）
      try {
        const radioManager = this.digitalRadioEngine.getRadioManager();
        const snapshot = radioManager.getCapabilitySnapshot();
        connection.send(WSMessageType.RADIO_CAPABILITY_LIST, snapshot);
        logger.debug(`sent capability snapshot to connection ${connectionId}`, { count: snapshot.capabilities.length });
      } catch (error) {
        logger.warn('failed to send capability snapshot', error);
      }

      // 5.5 推送音频 sidecar 当前状态，避免前端首次连接时不知道音频是否就绪
      try {
        const sidecar = this.digitalRadioEngine.getAudioSidecar();
        connection.send(WSMessageType.AUDIO_SIDECAR_STATUS_CHANGED, sidecar.buildStatusPayload());
      } catch (error) {
        logger.warn('failed to send audio sidecar snapshot', error);
      }

      try {
        const spectrumCapabilities = await Promise.race([
          this.spectrumCoordinator.getCapabilities(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spectrum capabilities timeout')), 3000)),
        ]);
        connection.send(WSMessageType.SPECTRUM_CAPABILITIES, spectrumCapabilities);
      } catch (error) {
        logger.warn('failed to send spectrum capabilities during handshake', error);
      }

      try {
        await Promise.race([
          this.sendSpectrumSessionStateToConnection(connection),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spectrum session state timeout')), 3000)),
        ]);
      } catch (error) {
        logger.warn('failed to send spectrum session state during handshake', error);
      }

      logger.info(`connection ${connectionId} handshake complete`, { clientInstanceId });

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
