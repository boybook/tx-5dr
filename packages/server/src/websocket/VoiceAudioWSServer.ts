/* eslint-disable @typescript-eslint/no-explicit-any */
// VoiceAudioWSServer - WebSocket binary audio handling
import { createLogger } from '../utils/logger.js';
import type { VoiceSessionManager } from '../voice/VoiceSessionManager.js';

const logger = createLogger('VoiceAudioWS');

/**
 * Voice audio WebSocket server.
 * Receives Opus-encoded binary audio frames from browser clients
 * and forwards them to VoiceSessionManager for decoding and playback.
 *
 * This is the reverse direction of AudioMonitorWSServer:
 * - AudioMonitorWSServer: Server → Client (RX monitoring)
 * - VoiceAudioWSServer: Client → Server (TX voice audio)
 */
export class VoiceAudioWSServer {
  private connections = new Map<string, any>(); // clientId -> WebSocket
  private voiceSessionManager: VoiceSessionManager | null = null;

  setVoiceSessionManager(manager: VoiceSessionManager | null): void {
    this.voiceSessionManager = manager;
  }

  /**
   * Handle a new voice audio WebSocket connection.
   */
  handleConnection(ws: any, clientId: string): void {
    logger.info('Voice audio WS client connected', { clientId });
    this.connections.set(clientId, ws);

    ws.on('message', (data: any) => {
      // Only process binary data (Opus frames)
      if (data instanceof Buffer || data instanceof ArrayBuffer) {
        const buf = data instanceof Buffer ? data : Buffer.from(data);
        if (this.voiceSessionManager) {
          this.voiceSessionManager.handleAudioFrame(clientId, buf);
        }
      }
    });

    ws.on('close', () => {
      logger.info('Voice audio WS client disconnected', { clientId });
      this.connections.delete(clientId);
      // Auto-release PTT if this client held it
      this.voiceSessionManager?.handleClientDisconnect(clientId);
    });

    ws.on('error', (error: Error) => {
      logger.error('Voice audio WS error', { clientId, error });
      this.connections.delete(clientId);
    });
  }

  closeAll(): void {
    for (const [clientId, ws] of this.connections) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      logger.debug('Closed voice audio WS connection', { clientId });
    }
    this.connections.clear();
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}
