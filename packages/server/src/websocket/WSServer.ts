import { WSMessageType } from '@tx5dr/contracts';
import type { 
  DecodeErrorInfo, 
  FT8Spectrum, 
  ModeDescriptor, 
  SlotInfo, 
  SlotPack, 
  SubWindowInfo, 
  SystemStatus 
} from '@tx5dr/contracts';
import { WSMessageHandler } from '@tx5dr/core';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';

/**
 * WebSocket连接包装器
 * 为每个客户端连接提供消息处理能力
 */
export class WSConnection extends WSMessageHandler {
  private ws: any; // WebSocket实例（支持不同的WebSocket库）
  private id: string;
  private enabledOperatorIds: Set<string> = new Set(); // 客户端启用的操作员ID列表
  private handshakeCompleted: boolean = false; // 握手是否完成

  constructor(ws: any, id: string) {
    super();
    this.ws = ws;
    this.id = id;

    // 监听WebSocket消息
    this.ws.on('message', (data: any) => {
      const message = typeof data === 'string' ? data : data.toString();
      this.handleRawMessage(message);
    });

    // 监听WebSocket关闭
    this.ws.on('close', () => {
      this.emitWSEvent('disconnected');
    });

    // 监听WebSocket错误
    this.ws.on('error', (error: Error) => {
      this.emitWSEvent('error', error);
    });
  }

  /**
   * 发送消息到客户端
   */
  send(type: string, data?: any, id?: string): void {
    try {
      const messageStr = this.createAndSerializeMessage(type, data, id);
      this.ws.send(messageStr);
    } catch (error) {
      console.error(`发送消息到客户端 ${this.id} 失败:`, error);
    }
  }

  /**
   * 关闭连接
   */
  close(): void {
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
    console.log(`🔧 [WSConnection] 连接 ${this.id} 设置启用操作员: [${operatorIds.join(', ')}]`);
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
    console.log(`🤝 [WSConnection] 连接 ${this.id} 握手完成，启用操作员: [${enabledOperatorIds.join(', ')}]`);
  }

  /**
   * 检查握手是否完成
   */
  isHandshakeCompleted(): boolean {
    return this.handshakeCompleted;
  }
}

/**
 * WebSocket服务器
 * 管理多个客户端连接和消息广播，集成业务逻辑处理
 */
export class WSServer extends WSMessageHandler {
  private connections = new Map<string, WSConnection>();
  private connectionIdCounter = 0;
  private digitalRadioEngine: DigitalRadioEngine;
  private commandHandlers: Partial<Record<WSMessageType, (data: any, connectionId: string) => Promise<void> | void>>;

  constructor(digitalRadioEngine: DigitalRadioEngine) {
    super();
    this.digitalRadioEngine = digitalRadioEngine;
    this.setupEngineEventListeners();

    this.commandHandlers = {
      [WSMessageType.START_ENGINE]: () => this.handleStartEngine(),
      [WSMessageType.STOP_ENGINE]: () => this.handleStopEngine(),
      [WSMessageType.GET_STATUS]: () => this.handleGetStatus(),
      [WSMessageType.SET_MODE]: (data) => this.handleSetMode(data?.mode),
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
    };
  }

