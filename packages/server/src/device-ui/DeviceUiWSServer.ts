import type { RawData, WebSocket } from 'ws';
import type { DeviceUiProjectionService } from './DeviceUiProjectionService.js';

interface DeviceWsConnection {
  id: string;
  socket: WebSocket;
}

export class DeviceUiWSServer {
  private seq = 0;
  private connections = new Map<string, DeviceWsConnection>();
  private unsubscribeProjection: (() => void) | null = null;

  constructor(private readonly projection: DeviceUiProjectionService) {
    this.unsubscribeProjection = projection.onPatch((ops) => {
      this.broadcast({ type: 'state.patch', data: { ops } });
    });
  }

  addConnection(socket: WebSocket): void {
    const id = `device-ui-${++this.seq}`;
    const connection = { id, socket };
    this.connections.set(id, connection);

    socket.on('message', (raw: RawData) => this.handleMessage(connection, raw));
    socket.on('close', () => this.connections.delete(id));
    socket.on('error', () => this.connections.delete(id));

    this.send(connection, { type: 'state.replace', data: this.projection.getModel() });
  }

  cleanup(): void {
    this.unsubscribeProjection?.();
    this.unsubscribeProjection = null;
    for (const connection of this.connections.values()) {
      try {
        connection.socket.close(1001, 'server shutdown');
      } catch {
        // Best effort during shutdown.
      }
    }
    this.connections.clear();
  }

  private handleMessage(connection: DeviceWsConnection, raw: RawData): void {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string };
      if (msg.type === 'ping') {
        this.send(connection, { type: 'pong', data: { time: Date.now() } });
      }
    } catch {
      this.send(connection, { type: 'error', data: { code: 'BAD_JSON' } });
    }
  }

  private broadcast(payload: unknown): void {
    for (const connection of this.connections.values()) this.send(connection, payload);
  }

  private send(connection: DeviceWsConnection, payload: unknown): void {
    if (connection.socket.readyState === connection.socket.OPEN) {
      connection.socket.send(JSON.stringify(payload));
    }
  }
}
