import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import type {
  RigctldClientInfo,
  RigctldIdentity,
  RigctldLogger,
  RigctldServerEvents,
  RigctldServerOptions,
} from './types.js';
import { RigctldSession } from './session.js';

const DEFAULT_IDENTITY: RigctldIdentity = {
  rigModel: 3073,
  modelName: 'IC-7300',
  mfgName: 'Icom',
  version: 'tx5dr-rigctld 0.1.0',
};

const NOOP_LOGGER: RigctldLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * rigctld-compatible TCP server.
 *
 * Lifecycle:
 *   const server = new RigctldServer({ controller, host, port });
 *   await server.listen();
 *   // ... later
 *   await server.close();
 *
 * The server owns a `net.Server`; each accepted socket becomes a `RigctldSession`
 * which handles framing and dispatch. Clients are tracked for observability.
 */
export class RigctldServer extends EventEmitter<RigctldServerEvents> {
  private readonly host: string;
  private readonly port: number;
  private readonly logger: RigctldLogger;
  private readonly identity: RigctldIdentity;
  private readonly controller: RigctldServerOptions['controller'];
  private _readOnly: boolean;

  private netServer: Server | null = null;
  private sessions = new Map<number, RigctldSession>();
  private nextClientId = 1;

  constructor(opts: RigctldServerOptions) {
    super();
    this.controller = opts.controller;
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 4532;
    this.logger = opts.logger ?? NOOP_LOGGER;
    this.identity = { ...DEFAULT_IDENTITY, ...(opts.identity ?? {}) };
    this._readOnly = opts.readOnly ?? false;
  }

  /** Whether write commands are currently blocked at the dispatcher. */
  get readOnly(): boolean {
    return this._readOnly;
  }

  /**
   * Toggle read-only enforcement at runtime. Takes effect on the very next
   * command — existing in-flight commands are unaffected. Use this instead of
   * restarting the server when the operator flips the UI switch.
   */
  setReadOnly(readOnly: boolean): void {
    this._readOnly = readOnly;
  }

  /** Current bind address & port. */
  address(): { host: string; port: number } {
    return { host: this.host, port: this.port };
  }

  /** Snapshot of currently connected clients. */
  clients(): RigctldClientInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.info }));
  }

  get running(): boolean {
    return this.netServer !== null;
  }

  listen(): Promise<void> {
    if (this.netServer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onConnection(socket));
      server.on('error', (e) => {
        if (!this.netServer) {
          reject(e);
          return;
        }
        this.logger.error('rigctld server error', { error: e.message });
        this.emit('error', e);
      });
      server.listen(this.port, this.host, () => {
        this.netServer = server;
        this.logger.info('rigctld server listening', { host: this.host, port: this.port });
        this.emit('listening', { host: this.host, port: this.port });
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.netServer;
    if (!server) return;
    this.netServer = null;
    for (const session of Array.from(this.sessions.values())) {
      session.close();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.logger.info('rigctld server closed');
  }

  private onConnection(socket: Socket): void {
    const id = this.nextClientId++;
    const session = new RigctldSession(
      socket,
      () => ({
        controller: this.controller,
        identity: this.identity,
        readOnly: this._readOnly,
      }),
      this.logger,
      {
        onCommand: (info, cmd, durationMs, ok) => {
          this.emit('commandHandled', { clientId: info.id, command: cmd, durationMs, ok });
        },
        onClose: (info) => {
          this.sessions.delete(info.id);
          this.emit('clientDisconnected', { ...info });
          this.logger.debug('rigctld client disconnected', { peer: info.peer });
        },
      },
      id,
    );
    this.sessions.set(id, session);
    this.emit('clientConnected', { ...session.info });
    this.logger.info('rigctld client connected', { peer: session.info.peer });
  }
}