  /**
   * 设置DigitalRadioEngine事件监听器
   */
  private setupEngineEventListeners(): void {
    // 监听引擎事件并广播给客户端
    this.digitalRadioEngine.on('modeChanged', (mode) => {
      console.log('🔄 服务器收到modeChanged事件，广播给客户端');
      this.broadcastModeChanged(mode);
    });

    this.digitalRadioEngine.on('slotStart', (slotInfo) => {
      this.broadcastSlotStart(slotInfo);
    });

    this.digitalRadioEngine.on('subWindow', (windowInfo) => {
      this.broadcastSubWindow(windowInfo);
    });

    // 监听时序告警事件（由核心/操作员侧在判定“赶不上发射”时发出）
    this.digitalRadioEngine.on('timingWarning' as any, (data: any) => {
      try {
        const title = data?.title || '⚠️ 时序告警';
        const text = data?.text || '操作员自动决策可能赶不上此发射时隙的编码';
        this.broadcastTextMessage(title, text);
      } catch {}
    });

    this.digitalRadioEngine.on('slotPackUpdated', async (slotPack) => {
      await this.broadcastSlotPackUpdated(slotPack);
    });

    this.digitalRadioEngine.on('spectrumData', (spectrum) => {
      this.broadcastSpectrumData(spectrum);
    });

    this.digitalRadioEngine.on('decodeError', (errorInfo) => {
      this.broadcastDecodeError(errorInfo);
    });

    this.digitalRadioEngine.on('systemStatus', (status) => {
      this.broadcastSystemStatus(status);
    });

    // 监听发射日志事件
    this.digitalRadioEngine.on('transmissionLog' as any, (data) => {
      console.log('📝 [WSServer] 收到发射日志，广播给客户端:', data);
      this.broadcast(WSMessageType.TRANSMISSION_LOG, data);
    });

    // 监听操作员状态更新事件
    this.digitalRadioEngine.on('operatorStatusUpdate' as any, (operatorStatus) => {
      this.broadcastOperatorStatusUpdate(operatorStatus);
    });

    // 监听操作员列表更新事件
    this.digitalRadioEngine.on('operatorsList' as any, (data: { operators: any[] }) => {
      console.log('📻 [WSServer] 收到operatorsList事件，向各客户端发送过滤后的操作员列表');
      
      const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
      activeConnections.forEach(connection => {
        const filteredOperators = data.operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      });
      
      console.log(`📤 [WSServer] 已向 ${activeConnections.length} 个已握手的客户端发送过滤后的操作员列表`);
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
      console.log(`📡 [WSServer] 收到QSO记录添加事件:`, data.qsoRecord.callsign);
      this.broadcastQSORecordAdded(data);
      // 向启用了该操作员的客户端发送简洁的Toast消息
      try {
        const qso = data.qsoRecord;
        const mhz = (qso.frequency / 1_000_000).toFixed(3);
        const gridPart = qso.grid ? ` ${qso.grid}` : '';
        const title = 'QSO已记录';
        const text = `${qso.callsign}${gridPart} • ${mhz} MHz • ${qso.mode}`;
        this.broadcastOperatorTextMessage(data.operatorId, title, text);
      } catch (e) {
        console.warn('⚠️ [WSServer] 发送QSO记录Toast失败:', e);
      }
    });

    // 监听日志本更新事件
    this.digitalRadioEngine.on('logbookUpdated' as any, (data: { logBookId: string; statistics: any }) => {
      console.log(`📡 [WSServer] 收到日志本更新事件:`, data.logBookId);
      this.broadcastLogbookUpdated(data);
    });

    // 监听电台状态变化事件
    this.digitalRadioEngine.on('radioStatusChanged' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到电台状态变化事件:`, data);
      this.broadcast(WSMessageType.RADIO_STATUS_CHANGED, data);

      // 推送 Toast 通知
      if (data.connected) {
        // 连接成功 - 成功类型，3秒自动关闭
        this.broadcastTextMessage(
          '电台已连接',
          data.reason || '电台连接成功',
          'success',
          3000
        );
      } else {
        // 连接断开 - 警告类型，10秒自动关闭
        const reason = data.reason || '未知原因';
        this.broadcastTextMessage(
          '电台已断开',
          `连接断开：${reason}`,
          'warning',
          10000
        );
      }
    });

    // 监听电台重连中事件
    this.digitalRadioEngine.on('radioReconnecting' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到电台重连中事件:`, data);
      this.broadcast(WSMessageType.RADIO_RECONNECTING, data);

      // 推送 Toast 通知 - 警告类型，10秒自动关闭
      const attempt = data.attempt || data.reconnectInfo?.reconnectAttempts || 0;
      const maxAttempts = data.reconnectInfo?.maxReconnectAttempts || -1;
      const attemptText = maxAttempts > 0 ? ` (${attempt}/${maxAttempts})` : ` (尝试 ${attempt})`;

      this.broadcastTextMessage(
        '正在重连电台',
        `正在尝试重新连接电台${attemptText}`,
        'warning',
        10000
      );
    });

    // 监听电台重连失败事件
    this.digitalRadioEngine.on('radioReconnectFailed' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到电台重连失败事件:`, data);
      this.broadcast(WSMessageType.RADIO_RECONNECT_FAILED, data);

      // 推送 Toast 通知 - 错误类型，需要手动关闭
      const error = data.error || '未知错误';
      const attempt = data.attempt || data.reconnectInfo?.reconnectAttempts || 0;

      this.broadcastTextMessage(
        '电台重连失败',
        `重连尝试 ${attempt} 失败：${error}`,
        'danger',
        null  // 需要手动关闭
      );
    });

    // 监听电台重连停止事件
    this.digitalRadioEngine.on('radioReconnectStopped' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到电台重连停止事件:`, data);
      this.broadcast(WSMessageType.RADIO_RECONNECT_STOPPED, data);

      // 推送 Toast 通知 - 错误类型，需要手动关闭
      const maxAttempts = data.maxAttempts || data.reconnectInfo?.maxReconnectAttempts || 0;

      this.broadcastTextMessage(
        '电台重连已停止',
        `已达到最大重连次数 (${maxAttempts})，重连已停止`,
        'danger',
        null  // 需要手动关闭
      );
    });

    // 监听电台错误事件
    this.digitalRadioEngine.on('radioError' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到电台错误事件:`, data);
      this.broadcast(WSMessageType.RADIO_ERROR, data);

      // 推送 Toast 通知 - 错误类型，需要手动关闭
      const error = data.error || '未知错误';

      this.broadcastTextMessage(
        '电台错误',
        `电台发生错误：${error}`,
        'danger',
        null  // 需要手动关闭
      );
    });

    // 监听电台发射中断开连接事件
    this.digitalRadioEngine.on('radioDisconnectedDuringTransmission' as any, (data: any) => {
      console.log(`⚠️ [WSServer] 收到电台发射中断开连接事件:`, data);
      this.broadcast(WSMessageType.RADIO_DISCONNECTED_DURING_TRANSMISSION, data);
    });

    // 监听频率变化事件
    this.digitalRadioEngine.on('frequencyChanged' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到频率变化事件:`, data);
      this.broadcast(WSMessageType.FREQUENCY_CHANGED, data);
    });

    // 监听PTT状态变化事件
    this.digitalRadioEngine.on('pttStatusChanged' as any, (data: any) => {
      console.log(`📡 [WSServer] 收到PTT状态变化事件: ${data.isTransmitting ? '开始发射' : '停止发射'}, 操作员=[${data.operatorIds?.join(', ') || ''}]`);
      this.broadcast(WSMessageType.PTT_STATUS_CHANGED, data);
    });

    // 监听电台数值表数据事件
    this.digitalRadioEngine.on('meterData' as any, (data: any) => {
      // 数值表数据频率较高，使用静默广播（不打印日志）
      this.broadcast(WSMessageType.METER_DATA, data);
    });
  }

  /**
   * 处理客户端命令
   */
  private async handleClientCommand(connectionId: string, message: any): Promise<void> {
    console.log(`📥 [WSServer] 收到客户端命令: ${message.type}, 连接: ${connectionId}`);
    const handler = this.commandHandlers[message.type as WSMessageType];
    if (handler) {
      await handler(message.data, connectionId);
    } else {
      console.warn('未知的WebSocket消息类型:', message.type);
    }
  }

  /**
   * 处理启动引擎命令
   */
  private async handleStartEngine(): Promise<void> {
    console.log('📥 服务器收到startEngine命令');
    try {
      // 始终调用引擎方法，让引擎内部处理重复调用情况
      await this.digitalRadioEngine.start();
      console.log('✅ digitalRadioEngine.start() 执行完成');
      
      // 强制发送最新状态确保同步
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);
      console.log('📡 已广播最新系统状态，isDecoding:', status.isDecoding);
    } catch (error) {
      console.error('❌ digitalRadioEngine.start() 执行失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'START_ENGINE_ERROR'
      });
    }
  }

  /**
   * 处理停止引擎命令
   */
  private async handleStopEngine(): Promise<void> {
    console.log('📥 服务器收到stopEngine命令');
    try {
      // 始终调用引擎方法，让引擎内部处理重复调用情况
      await this.digitalRadioEngine.stop();
      console.log('✅ digitalRadioEngine.stop() 执行完成');
      
      // 强制发送最新状态确保同步
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);
      console.log('📡 已广播最新系统状态，isDecoding:', status.isDecoding);
    } catch (error) {
      console.error('❌ digitalRadioEngine.stop() 执行失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'STOP_ENGINE_ERROR'
      });
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
   */
  private async handleSetMode(mode: ModeDescriptor): Promise<void> {
    try {
      await this.digitalRadioEngine.setMode(mode);
    } catch (error) {
      console.error('❌ digitalRadioEngine.setMode() 执行失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'SET_MODE_ERROR'
      });
    }
  }

  /**
   * 处理获取操作员列表命令
   */
  private async handleGetOperators(): Promise<void> {
    console.log('📥 [WSServer] 收到 getOperators 请求');
    try {
      const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
      
      // 只向已完成握手的客户端发送过滤后的操作员列表
      const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
      activeConnections.forEach(connection => {
        const filteredOperators = operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      });
      
      console.log(`📤 [WSServer] 已向 ${activeConnections.length} 个已握手的客户端发送过滤后的操作员列表`);
    } catch (error) {
      console.error('❌ 获取操作员列表失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'GET_OPERATORS_ERROR'
      });
    }
  }

  /**
   * 处理设置操作员上下文命令
   */
  private async handleSetOperatorContext(data: any): Promise<void> {
    try {
      const { operatorId, context } = data;
      await this.digitalRadioEngine.operatorManager.updateOperatorContext(operatorId, context);
    } catch (error) {
      console.error('❌ 设置操作员上下文失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'SET_OPERATOR_CONTEXT_ERROR'
      });
    }
  }

  /**
   * 处理设置操作员时隙命令
   */
  private async handleSetOperatorSlot(data: any): Promise<void> {
    try {
      const { operatorId, slot } = data;
      this.digitalRadioEngine.operatorManager.setOperatorSlot(operatorId, slot);
    } catch (error) {
      console.error('❌ 设置操作员时隙失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'SET_OPERATOR_SLOT_ERROR'
      });
    }
  }

  /**
   * 处理用户命令
   */
  private async handleUserCommand(data: any): Promise<void> {
    try {
      const { operatorId, command, args } = data;
      const operator = this.digitalRadioEngine.operatorManager.getOperator(operatorId);
      if (!operator) {
        throw new Error(`操作员 ${operatorId} 不存在`);
      }

      // 如果是update_context命令，先持久化到配置文件（此时内存还未更新，可以检测到变化）
      if (command === 'update_context') {
        await this.digitalRadioEngine.operatorManager.updateOperatorContext(operatorId, args);
        console.log(`💾 [WSServer] update_context命令已持久化到配置文件`);
      }

      // 然后调用operator更新内存状态
      operator.userCommand({ command, args });
      console.log(`📻 [WSServer] 执行用户命令: 操作员=${operatorId}, 命令=${command}, 参数=`, args);
    } catch (error) {
      console.error('❌ 执行用户命令失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'USER_COMMAND_ERROR'
      });
    }
  }

  /**
   * 处理启动操作员命令
   */
  private async handleStartOperator(data: any): Promise<void> {
    try {
      const { operatorId } = data;
      this.digitalRadioEngine.operatorManager.startOperator(operatorId);
      console.log(`📻 [WSServer] 启动操作员: ${operatorId}`);
    } catch (error) {
      console.error('❌ 启动操作员失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'START_OPERATOR_ERROR'
      });
    }
  }

  /**
   * 处理停止操作员命令
   */
  private async handleStopOperator(data: any): Promise<void> {
    try {
      const { operatorId } = data;
      this.digitalRadioEngine.operatorManager.stopOperator(operatorId);
      console.log(`📻 [WSServer] 停止操作员: ${operatorId}`);
    } catch (error) {
      console.error('❌ 停止操作员失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'STOP_OPERATOR_ERROR'
      });
    }
  }

  private async handleOperatorRequestCall(data: any): Promise<void> {
    try {
      const { operatorId, callsign } = data;
      const operator = this.digitalRadioEngine.operatorManager.getOperator(operatorId);
      if (!operator) {
        throw new Error(`操作员 ${operatorId} 不存在`);
      }
      const lastMessage = this.digitalRadioEngine.getSlotPackManager().getLastMessageFromCallsign(callsign);
      operator.requestCall(callsign, lastMessage);
      // 调用manager中的start，来启用中途发射
      this.digitalRadioEngine.operatorManager.startOperator(operatorId);
    } catch (error) {
      console.error('❌ 处理操作员请求呼叫失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'OPERATOR_REQUEST_CALL_ERROR'
      });
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
      this.handleClientCommand(id, message);
    });

    this.connections.set(id, connection);
    console.log(`🔗 新的WebSocket连接: ${id}`);

    // 阶段1: 发送基础状态信息（不包括需要过滤的数据）
    console.log(`📤 [WSServer] 为新连接 ${id} 发送基础状态...`);
    
    // 1. 发送当前系统状态
    const status = this.digitalRadioEngine.getStatus();
    connection.send(WSMessageType.SYSTEM_STATUS, status);
    console.log(`📤 [WSServer] 已发送系统状态`);
    
    // 2. 发送当前模式信息
    connection.send(WSMessageType.MODE_CHANGED, status.currentMode);
    console.log(`📤 [WSServer] 已发送当前模式`);
    
    // 3. 发送当前音量增益
    try {
      const volumeGain = this.digitalRadioEngine.getVolumeGain();
      const volumeGainDb = this.digitalRadioEngine.getVolumeGainDb();
      connection.send(WSMessageType.VOLUME_GAIN_CHANGED, { 
        gain: volumeGain, 
        gainDb: volumeGainDb 
      });
      console.log(`📤 [WSServer] 已发送音量增益: ${volumeGain.toFixed(3)} (${volumeGainDb.toFixed(1)}dB)`);
    } catch (error) {
      console.error('❌ 发送音量增益失败:', error);
    }
    
    console.log(`✅ [WSServer] 新连接 ${id} 的基础状态发送完成，等待客户端握手`);

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
      console.log(`🔌 WebSocket连接已断开: ${id}`);
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
    // console.log(`📡 [WSServer] 广播消息到 ${activeConnections.length} 个客户端: ${type}`);
    
    activeConnections.forEach(connection => {
      connection.send(type, data, id);
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
    timeout?: number | null
  ): void {
    console.log(`📡 [WSServer] 广播文本消息: ${title} - ${text} (color=${color}, timeout=${timeout})`);
    this.broadcast(WSMessageType.TEXT_MESSAGE, {
      title,
      text,
      color,
      timeout
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
    timeout?: number | null
  ): void {
    const activeConnections = this.getActiveConnections().filter(conn => conn.isHandshakeCompleted());
    const targets = activeConnections.filter(conn => conn.isOperatorEnabled(operatorId));
    targets.forEach(conn => {
      conn.send(WSMessageType.TEXT_MESSAGE, {
        title,
        text,
        color,
        timeout
      });
    });
    console.log(`📡 [WSServer] 向 ${targets.length} 个启用操作员 ${operatorId} 的客户端发送文本消息: ${title} - ${text} (color=${color}, timeout=${timeout})`);
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
        console.error(`❌ [WSServer] 为连接 ${connection.getId()} 定制化SlotPack失败:`, error);
        // 发送原始数据作为后备
        connection.send(WSMessageType.SLOT_PACK_UPDATED, slotPack);
      }
    });
    
    await Promise.all(customizedPromises);
    console.log(`📡 [WSServer] 向 ${activeConnections.length} 个客户端发送定制化时隙包更新`);
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
              console.log(`🚫 [WSServer] 连接 ${connection.getId()} 过滤自己的消息: "${frame.message}" (${senderCallsign})`);
              return null; // 标记为过滤掉
            }
          } catch (parseError) {
            // 解析失败时保留原frame，不影响其他处理
            console.warn(`⚠️ [WSServer] 解析消息用于过滤失败: "${frame.message}"`, parseError);
          }
        }

        // 添加logbook分析
        const logbookAnalysis = await this.analyzeFrameForOperators(frame, enabledOperatorIds);
        if (logbookAnalysis) {
          frame.logbookAnalysis = logbookAnalysis;
        }
      } catch (error) {
        console.warn(`⚠️ [WSServer] 分析frame失败: ${frame.message}`, error);
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

    // 计算当前系统频段（用于按频段判断“是否新呼号”）
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
        console.warn(`⚠️ [WSServer] 分析操作员 ${operatorId} 的日志本失败:`, error);
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
    
    console.log(`📡 [WSServer] 向 ${activeConnections.filter(conn => conn.isOperatorEnabled(operatorStatus.id)).length} 个启用操作员 ${operatorStatus.id} 的客户端发送状态更新`);
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
    console.log(`📡 [WSServer] 向 ${targetConnections.length} 个启用操作员 ${data.operatorId} 的客户端发送QSO记录添加事件: ${data.qsoRecord.callsign}`);
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
    
    console.log(`📡 [WSServer] 向 ${activeConnections.length} 个客户端发送日志本更新事件: ${data.logBookId}`);
  }

  /**
   * 处理设置音量增益命令（线性单位）
   */
  private async handleSetVolumeGain(data: any): Promise<void> {
    try {
      const { gain } = data;
      console.log(`🔊 [WSServer] 设置音量增益 (线性): ${gain.toFixed(3)}`);
      this.digitalRadioEngine.setVolumeGain(gain);
    } catch (error) {
      console.error('❌ 设置音量增益失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'SET_VOLUME_GAIN_ERROR'
      });
    }
  }

  /**
   * 处理设置音量增益命令（dB单位）
   */
  private async handleSetVolumeGainDb(data: any): Promise<void> {
    try {
      const { gainDb } = data;
      console.log(`🔊 [WSServer] 设置音量增益 (dB): ${gainDb.toFixed(1)}dB`);
      this.digitalRadioEngine.setVolumeGainDb(gainDb);
    } catch (error) {
      console.error('❌ 设置音量增益(dB)失败:', error);
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'SET_VOLUME_GAIN_DB_ERROR'
      });
    }
  }

  /**
   * 处理设置客户端启用操作员命令
   */
  private async handleSetClientEnabledOperators(connectionId: string, data: any): Promise<void> {
    try {
      const { enabledOperatorIds } = data;
      const connection = this.getConnection(connectionId);
      if (connection) {
        connection.setEnabledOperators(enabledOperatorIds);
        console.log(`🔧 [WSServer] 连接 ${connectionId} 设置启用操作员: [${enabledOperatorIds.join(', ')}]`);
        
        // 立即发送过滤后的操作员列表给该客户端
        const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        const filteredOperators = operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
      }
    } catch (error) {
      console.error('❌ 设置客户端启用操作员失败:', error);
      this.sendToConnection(connectionId, 'error', {
        message: error instanceof Error ? error.message : String(error),
        code: 'SET_CLIENT_ENABLED_OPERATORS_ERROR'
      });
    }
  }

  /**
   * 处理手动重连电台命令
   */
  private async handleRadioManualReconnect(): Promise<void> {
    try {
      console.log('📥 [WSServer] 收到手动重连电台命令');
      
      const radioManager = this.digitalRadioEngine.getRadioManager();
      await radioManager.manualReconnect();
      
      console.log('✅ [WSServer] 电台手动重连成功');
      
      // 广播最新的系统状态
      const status = this.digitalRadioEngine.getStatus();
      this.broadcastSystemStatus(status);
      
    } catch (error) {
      console.error('❌ [WSServer] 电台手动重连失败:', error);

      // 发送错误事件
      this.broadcast(WSMessageType.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        code: 'RADIO_MANUAL_RECONNECT_ERROR'
      });

      // 广播电台断开状态，确保前端状态同步
      const radioManager = this.digitalRadioEngine.getRadioManager();
      const reconnectInfo = radioManager.getReconnectInfo();

      this.broadcast(WSMessageType.RADIO_STATUS_CHANGED, {
        connected: false,
        reason: '手动重连失败',
        reconnectInfo
      });
    }
  }

  /**
   * 处理客户端握手命令
   */
  private async handleClientHandshake(connectionId: string, data: any): Promise<void> {
    try {
      const { enabledOperatorIds } = data;
      const connection = this.getConnection(connectionId);
      if (!connection) {
        throw new Error(`连接 ${connectionId} 不存在`);
      }

      // 处理客户端发送的操作员偏好设置
      let finalEnabledOperatorIds: string[];
      
      if (enabledOperatorIds === null) {
        // 新客户端：null表示没有本地偏好，默认启用所有操作员
        const allOperators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        finalEnabledOperatorIds = allOperators.map(op => op.id);
        console.log(`🆕 [WSServer] 新客户端 ${connectionId}，默认启用所有操作员: [${finalEnabledOperatorIds.join(', ')}]`);
      } else {
        // 已配置的客户端：直接使用发送的列表（可能为空数组表示全部禁用）
        finalEnabledOperatorIds = enabledOperatorIds;
        console.log(`🔧 [WSServer] 已配置客户端 ${connectionId}，启用操作员: [${enabledOperatorIds.join(', ')}]`);
      }

      // 完成握手（此时finalEnabledOperatorIds已经是实际的操作员ID列表）
      connection.completeHandshake(finalEnabledOperatorIds);

      // 阶段2: 发送过滤后的完整数据
      console.log(`📤 [WSServer] 为连接 ${connectionId} 发送完整过滤数据...`);

      // 1. 发送过滤后的操作员列表
      try {
        const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
        const filteredOperators = operators.filter(op => connection.isOperatorEnabled(op.id));
        connection.send(WSMessageType.OPERATORS_LIST, { operators: filteredOperators });
        console.log(`📤 [WSServer] 已发送过滤后的操作员列表: ${filteredOperators.length}/${operators.length} 个操作员`);
      } catch (error) {
        console.error('❌ 发送操作员列表失败:', error);
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
          console.log(`📤 [WSServer] 已发送 ${recentSlotPacks.length} 个最近的时隙包`);
        }
      } catch (error) {
        console.error('❌ 发送时隙包数据失败:', error);
      }

      // 3. 发送握手完成消息
      connection.send('serverHandshakeComplete', {
        serverVersion: '1.0.0',
        supportedFeatures: ['operatorFiltering', 'handshakeProtocol'],
        finalEnabledOperatorIds: enabledOperatorIds === null ? finalEnabledOperatorIds : undefined // 新客户端需要保存最终的操作员列表
      });

      // 4. 如果引擎正在运行，发送额外的状态同步
      const status = this.digitalRadioEngine.getStatus();
      if (status.isRunning) {
        connection.send(WSMessageType.SYSTEM_STATUS, status);
        console.log(`📤 [WSServer] 发送运行状态同步给连接 ${connectionId}`);
      }

      console.log(`✅ [WSServer] 连接 ${connectionId} 握手流程完成`);

    } catch (error) {
      console.error('❌ 处理客户端握手失败:', error);
      this.sendToConnection(connectionId, 'error', {
        message: error instanceof Error ? error.message : String(error),
        code: 'CLIENT_HANDSHAKE_ERROR'
      });
    }
  }

  /**
   * 清理所有连接
   */
  cleanup(): void {
    console.log('🧹 清理所有WebSocket连接');
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
