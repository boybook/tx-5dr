import type { DeviceAccessState, DeviceNetworkState, DeviceTx5drState } from '../panel/messages.js';

export class AccessUrlController {
  compose(network: DeviceNetworkState, tx5dr: DeviceTx5drState): DeviceAccessState {
    const url = this.pickUrl(network, tx5dr);
    return { url, hostname: url ? new URL(url).hostname : undefined, qrKind: 'access-url' };
  }

  pickUrl(network: DeviceNetworkState, tx5dr: DeviceTx5drState): string | undefined {
    if (network.primary === 'ethernet' && network.ethernet.url) return network.ethernet.url;
    if (network.primary === 'wifi' && network.wifi.ip) return `http://${network.wifi.ip}:${tx5dr.webPort ?? 8076}`;
    if (network.primary === 'hotspot' && network.hotspot.url) return network.hotspot.url;
    return tx5dr.webUrls[0];
  }
}
