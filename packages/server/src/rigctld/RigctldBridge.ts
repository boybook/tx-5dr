/**
 * rigctld-compatible TCP bridge subsystem.
 *
 * Owns a {@link RigctldServer} whose lifecycle is decoupled from the
 * DigitalRadioEngine's `startAll/stopAll` resource pipeline — the bridge stays
 * up across engine restarts and simply returns `RIG_EIO` to clients while the
 * radio is disconnected. This mirrors the behavior of a real rigctld, which a
 * client can reconnect to without the server cycling.
 *
 * Configuration is read from `ConfigManager.getRigctldConfig()`; environment
 * variables (`RIGCTLD_ENABLED`, `RIGCTLD_BIND`, `RIGCTLD_PORT`) override the
 * stored values so Docker / systemd deployments can light up the bridge without
 * touching the UI.
 */

import { EventEmitter } from 'eventemitter3';
import {
  RigctldServer,
  type RigctldClientInfo,
} from '@tx5dr/rigctld-server';
import type { RigctldBridgeConfig, RigctldStatus } from '@tx5dr/contracts';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';
import { RadioControllerAdapter } from './RadioControllerAdapter.js';

const logger = createLogger('RigctldBridge');

export interface RigctldBridgeEvents {
  statusChanged: [RigctldStatus];
}

export class RigctldBridge extends EventEmitter<RigctldBridgeEvents> {
  private server: RigctldServer | null = null;
  private currentConfig: RigctldBridgeConfig | null = null;
  private lastError: string | undefined;
  private clients = new Map<number, RigctldClientInfo>();

  constructor(private readonly radioManager: PhysicalRadioManager) {
    super();
  }

  /**
   * Start the bridge if currently enabled. Safe to call multiple times —
   * subsequent calls reconcile the live server against the stored config.
   */
  async applyConfig(): Promise<void> {
    const next = ConfigManager.getInstance().getRigctldConfig();

    // readOnly flips can be applied in-place without recreating the TCP
    // listener — only network-level fields require a restart.
    if (this.server && this.currentConfig) {
      const networkSame =
        this.currentConfig.enabled === next.enabled &&
        this.currentConfig.bindAddress === next.bindAddress &&
        this.currentConfig.port === next.port;
      if (networkSame) {
        if (this.currentConfig.readOnly !== next.readOnly) {
          this.server.setReadOnly(next.readOnly);
          logger.info('rigctld bridge readOnly updated', { readOnly: next.readOnly });
        }
        this.currentConfig = next;
        this.emitStatus();
        return;
      }
      await this.stop();
    }

    this.currentConfig = next;

    if (!next.enabled) {
      this.emitStatus();
      return;
    }

    const server = new RigctldServer({
      controller: new RadioControllerAdapter(this.radioManager),
      host: next.bindAddress,
      port: next.port,
      readOnly: next.readOnly,
      logger: {
        debug: (m, meta) => logger.debug(m, meta),
        info: (m, meta) => logger.info(m, meta),
        warn: (m, meta) => logger.warn(m, meta),
        error: (m, meta) => logger.error(m, meta),
      },
    });
    this.wireServer(server);

    try {
      await server.listen();
      this.server = server;
      this.lastError = undefined;
      logger.info('rigctld bridge listening', { host: next.bindAddress, port: next.port });
    } catch (error) {
      this.lastError = (error as Error).message;
      logger.warn('rigctld bridge failed to start', {
        host: next.bindAddress,
        port: next.port,
        error: this.lastError,
      });
    }
    this.emitStatus();
  }

  /** Tear down the TCP listener. Existing client sockets are closed. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.clients.clear();
    try {
      await server.close();
    } catch (error) {
      logger.warn('rigctld bridge close failed', { error: (error as Error).message });
    }
    this.emitStatus();
  }

  getStatus(): RigctldStatus {
    const config = this.currentConfig ?? ConfigManager.getInstance().getRigctldConfig();
    return {
      config,
      running: this.server !== null,
      address: this.server ? this.server.address() : undefined,
      clients: Array.from(this.clients.values()).map((c) => ({ ...c })),
      error: this.lastError,
    };
  }

  private wireServer(server: RigctldServer): void {
    const s = server;
    s.on('clientConnected', (info) => {
      this.clients.set(info.id, { ...info });
      this.emitStatus();
    });
    s.on('clientDisconnected', (info) => {
      this.clients.delete(info.id);
      this.emitStatus();
    });
    s.on('commandHandled', ({ clientId, command }) => {
      const c = this.clients.get(clientId);
      if (c) {
        c.lastCommand = command;
        c.lastCommandAt = Date.now();
        // Don't emit on every command — too chatty. UI polls /api/rigctld/status
        // for real-time command tracking. clientConnected/Disconnected is enough
        // for list maintenance.
      }
    });
    s.on('error', (e) => {
      this.lastError = e.message;
      this.emitStatus();
    });
  }

  private emitStatus(): void {
    this.emit('statusChanged', this.getStatus());
  }
}
