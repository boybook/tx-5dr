import { WSMessageHandler } from './WSMessageHandler.js';

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
      this.emitWSEvent('connectionError', error);
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
 * 管理多个客户端连接和消息广播
 */
export class WSServer extends WSMessageHandler {
  private connections = new Map<string, WSConnection>();
  private connectionIdCounter = 0;

  constructor() {
    super();
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

    // 转发所有消息事件到服务器
    connection.onWSEvent('rawMessage', (message) => {
      this.emitWSEvent('rawMessage', message);
      this.handleRawMessage(JSON.stringify(message));
    });

    this.connections.set(id, connection);
    console.log(`🔗 新的WebSocket连接: ${id}`);
    
    // 发送欢迎消息
    connection.send('welcome', {
      message: 'Connected to TX-5DR WebSocket server',
      serverVersion: '1.0.0'
    });

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

  /**
   * 广播模式变化事件
   */
  broadcastModeChanged(mode: any): void {
    this.broadcast('modeChanged', mode);
  }

  /**
   * 广播时钟启动事件
   */
  broadcastClockStarted(): void {
    this.broadcast('clockStarted');
  }

  /**
   * 广播时钟停止事件
   */
  broadcastClockStopped(): void {
    this.broadcast('clockStopped');
  }

  /**
   * 广播时隙开始事件
   */
  broadcastSlotStart(slotInfo: any): void {
    this.broadcast('slotStart', slotInfo);
  }

  /**
   * 广播子窗口事件
   */
  broadcastSubWindow(windowInfo: any): void {
    this.broadcast('subWindow', windowInfo);
  }

  /**
   * 广播时隙包更新事件
   */
  broadcastSlotPackUpdated(slotPack: any): void {
    this.broadcast('slotPackUpdated', slotPack);
  }

  /**
   * 广播解码错误事件
   */
  broadcastDecodeError(errorInfo: any): void {
    this.broadcast('decodeError', errorInfo);
  }

  /**
   * 广播系统状态事件
   */
  broadcastSystemStatus(status: any): void {
    this.broadcast('systemStatus', status);
  }

  /**
   * 发送命令结果到指定客户端
   */
  sendCommandResult(connectionId: string, result: any): boolean {
    return this.sendToConnection(connectionId, 'commandResult', result);
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