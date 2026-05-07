import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { DeviceServerSnapshot } from './DeviceServerEventMapper.js';

export interface PairingCodeResponse { id: string; code: string; url?: string; expiresAt: number }

export class ServerApiClient extends EventEmitter {
  #jwt?: string;

  constructor(private readonly options: { baseUrl: string; tokenPath: string; deviceId: string }) {
    super();
  }

  async createSession(): Promise<string> {
    const token = (await readFile(this.options.tokenPath, 'utf8')).trim();
    const response = await fetch(new URL('/api/device-ui/session', this.options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: token, deviceId: this.options.deviceId }),
    });
    if (!response.ok) throw new Error(`Device session failed: HTTP ${response.status}`);
    const body = await response.json() as { token?: string; jwt?: string };
    this.#jwt = body.token ?? body.jwt;
    if (!this.#jwt) throw new Error('Device session response did not include a JWT');
    return this.#jwt;
  }

  async bootstrap(): Promise<DeviceServerSnapshot> {
    const response = await this.request<DeviceServerSnapshot | { model: DeviceServerSnapshot }>('/api/device-ui/bootstrap');
    return 'model' in response ? response.model : response;
  }

  async requestPairingCode(): Promise<PairingCodeResponse> {
    return this.request<PairingCodeResponse>('/api/device-ui/pairing-code', { method: 'POST' });
  }

  async connectEvents(): Promise<void> {
    if (!this.#jwt) await this.createSession();
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: URL) => { addEventListener: (type: string, listener: (event: any) => void) => void } }).WebSocket;
    if (!WebSocketCtor) {
      this.emit('error', new Error('global WebSocket is unavailable in this Node runtime'));
      return;
    }
    const wsUrl = new URL('/api/device-ui/ws', this.options.baseUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('token', this.#jwt!);
    const ws = new WebSocketCtor(wsUrl);
    ws.addEventListener('message', (event: { data: unknown }) => {
      try { this.emit('event', JSON.parse(String(event.data))); }
      catch (error) { this.emit('error', error); }
    });
    ws.addEventListener('error', () => this.emit('error', new Error('Device UI websocket error')));
    ws.addEventListener('close', () => this.emit('close'));
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.#jwt) await this.createSession();
    const response = await fetch(new URL(path, this.options.baseUrl), {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.#jwt}` },
    });
    if (!response.ok) throw new Error(`${path} failed: HTTP ${response.status}`);
    return await response.json() as T;
  }
}
