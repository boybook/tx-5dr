/* eslint-disable @typescript-eslint/no-explicit-any */
// AudioMonitorWSServer - WebSocket消息处理需要使用any
import { createLogger } from '../utils/logger.js';
import { ConfigManager } from '../config/config-manager.js';
import type { AudioMonitorCodec } from '@tx5dr/contracts';

const logger = createLogger('AudioMonitorWS');

interface ClientInfo {
  ws: any;
  codec: AudioMonitorCodec; // client-declared codec capability
}

/**
 * 音频监听WebSocket服务器
 * 专门用于传输二进制音频数据，与控制WebSocket分离
 *
 * 架构：
 * - 控制平面：主WebSocket (/ws) 处理订阅、命令、统计信息（JSON）
 * - 数据平面：音频WebSocket (/ws/audio-monitor) 只传输音频（ArrayBuffer/Opus）
 *
 * 支持 per-client codec：客户端声明自己支持 opus 或 pcm，
 * 服务端根据配置和客户端能力选择发送格式。
 */

export class AudioMonitorWSServer {
  private clients = new Map<string, ClientInfo>();
  private readonly BACKPRESSURE_THRESHOLD = 100 * 1024; // 100KB 背压阈值
  private backpressureWarningCount = 0;

  /**
   * Get the server-side codec preference from config.
   */
  getServerCodec(): AudioMonitorCodec {
    return ConfigManager.getInstance().getAudioMonitorCodec();
  }

  /**
   * 处理新的音频WebSocket连接
   * @param ws WebSocket连接实例
   * @param clientId 客户端ID（由URL参数确定）
   * @param codec 客户端声明的codec能力（从URL query读取）
   */
  handleConnection(ws: any, clientId: string, codec: AudioMonitorCodec = 'pcm'): void {
    logger.info('audio WebSocket client connected', { clientId, codec });

    const effectiveCodec = this.getServerCodec() === 'opus' && codec === 'opus' ? 'opus' : 'pcm';
    this.clients.set(clientId, { ws, codec: effectiveCodec });

    // Notify client of the actual codec being used (first message is JSON text)
    try {
      ws.send(JSON.stringify({ type: 'codec', codec: effectiveCodec }));
    } catch {
      // best effort
    }

    ws.on('close', () => {
      logger.info('audio WebSocket client disconnected', { clientId });
      this.clients.delete(clientId);
    });

    ws.on('error', (error: Error) => {
      logger.error('audio WebSocket error', { clientId, error });
      this.clients.delete(clientId);
    });

    ws.on('message', (_data: any) => {
      logger.warn('audio WebSocket client sent unexpected message', { clientId });
    });
  }

  /**
   * Check if any connected client supports opus.
   */
  hasOpusClients(): boolean {
    for (const info of this.clients.values()) {
      if (info.codec === 'opus') return true;
    }
    return false;
  }

  /**
   * Send audio data to a specific client, choosing format based on
   * server config and client capability.
   *
   * @param clientId Client ID
   * @param opusBuffer Opus-encoded buffer (null if not encoded)
   * @param pcmBuffer Raw Float32 PCM ArrayBuffer
   */
  sendAudioData(clientId: string, opusBuffer: Buffer | null, pcmBuffer: ArrayBuffer): void {
    const info = this.clients.get(clientId);
    if (!info) return;

    const { ws, codec: clientCodec } = info;

    if (ws.readyState !== 1) {
      logger.warn('audio WebSocket not ready', { clientId, readyState: ws.readyState });
      return;
    }

    // Backpressure check
    const bufferedAmount = ws.bufferedAmount || 0;
    if (bufferedAmount > this.BACKPRESSURE_THRESHOLD) {
      this.backpressureWarningCount++;
      if (this.backpressureWarningCount % 20 === 1) {
        logger.debug('backpressure high', { clientId, bufferedAmount: `${(bufferedAmount / 1024).toFixed(1)}KB` });
      }
      return;
    }

    try {
      // Send opus if server config allows AND client supports it AND we have encoded data
      if (this.getServerCodec() === 'opus' && clientCodec === 'opus' && opusBuffer) {
        ws.send(opusBuffer);
      } else {
        ws.send(pcmBuffer);
      }
    } catch (error) {
      logger.error('failed to send audio data to client', { clientId, error });
      this.clients.delete(clientId);
    }
  }

  /**
   * Get the effective codec for a specific client.
   */
  getClientEffectiveCodec(clientId: string): AudioMonitorCodec {
    const info = this.clients.get(clientId);
    if (!info) return 'pcm';
    if (this.getServerCodec() === 'opus' && info.codec === 'opus') return 'opus';
    return 'pcm';
  }

  disconnect(clientId: string): void {
    const info = this.clients.get(clientId);
    if (info) {
      logger.info('disconnecting client', { clientId });
      info.ws.close();
      this.clients.delete(clientId);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  isClientConnected(clientId: string): boolean {
    const info = this.clients.get(clientId);
    return !!info && info.ws.readyState === 1;
  }

  getAllClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  closeAll(): void {
    logger.info('closing all audio WebSocket connections', { count: this.clients.size });
    for (const [clientId, info] of this.clients.entries()) {
      try {
        info.ws.close();
      } catch (error) {
        logger.error('failed to close client connection', { clientId, error });
      }
    }
    this.clients.clear();
  }
}
