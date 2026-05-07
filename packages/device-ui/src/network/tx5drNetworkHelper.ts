#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { promisify } from 'node:util';
import type { DeviceNetworkState, WifiNetworkSummary } from '../panel/messages.js';
import type { HotspotOptions, NetworkOperationResult } from './NetworkController.js';
import type { NetworkHelperOperation, NetworkHelperRequest, NetworkHelperResponse } from './NetworkHelperClient.js';

const execFile = promisify(execFileCb);
const MAX_REQUEST_BYTES = 16 * 1024;
const DEFAULT_SOCKET = '/run/tx5dr/network-helper.sock';
const DEFAULT_DATA_DIR = '/var/lib/tx5dr/device-ui';
const HOTSPOT_PREFIX = 'TX5DR-';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface DeviceRow {
  device: string;
  type: string;
  state: string;
  connection: string;
}

interface ActiveConnectionRow {
  name: string;
  type: string;
  device: string;
}

interface HelperContext {
  dataDir: string;
}

export async function startNetworkHelper(socketPath = process.env.TX5DR_NETWORK_HELPER_SOCKET ?? DEFAULT_SOCKET): Promise<void> {
  const context: HelperContext = { dataDir: process.env.TX5DR_DEVICE_UI_DATA_DIR ?? DEFAULT_DATA_DIR };
  await mkdir(dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });

  const server = createServer(socket => handleSocket(socket, context));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o660);
  console.error(`[tx5dr-network-helper] listening on ${socketPath}`);

  const shutdown = async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(socketPath, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function handleSocket(socket: Socket, context: HelperContext): Promise<void> {
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += String(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > MAX_REQUEST_BYTES) {
      writeResponse(socket, { id: 'unknown', ok: false, error: { code: 'REQUEST_TOO_LARGE', message: 'Request is too large', userMessage: 'Network request is too large.' } });
      socket.end();
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    void handleLine(socket, line, context);
  });
}

