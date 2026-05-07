import type { DeviceNetworkState, WifiNetworkSummary } from '../panel/messages.js';

export interface NetworkOperationResult {
  ok: boolean;
  code?: string;
  message?: string;
  userMessage?: string;
}

export interface HotspotOptions { ssid: string; password: string; interfaceName?: string }

export interface NetworkController {
  getStatus(): Promise<DeviceNetworkState>;
  scanWifi(): Promise<WifiNetworkSummary[]>;
  connectWifi(input: { ssid: string; password?: string; hidden?: boolean }): Promise<NetworkOperationResult>;
  disconnectWifi(): Promise<NetworkOperationResult>;
  forgetWifi(ssid: string): Promise<NetworkOperationResult>;
  startHotspot(options?: Partial<HotspotOptions>): Promise<NetworkOperationResult>;
  stopHotspot(): Promise<NetworkOperationResult>;
}

export function readonlyNetworkState(reason = 'Network helper not installed'): DeviceNetworkState {
  return {
    primary: 'offline',
    ethernet: { connected: false },
    wifi: { supported: false, state: 'failed', savedNetworks: [], lastError: reason },
    hotspot: { active: false },
  };
}
