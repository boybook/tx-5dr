import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { PANEL_IPC_MAX_BYTES, PANEL_IPC_VERSION, type DeviceUiModel, type DeviceUiPatch, type PanelIpcEnvelope, type RendererHello, type UiActionPayload } from './messages.js';

interface PendingAck {
  id: string;
  attempts: number;
  message: PanelIpcEnvelope;
  timer: NodeJS.Timeout;
  resolve: (message: PanelIpcEnvelope) => void;
  reject: (error: Error) => void;
}

export class PanelSocketHub extends EventEmitter {
  #server?: Server;
  #active?: Socket;
  #buffer = '';
  #seq = 0;
  #pending = new Map<string, PendingAck>();

  constructor(private readonly options: { socketPath: string; ackTimeoutMs: number; profilePayload: unknown }) {
    super();
  }

  async start(): Promise<void> {
    await rm(this.options.socketPath, { force: true });
    this.#server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.options.socketPath, () => {
        this.#server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    this.#pending.clear();
    this.#active?.destroy();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
    await rm(this.options.socketPath, { force: true });
  }

  async replay(model: DeviceUiModel): Promise<void> {
    if (!this.#active) return;
    await this.sendWithAck('daemon.hello', { protocol: PANEL_IPC_VERSION });
    await this.sendWithAck('panel.config', this.options.profilePayload);
    await this.sendWithAck('state.replace', model);
  }

  sendPatch(patch: DeviceUiPatch): void { this.send('state.patch', patch); }
  sendScreen(screen: string): void { this.send('screen.set', { screen }); }
  sendToast(text: string, level = 'info'): void { this.send('toast.show', { text, level }); }
  sendSpectrum(bins: number[]): void { this.send('spectrum.update', { bins }); }

  async shutdownRenderer(): Promise<void> {
    if (!this.#active) return;
    await this.sendWithAck('renderer.shutdown', {});
  }

  send(t: string, payload?: unknown): void {
    this.write({ v: PANEL_IPC_VERSION, seq: ++this.#seq, t, ts: Date.now(), payload });
  }

  sendWithAck(t: string, payload?: unknown): Promise<PanelIpcEnvelope> {
    const id = `ipc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const message: PanelIpcEnvelope = { v: PANEL_IPC_VERSION, id, seq: ++this.#seq, t, ts: Date.now(), payload };
    return new Promise((resolve, reject) => {
      const pending: PendingAck = { id, attempts: 1, message, resolve, reject, timer: this.createAckTimer(id) };
      this.#pending.set(id, pending);
      this.write(message);
    });
  }

  private handleConnection(socket: Socket): void {
    socket.setEncoding('utf8');
    if (this.#active && !this.#active.destroyed) {
      this.writeTo(this.#active, { v: PANEL_IPC_VERSION, t: 'renderer.replaced', ts: Date.now(), payload: { reason: 'new renderer connected' } });
      this.#active.end();
    }
    this.#active = socket;
    this.#buffer = '';
    socket.on('data', (chunk) => this.handleData(socket, String(chunk)));
    socket.on('close', () => {
      if (this.#active === socket) this.#active = undefined;
      this.emit('disconnect');
    });
    socket.on('error', (error) => this.emit('error', error));
  }

  private handleData(socket: Socket, chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, 'utf8') > PANEL_IPC_MAX_BYTES) {
      this.writeTo(socket, { v: PANEL_IPC_VERSION, t: 'ipc.error', ts: Date.now(), payload: { code: 'message-too-large', maxBytes: PANEL_IPC_MAX_BYTES } });
      this.#buffer = '';
      return;
    }
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim()) this.handleMessage(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  private handleMessage(line: string): void {
    let message: PanelIpcEnvelope;
    try { message = JSON.parse(line) as PanelIpcEnvelope; }
    catch { this.send('ipc.error', { code: 'invalid-json' }); return; }
    if (message.v !== PANEL_IPC_VERSION || typeof message.t !== 'string' || typeof message.ts !== 'number') {
      this.send('ipc.error', { code: 'invalid-envelope' });
      return;
    }
    if (message.id && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)!;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    if (message.t === 'renderer.hello') this.emit('hello', message.payload as RendererHello);
    else if (message.t === 'renderer.ready') this.emit('ready');
    else if (message.t === 'ui.action') this.emit('action', message.payload as UiActionPayload);
    else this.emit('message', message);
  }

  private createAckTimer(id: string): NodeJS.Timeout {
    return setTimeout(() => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      if (pending.attempts < 2) {
        pending.attempts += 1;
        pending.timer = this.createAckTimer(id);
        this.write(pending.message);
        return;
      }
      this.#pending.delete(id);
      pending.reject(new Error(`Renderer ack timed out for ${pending.message.t}`));
      this.emit('ackTimeout', pending.message);
    }, this.options.ackTimeoutMs);
  }

  private write(message: PanelIpcEnvelope): void {
    if (!this.#active || this.#active.destroyed) return;
    this.writeTo(this.#active, message);
  }

  private writeTo(socket: Socket, message: PanelIpcEnvelope): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }
}
