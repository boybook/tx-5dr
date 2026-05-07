import type { DeviceMonitorState, DeviceNetworkState, DeviceScreen, DeviceTx5drState } from '../panel/messages.js';

export function chooseDefaultScreen(network: DeviceNetworkState, tx5dr?: DeviceTx5drState, monitor?: DeviceMonitorState): DeviceScreen {
  if (tx5dr?.radio.ptt || monitor?.currentTx) return 'monitor';
  if (network.hotspot.active) return 'hotspot';
  if (network.primary === 'offline') return 'network-overview';
  return 'access';
}
