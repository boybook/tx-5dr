import { describe, expect, it } from 'vitest';
import { parseActiveConnections, parseDeviceStatus, parseWifiScan, selectPrimaryNetwork } from '../tx5drNetworkHelper.js';

describe('tx5drNetworkHelper', () => {
  it('selects ethernet before wifi and hotspot', () => {
    const devices = parseDeviceStatus([
      'eth0:ethernet:connected:Wired connection 1',
      'wlan0:wifi:connected:TX5DR-a1b2c3',
    ].join('\n'));
    const active = parseActiveConnections([
      'Wired connection 1:802-3-ethernet:eth0',
      'TX5DR-a1b2c3:802-11-wireless:wlan0',
    ].join('\n'));

    expect(selectPrimaryNetwork(devices, active)).toBe('ethernet');
  });

  it('detects hotspot from active wireless connection name', () => {
    const devices = parseDeviceStatus('wlan0:wifi:connected:TX5DR-a1b2c3');
    const active = parseActiveConnections('TX5DR-a1b2c3:802-11-wireless:wlan0');
    expect(selectPrimaryNetwork(devices, active)).toBe('hotspot');
  });

  it('parses and de-duplicates wifi scan results by strongest SSID', () => {
    const results = parseWifiScan([
      'Field\\:Day:62:WPA2',
      'BG5DRB:86:WPA2 WPA3',
      'BG5DRB:40:WPA2',
      'OpenRadio:38:',
    ].join('\n'));

    expect(results).toEqual([
      { ssid: 'BG5DRB', signalPercent: 86, security: ['WPA2', 'WPA3'] },
      { ssid: 'Field:Day', signalPercent: 62, security: ['WPA2'] },
      { ssid: 'OpenRadio', signalPercent: 38, security: [] },
    ]);
  });
});
