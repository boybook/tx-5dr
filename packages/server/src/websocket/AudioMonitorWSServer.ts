/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioMonitorWSServer - WebSocket消息处理需要使用any
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioMonitorWS');

/**
 * 音频监听WebSocket服务器
 * 专门用于传输二进制音频数据，与控制WebSocket分离
 *
 * 架构：
 * - 控制平面：主WebSocket (/ws) 处理订阅、命令、统计信息（JSON）
 * - 数据平面：音频WebSocket (/ws/audio-monitor) 只传输音频（ArrayBuffer）
 *
 * 优势：
 * - 零Base64编解码开销
 * - 零拷贝ArrayBuffer传输
 * - 代码清晰，关注点分离
 */

export class AudioMonitorWSServer {
  private clients = new Map<string, any>(); // clientId -> WebSocket
  private readonly BACKPRESSURE_THRESHOLD = 100 * 1024; // 100KB 背压阈值
  private backpressureWarningCount = 0; // 背压警告计数

  /**
   * 处理新的音频WebSocket连接
   * @param ws WebSocket连接实例
   * @param clientId 客户端ID（由URL参数或握手确定）
   */
  handleConnection(ws: any, clientId: string): void {
    logger.info('audio WebSocket client connected', { clientId });

    // 存储连接
    this.clients.set(clientId, ws);

    // 监听连接关闭
    ws.on('close', () => {
      logger.info('audio WebSocket client disconnected', { clientId });
      this.clients.delete(clientId);
    });

    // 监听错误
    ws.on('error', (error: Error) => {
      logger.error('audio WebSocket error', { clientId, error });
      this.clients.delete(clientId);
    });

    // 音频WebSocket只接收二进制数据，不处理文本消息
    ws.on('message', (_data: any) => {
      logger.warn('audio WebSocket client sent unexpected message (audio WS should not receive messages)', { clientId });
    });
  }

  /**
   * 发送音频数据到指定客户端
   * @param clientId 客户端ID
   * @param buffer 音频数据（ArrayBuffer）
   */
  sendAudioData(clientId: string, buffer: ArrayBuffer): void {
    const ws = this.clients.get(clientId);

    if (!ws) {
      // 客户端未连接音频WebSocket（可能还未建立连接或已断开）
      return;
    }

    if (ws.readyState !== 1) { // WebSocket.OPEN
      logger.warn('audio WebSocket not ready', { clientId, readyState: ws.readyState });
      return;
    }

    // 检测背压（WebSocket发送缓冲区积压）
    const bufferedAmount = ws.bufferedAmount || 0;
    if (bufferedAmount > this.BACKPRESSURE_THRESHOLD) {
      this.backpressureWarningCount++;
      if (this.backpressureWarningCount % 20 === 1) { // 每秒输出一次警告
        logger.debug('backpressure high', { clientId, bufferedAmount: `${(bufferedAmount/1024).toFixed(1)}KB` });
      }
      return; // 丢弃本帧，避免内存积压
    }

    try {
      // 直接发送ArrayBuffer，无需序列化
      ws.send(buffer);

      // 每秒输出一次背压状态
      if (this.backpressureWarningCount % 20 === 0 && bufferedAmount > 10 * 1024) {
        logger.debug('backpressure status', { clientId, bufferedAmount: `${(bufferedAmount/1024).toFixed(1)}KB` });
      }
    } catch (error) {
      logger.error('failed to send audio data to client', { clientId, error });
      // 发送失败，移除连接
      this.clients.delete(clientId);
    }
  }

  /**
   * 断开指定客户端的音频WebSocket
   * @param clientId 客户端ID
   */
  disconnect(clientId: string): void {
    const ws = this.clients.get(clientId);
    if (ws) {
      logger.info('disconnecting client', { clientId });
      ws.close();
      this.clients.delete(clientId);
    }
  }

  /**
   * 获取当前连接的客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 检查客户端是否已连接
   */
  isClientConnected(clientId: string): boolean {
    const ws = this.clients.get(clientId);
    return ws && ws.readyState === 1;
  }

  /**
   * 获取所有已连接的客户端ID列表
   */
  getAllClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * 关闭所有连接
   */
  closeAll(): void {
    logger.info('closing all audio WebSocket connections', { count: this.clients.size });
    for (const [clientId, ws] of this.clients.entries()) {
      try {
        ws.close();
      } catch (error) {
        logger.error('failed to close client connection', { clientId, error });
      }
    }
    this.clients.clear();
  }
}
