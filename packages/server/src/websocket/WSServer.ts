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
}

/**
 * WebSocket服务器
 * 管理多个客户端连接和消息广播，集成业务逻辑处理
 */
export class WSServer extends WSMessageHandler {
  private connections = new Map<string, WSConnection>();
  private connectionIdCounter = 0;
  private digitalRadioEngine: DigitalRadioEngine;

  constructor(digitalRadioEngine: DigitalRadioEngine) {
    super();
    this.digitalRadioEngine = digitalRadioEngine;
    this.setupEngineEventListeners();
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

    this.digitalRadioEngine.on('slotPackUpdated', (slotPack) => {
      this.broadcastSlotPackUpdated(slotPack);
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
      console.log('📻 [WSServer] 收到operatorsList事件，广播给客户端', data.operators.length, '个操作员');
      this.broadcast(WSMessageType.OPERATORS_LIST, data);
    });

    // 监听音量变化事件
    this.digitalRadioEngine.on('volumeGainChanged', (gain) => {
      this.broadcast(WSMessageType.VOLUME_GAIN_CHANGED, { gain });
    });
  }

  /**
   * 处理客户端命令
   */
  private async handleClientCommand(connectionId: string, message: any): Promise<void> {
    console.log(`📥 [WSServer] 收到客户端命令: ${message.type}, 连接: ${connectionId}`);
    switch (message.type) {
      case WSMessageType.START_ENGINE:
        await this.handleStartEngine();
        break;

      case WSMessageType.STOP_ENGINE:
        await this.handleStopEngine();
        break;

      case WSMessageType.GET_STATUS:
        await this.handleGetStatus();
        break;

      case WSMessageType.SET_MODE:
        await this.handleSetMode(message.data?.mode);
        break;

      case WSMessageType.GET_OPERATORS:
        await this.handleGetOperators();
        break;

      case WSMessageType.SET_OPERATOR_CONTEXT:
        await this.handleSetOperatorContext(message.data);
        break;

      case WSMessageType.SET_OPERATOR_SLOT:
        await this.handleSetOperatorSlot(message.data);
        break;

      case WSMessageType.USER_COMMAND:
        await this.handleUserCommand(message.data);
        break;

      case WSMessageType.START_OPERATOR:
        await this.handleStartOperator(message.data);
        break;

      case WSMessageType.STOP_OPERATOR:
        await this.handleStopOperator(message.data);
        break;

      case WSMessageType.PING:
        // ping消息回复pong到指定客户端
        this.sendToConnection(connectionId, WSMessageType.PONG);
        break;

      case WSMessageType.SET_VOLUME_GAIN:
        await this.handleSetVolumeGain(message.data);
        break;

      default:
        console.warn('未知的WebSocket消息类型:', message.type);
    }
  }

  /**
   * 处理启动引擎命令
   */
  private async handleStartEngine(): Promise<void> {
    console.log('📥 服务器收到startEngine命令');
    try {
      const currentStatus = this.digitalRadioEngine.getStatus();
      if (currentStatus.isRunning) {
        console.log('⚠️ 时钟已经在运行中，发送当前状态同步');
        this.broadcastSystemStatus(currentStatus);
      } else {
        await this.digitalRadioEngine.start();
        console.log('✅ digitalRadioEngine.start() 执行成功');
      }
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
      const currentStatus = this.digitalRadioEngine.getStatus();
      if (!currentStatus.isRunning) {
        console.log('⚠️ 时钟已经停止，发送当前状态同步');
        this.broadcastSystemStatus(currentStatus);
      } else {
        await this.digitalRadioEngine.stop();
        console.log('✅ digitalRadioEngine.stop() 执行成功');
      }
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
      // console.log('📻 [WSServer] 操作员列表:', operators);
      this.broadcast(WSMessageType.OPERATORS_LIST, { operators });
      // console.log('📤 [WSServer] 已广播操作员列表');
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
      this.digitalRadioEngine.operatorManager.updateOperatorContext(operatorId, context);
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

    // 发送完整的状态信息给新连接的客户端
    console.log(`📤 [WSServer] 为新连接 ${id} 发送初始状态...`);
    
    // 1. 发送当前系统状态
    const status = this.digitalRadioEngine.getStatus();
    connection.send(WSMessageType.SYSTEM_STATUS, status);
    console.log(`📤 [WSServer] 已发送系统状态:`, status);
    
    // 2. 发送当前模式信息（确保客户端能获取到模式变化）
    connection.send(WSMessageType.MODE_CHANGED, status.currentMode);
    console.log(`📤 [WSServer] 已发送当前模式:`, status.currentMode);
    
    // 3. 发送当前操作员列表
    try {
      const operators = this.digitalRadioEngine.operatorManager.getOperatorsStatus();
      connection.send(WSMessageType.OPERATORS_LIST, { operators });
      console.log(`📤 [WSServer] 已发送操作员列表: ${operators.length} 个操作员`);
    } catch (error) {
      console.error('❌ 发送操作员列表失败:', error);
    }
    
    // 4. 发送当前音量增益
    try {
      const volumeGain = this.digitalRadioEngine.getVolumeGain();
      connection.send(WSMessageType.VOLUME_GAIN_CHANGED, { gain: volumeGain });
      console.log(`📤 [WSServer] 已发送音量增益: ${volumeGain}`);
    } catch (error) {
      console.error('❌ 发送音量增益失败:', error);
    }
    
    // 5. 发送最近的时隙包数据（如果有）
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
    
    console.log(`✅ [WSServer] 新连接 ${id} 的初始状态发送完成`);
    
    // 6. 如果引擎正在运行，额外发送一次状态确保同步
    if (status.isRunning) {
      // 延迟500ms再发送一次，确保客户端已完全建立连接
      setTimeout(() => {
        if (connection.isAlive) {
          connection.send(WSMessageType.SYSTEM_STATUS, this.digitalRadioEngine.getStatus());
          console.log(`📤 [WSServer] 延迟发送状态同步给连接 ${id}`);
        }
      }, 500);
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
    // console.log(`📡 广播消息到 ${activeConnections.length} 个客户端: ${type}`);
    
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
   * 广播时隙包更新事件
   */
  broadcastSlotPackUpdated(slotPack: SlotPack): void {
    this.broadcast(WSMessageType.SLOT_PACK_UPDATED, slotPack);
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
    this.broadcast(WSMessageType.OPERATOR_STATUS_UPDATE, operatorStatus);
  }



  /**
   * 处理设置音量增益命令
   */
  private async handleSetVolumeGain(data: any): Promise<void> {
    try {
      const { gain } = data;
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