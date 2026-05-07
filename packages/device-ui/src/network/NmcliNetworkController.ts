import type { DeviceNetworkState, WifiNetworkSummary } from '../panel/messages.js';
import type { NetworkController, NetworkOperationResult, HotspotOptions } from './NetworkController.js';
import { readonlyNetworkState } from './NetworkController.js';
import { NetworkHelperClient } from './NetworkHelperClient.js';

export class NmcliNetworkController implements NetworkController {
  constructor(private readonly helper: NetworkHelperClient) {}

  async getStatus(): Promise<DeviceNetworkState> {
    try { return await this.helper.status(); }
    catch (error) { return readonlyNetworkState(error instanceof Error ? error.message : 'Network helper unavailable'); }
  }

  scanWifi(): Promise<WifiNetworkSummary[]> { return this.helper.scan(); }
  connectWifi(input: { ssid: string; password?: string; hidden?: boolean }): Promise<NetworkOperationResult> { return this.helper.connect(input); }
  disconnectWifi(): Promise<NetworkOperationResult> { return this.helper.disconnect(); }
  forgetWifi(ssid: string): Promise<NetworkOperationResult> { return this.helper.forget(ssid); }
  startHotspot(options?: Partial<HotspotOptions>): Promise<NetworkOperationResult> { return this.helper.startHotspot(options); }
  stopHotspot(): Promise<NetworkOperationResult> { return this.helper.stopHotspot(); }
}