async function handleLine(socket: Socket, line: string, context: HelperContext): Promise<void> {
  let request: NetworkHelperRequest;
  try {
    request = JSON.parse(line) as NetworkHelperRequest;
  } catch {
    writeResponse(socket, { id: 'unknown', ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON', userMessage: 'Network helper received an invalid request.' } });
    socket.end();
    return;
  }

  try {
    const result = await runOperation(request.op, request.payload, context);
    writeResponse(socket, { id: request.id, ok: true, result });
  } catch (error) {
    writeResponse(socket, {
      id: request.id,
      ok: false,
      error: normalizeError(error),
    });
  } finally {
    socket.end();
  }
}

async function runOperation(op: NetworkHelperOperation, payload: unknown, context: HelperContext): Promise<unknown> {
  switch (op) {
    case 'status': return getStatus();
    case 'scan': return scanWifi();
    case 'connect': return connectWifi(payload as { ssid: string; password?: string; hidden?: boolean });
    case 'disconnect': return disconnectWifi();
    case 'forget': return forgetWifi((payload as { ssid?: string } | undefined)?.ssid);
    case 'hotspot-start': return startHotspot(payload as Partial<HotspotOptions> | undefined, context);
    case 'hotspot-stop': return stopHotspot();
    default: throw helperError('UNSUPPORTED_OPERATION', `Unsupported network operation: ${op}`, 'Unsupported network operation.');
  }
}

export async function getStatus(): Promise<DeviceNetworkState> {
  const devices = parseDeviceStatus((await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'])).stdout);
  const active = parseActiveConnections((await nmcli(['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'])).stdout);
  const primary = selectPrimaryNetwork(devices, active);
  const wifiDevice = devices.find(row => row.type === 'wifi');
  const ethernetDevice = devices.find(row => row.type === 'ethernet' && row.state === 'connected');
  const ipDevice = primary === 'ethernet' ? ethernetDevice?.device : wifiDevice?.device;
  const ip = ipDevice ? await getDeviceIp(ipDevice) : undefined;
  const wifiSignal = wifiDevice?.state === 'connected' ? await getActiveWifiSignal() : undefined;
  const hotspotConnection = active.find(row => row.type.includes('wireless') && isHotspotName(row.name));

  return {
    primary,
    ethernet: {
      connected: primary === 'ethernet',
      interfaceName: ethernetDevice?.device,
      ip: primary === 'ethernet' ? ip : undefined,
    },
    wifi: {
      supported: Boolean(wifiDevice),
      interfaceName: wifiDevice?.device,
      state: primary === 'wifi' ? 'connected' : 'disconnected',
      ssid: primary === 'wifi' ? wifiDevice?.connection : undefined,
      ip: primary === 'wifi' ? ip : undefined,
      signalPercent: primary === 'wifi' ? wifiSignal : undefined,
      savedNetworks: active.filter(row => row.type.includes('wireless')).map(row => row.name),
    },
    hotspot: {
      active: primary === 'hotspot',
      ssid: hotspotConnection?.name,
      ip: primary === 'hotspot' ? ip : undefined,
      url: primary === 'hotspot' && ip ? `http://${ip}:8076` : undefined,
    },
  };
}

export async function scanWifi(): Promise<WifiNetworkSummary[]> {
  const { stdout } = await nmcli(['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes']);
  return parseWifiScan(stdout);
}

async function connectWifi(input: { ssid: string; password?: string; hidden?: boolean }): Promise<NetworkOperationResult> {
  if (!input?.ssid) throw helperError('SSID_REQUIRED', 'SSID is required', 'Choose a Wi-Fi network first.');
  const args = ['device', 'wifi', 'connect', input.ssid];
  if (input.password) args.push('password', input.password);
  if (input.hidden) args.push('hidden', 'yes');
  await nmcli(args);
  return { ok: true };
}

async function disconnectWifi(): Promise<NetworkOperationResult> {
  const devices = parseDeviceStatus((await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'])).stdout);
  const wifi = devices.find(row => row.type === 'wifi' && row.state === 'connected');
  if (!wifi) return { ok: true, message: 'Wi-Fi already disconnected' };
  await nmcli(['device', 'disconnect', wifi.device]);
  return { ok: true };
}

async function forgetWifi(ssid?: string): Promise<NetworkOperationResult> {
  if (!ssid) throw helperError('SSID_REQUIRED', 'SSID is required', 'Choose a saved Wi-Fi network first.');
  await nmcli(['connection', 'delete', 'id', ssid]);
  return { ok: true };
}

async function startHotspot(options: Partial<HotspotOptions> | undefined, context: HelperContext): Promise<NetworkOperationResult> {
  const credentials = await loadHotspotCredentials(options, context);
  const devices = parseDeviceStatus((await nmcli(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'])).stdout);
  const wifi = options?.interfaceName ?? devices.find(row => row.type === 'wifi')?.device;
  if (!wifi) throw helperError('WIFI_NOT_FOUND', 'No Wi-Fi device found', 'No Wi-Fi device is available for hotspot mode.');
  await nmcli(['device', 'wifi', 'hotspot', 'ifname', wifi, 'ssid', credentials.ssid, 'password', credentials.password]);
  return { ok: true, message: credentials.ssid };
}

async function stopHotspot(): Promise<NetworkOperationResult> {
  const active = parseActiveConnections((await nmcli(['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active'])).stdout);
  const hotspot = active.find(row => row.type.includes('wireless') && isHotspotName(row.name));
  if (!hotspot) return { ok: true, message: 'Hotspot already stopped' };
  await nmcli(['connection', 'down', 'id', hotspot.name]);
  return { ok: true };
}

async function loadHotspotCredentials(options: Partial<HotspotOptions> | undefined, context: HelperContext): Promise<HotspotOptions> {
  const file = join(context.dataDir, 'hotspot.json');
  if (options?.ssid && options.password) {
    await persistHotspot(file, options.ssid, options.password);
    return { ssid: options.ssid, password: options.password, interfaceName: options.interfaceName };
  }
  try {
    const stored = JSON.parse(await readFile(file, 'utf8')) as HotspotOptions;
    if (stored.ssid && stored.password) return { ...stored, interfaceName: options?.interfaceName };
  } catch {
    // Create below.
  }
  const suffix = randomBytes(3).toString('hex');
  const credentials = { ssid: `${HOTSPOT_PREFIX}${suffix}`, password: randomCrockfordPassword(), interfaceName: options?.interfaceName };
  await persistHotspot(file, credentials.ssid, credentials.password);
  return credentials;
}

async function persistHotspot(file: string, ssid: string, password: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ssid, password }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function getDeviceIp(device: string): Promise<string | undefined> {
  const { stdout } = await nmcli(['-g', 'IP4.ADDRESS', 'device', 'show', device]);
  const line = stdout.split('\n').map(item => item.trim()).find(Boolean);
  return line?.split('/')[0];
}

async function getActiveWifiSignal(): Promise<number | undefined> {
  const { stdout } = await nmcli(['-t', '-f', 'IN-USE,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'no']);
  const active = stdout.split('\n').find(line => line.startsWith('*:'));
  const signal = active?.split(':')[1];
  return signal ? Number(signal) : undefined;
}

async function nmcli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFile('nmcli', args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw helperError('NMCLI_FAILED', error instanceof Error ? error.message : 'nmcli failed', 'Network operation failed.');
  }
}

export function parseDeviceStatus(output: string): DeviceRow[] {
  return output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [device = '', type = '', state = '', connection = ''] = splitNmcliLine(line);
    return { device, type, state, connection };
  });
}

export function parseActiveConnections(output: string): ActiveConnectionRow[] {
  return output.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [name = '', type = '', device = ''] = splitNmcliLine(line);
    return { name, type, device };
  });
}

export function parseWifiScan(output: string): WifiNetworkSummary[] {
  const bySsid = new Map<string, WifiNetworkSummary>();
  for (const line of output.split('\n').map(item => item.trim()).filter(Boolean)) {
    const [ssid = '', signal = '0', security = ''] = splitNmcliLine(line);
    if (!ssid) continue;
    const summary = { ssid, signalPercent: Number(signal) || 0, security: security ? security.split(/\s+/).filter(Boolean) : [] };
    const existing = bySsid.get(ssid);
    if (!existing || existing.signalPercent < summary.signalPercent) bySsid.set(ssid, summary);
  }
  return Array.from(bySsid.values()).sort((a, b) => b.signalPercent - a.signalPercent);
}

export function selectPrimaryNetwork(devices: DeviceRow[], active: ActiveConnectionRow[]): DeviceNetworkState['primary'] {
  if (devices.some(row => row.type === 'ethernet' && row.state === 'connected')) return 'ethernet';
  const wifi = devices.find(row => row.type === 'wifi' && row.state === 'connected');
  if (!wifi) return 'offline';
  const activeWifi = active.find(row => row.device === wifi.device);
  return activeWifi && isHotspotName(activeWifi.name) ? 'hotspot' : 'wifi';
}

function splitNmcliLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let escaping = false;
  for (const char of line) {
    if (escaping) {
      current += char;
      escaping = false;
    } else if (char === '\\') {
      escaping = true;
    } else if (char === ':') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function isHotspotName(name: string): boolean {
  return name === 'Hotspot' || name.startsWith(HOTSPOT_PREFIX);
}

function randomCrockfordPassword(): string {
  const chars = Array.from({ length: 12 }, () => CROCKFORD[randomBytes(1)[0]! % CROCKFORD.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

function writeResponse<T>(socket: Socket, response: NetworkHelperResponse<T>): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function helperError(code: string, message: string, userMessage: string): Error & { code: string; userMessage: string } {
  return Object.assign(new Error(message), { code, userMessage });
}

function normalizeError(error: unknown): { code: string; message: string; userMessage?: string } {
  if (error instanceof Error) {
    const typed = error as Error & { code?: string; userMessage?: string };
    return { code: typed.code ?? 'NETWORK_HELPER_ERROR', message: typed.message, userMessage: typed.userMessage };
  }
  return { code: 'NETWORK_HELPER_ERROR', message: String(error), userMessage: 'Network helper failed.' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startNetworkHelper();
}
