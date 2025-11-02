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
    console.log(`🎧 [AudioMonitorWS] 客户端 ${clientId} 连接到音频WebSocket`);

    // 存储连接
    this.clients.set(clientId, ws);

    // 监听连接关闭
    ws.on('close', () => {
      console.log(`🎧 [AudioMonitorWS] 客户端 ${clientId} 断开音频WebSocket`);
      this.clients.delete(clientId);
    });

    // 监听错误
    ws.on('error', (error: Error) => {
      console.error(`❌ [AudioMonitorWS] 客户端 ${clientId} 音频WebSocket错误:`, error);
      this.clients.delete(clientId);
    });

    // 音频WebSocket只接收二进制数据，不处理文本消息
    ws.on('message', (data: any) => {
      console.warn(`⚠️ [AudioMonitorWS] 客户端 ${clientId} 发送了消息（音频WS不应接收消息）`);
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
      console.warn(`⚠️ [AudioMonitorWS] 客户端 ${clientId} WebSocket未就绪，状态=${ws.readyState}`);
      return;
    }

    // 检测背压（WebSocket发送缓冲区积压）
    const bufferedAmount = ws.bufferedAmount || 0;
    if (bufferedAmount > this.BACKPRESSURE_THRESHOLD) {
      this.backpressureWarningCount++;
      if (this.backpressureWarningCount % 20 === 1) { // 每秒输出一次警告
        console.warn(
          `⚠️ [AudioMonitorWS] 客户端 ${clientId} 背压过高: ${(bufferedAmount/1024).toFixed(1)}KB, ` +
          `丢弃本帧避免积压`
        );
      }
      return; // 丢弃本帧，避免内存积压
    }

    try {
      // 直接发送ArrayBuffer，无需序列化
      ws.send(buffer);

      // 每秒输出一次背压状态
      if (this.backpressureWarningCount % 20 === 0 && bufferedAmount > 10 * 1024) {
        console.log(`📊 [AudioMonitorWS] 客户端 ${clientId} 背压: ${(bufferedAmount/1024).toFixed(1)}KB`);
      }
    } catch (error) {
      console.error(`❌ [AudioMonitorWS] 发送音频数据到客户端 ${clientId} 失败:`, error);
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
      console.log(`🎧 [AudioMonitorWS] 主动断开客户端 ${clientId} 的音频WebSocket`);
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
    console.log(`🎧 [AudioMonitorWS] 关闭所有音频WebSocket连接 (${this.clients.size}个)`);
    for (const [clientId, ws] of this.clients.entries()) {
      try {
        ws.close();
      } catch (error) {
        console.error(`❌ [AudioMonitorWS] 关闭客户端 ${clientId} 失败:`, error);
      }
    }
    this.clients.clear();
  }
}
