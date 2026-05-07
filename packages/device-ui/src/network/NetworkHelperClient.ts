import { createConnection } from 'node:net';
import type { WifiNetworkSummary } from '../panel/messages.js';
import type { DeviceNetworkState } from '../panel/messages.js';
import type { HotspotOptions, NetworkOperationResult } from './NetworkController.js';

export type NetworkHelperOperation = 'status' | 'scan' | 'connect' | 'disconnect' | 'forget' | 'hotspot-start' | 'hotspot-stop';

export interface NetworkHelperRequest {
  id: string;
  op: NetworkHelperOperation;
  payload?: unknown;
}

export type NetworkHelperResponse<T = unknown> =
  | { id: string; ok: true; result: T }
  | { id: string; ok: false; error: { code: string; message: string; userMessage?: string } };

const TIMEOUTS: Record<NetworkHelperOperation, number> = {
  status: 3000,
  scan: 12000,
  connect: 45000,
  disconnect: 10000,
  forget: 10000,
  'hotspot-start': 20000,
  'hotspot-stop': 10000,
};

export class NetworkHelperClient {
  constructor(private readonly socketPath = '/run/tx5dr/network-helper.sock') {}

  status(): Promise<DeviceNetworkState> { return this.request('status'); }
  scan(): Promise<WifiNetworkSummary[]> { return this.request('scan'); }
  connect(input: { ssid: string; password?: string; hidden?: boolean }): Promise<NetworkOperationResult> { return this.request('connect', input); }
  disconnect(): Promise<NetworkOperationResult> { return this.request('disconnect'); }
  forget(ssid: string): Promise<NetworkOperationResult> { return this.request('forget', { ssid }); }
  startHotspot(options?: Partial<HotspotOptions>): Promise<NetworkOperationResult> { return this.request('hotspot-start', options); }
  stopHotspot(): Promise<NetworkOperationResult> { return this.request('hotspot-stop'); }

  request<T>(op: NetworkHelperOperation, payload?: unknown): Promise<T> {
    const id = `net-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const request: NetworkHelperRequest = { id, op, payload };
    return new Promise<T>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Network helper ${op} timed out after ${TIMEOUTS[op]}ms`));
      }, TIMEOUTS[op]);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        socket.end();
        const response = JSON.parse(buffer.slice(0, newline)) as NetworkHelperResponse<T>;
        if (response.ok) resolve(response.result);
        else reject(Object.assign(new Error(response.error.message), response.error));
      });
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
