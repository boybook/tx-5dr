/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { WSMessageHandler } from '@tx5dr/core';
import { DeviceUiBootstrapSnapshotSchema, DeviceUiWsEventSchema } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { DeviceServiceAuthManager } from '../auth/DeviceServiceAuthManager.js';
import { createLogger } from '../utils/logger.js';
import { DeviceUiProjectionService, type DeviceUiSnapshot } from './DeviceUiProjectionService.js';
import { verifyDeviceUiJwtFromRequest } from './routes.js';

const logger = createLogger('DeviceUiWSServer');

interface DeviceUiConnection {
  id: string;
  ws: WebSocket;
  handler: WSMessageHandler;
  unsubscribe: () => void;
}

/**
 * Dedicated WebSocket entrypoint for the external device panel.
 * It never touches the browser WSServer/clientHandshake path or client counts.
 */
export class DeviceUiWSServer {
  private readonly connections = new Map<string, DeviceUiConnection>();
  private readonly projectionService: DeviceUiProjectionService;
  private idCounter = 0;

  constructor(
    engine: DigitalRadioEngine,
    private readonly authManager: DeviceServiceAuthManager,
    projectionService?: DeviceUiProjectionService,
  ) {
    this.projectionService = projectionService ?? new DeviceUiProjectionService(engine as any);
  }

  getProjectionService(): DeviceUiProjectionService {
    return this.projectionService;
  }

  async acceptConnection(ws: WebSocket, request: FastifyRequest): Promise<void> {
    const session = await verifyDeviceUiJwtFromRequest(request, this.authManager).catch((error) => {
      logger.warn('Device UI WS authentication failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!session) {
      ws.close(4001, 'Device JWT required');
      return;
    }

    const id = `device_ui_${++this.idCounter}`;
    const handler = new WSMessageHandler();
    let cleanedUp = false;
    const connection: DeviceUiConnection = {
      id,
      ws,
      handler,
      unsubscribe: () => {},
    };

    const sendSnapshot = (snapshot: DeviceUiSnapshot) => {
      this.send(id, ws, handler, 'snapshot', DeviceUiBootstrapSnapshotSchema.parse(snapshot));
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      connection.unsubscribe();
      this.connections.delete(id);
      logger.info('Device UI WS disconnected', { id, deviceId: session.payload.deviceId });
    };

    ws.on('close', cleanup);
    ws.on('error', cleanup);
    ws.on('message', (raw: any) => {
      try {
        handler.handleRawMessage(typeof raw === 'string' ? raw : raw?.toString?.());
      } catch {
        // MVP is server-push only; ignore client messages without affecting the socket.
      }
    });

    this.connections.set(id, connection);
    const unsubscribe = this.projectionService.subscribe(sendSnapshot);
    if (!this.connections.has(id)) {
      unsubscribe();
      return;
    }
    connection.unsubscribe = unsubscribe;
    logger.info('Device UI WS connected', { id, deviceId: session.payload.deviceId });
  }

  cleanup(): void {
    for (const conn of this.connections.values()) {
      conn.unsubscribe();
      try {
        conn.ws.close(1001, 'Server shutting down');
      } catch {}
    }
    this.connections.clear();
    this.projectionService.destroy();
  }

  private send(id: string, ws: WebSocket, handler: WSMessageHandler, type: string, payload: unknown): void {
    try {
      ws.send(handler.serializeMessage(DeviceUiWsEventSchema.parse({
        type,
        payload,
        timestamp: new Date().toISOString(),
      })));
    } catch (error) {
      logger.warn('Device UI WS send failed', { id, error: error instanceof Error ? error.message : String(error) });
      const conn = this.connections.get(id);
      conn?.unsubscribe();
      this.connections.delete(id);
      try {
        ws.close(1011, 'Device UI snapshot send failed');
      } catch {}
    }
  }
}
