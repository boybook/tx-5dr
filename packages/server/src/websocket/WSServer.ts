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

    this.digitalRadioEngine.on('decodeError', (errorInfo) => {
      this.broadcastDecodeError(errorInfo);
    });
  }

  /**
   * 处理客户端命令
   */
  private async handleClientCommand(connectionId: string, message: any): Promise<void> {
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

      case WSMessageType.PING:
        // ping消息回复pong到指定客户端
        this.sendToConnection(connectionId, WSMessageType.PONG);
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
  private async handleSetMode(mode: any): Promise<void> {
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

    // 发送当前系统状态给新连接的客户端
    const status = this.digitalRadioEngine.getStatus();
    connection.send(WSMessageType.SYSTEM_STATUS, status);

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
    console.log(`📡 广播消息到 ${activeConnections.length} 个客户端: ${type}`);
    
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