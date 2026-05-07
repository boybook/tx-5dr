import { describe, expect, it } from 'vitest';
import { createInitialModel } from '../../app/DeviceUiStateStore.js';
import { mapServerEventToPatches } from '../DeviceServerEventMapper.js';

describe('DeviceServerEventMapper', () => {
  it('maps device websocket state.patch events into panel patches', () => {
    const current = createInitialModel({ deviceId: 'd', profileId: 'p' });
    const patches = mapServerEventToPatches({
      type: 'state.patch',
      data: {
        ops: [
          { path: 'page', value: 'monitor' },
          {
            path: 'radio',
            value: {
              serverConnected: true,
              engineState: 'running',
              radioConnected: true,
              frequencyHz: 7074000,
              mode: 'FT8',
              band: '40m',
              pttActive: true,
              txOperatorIds: ['op1'],
              txText: 'CQ BG5DRB OL63',
              slotSecondsRemaining: 8,
            },
          },
          { path: 'spectrum', value: { timestamp: 10, bins: [0, 0.5, 1], peakBin: 2 } },
        ],
      },
    }, current);

    expect(patches[0]).toEqual({ path: 'screen', value: 'monitor' });
    expect(patches).toContainEqual(expect.objectContaining({
      path: 'tx5dr',
      value: expect.objectContaining({
        engine: expect.objectContaining({ isRunning: true, mode: 'FT8', nextSlotInMs: 8000 }),
        radio: expect.objectContaining({ ptt: true, frequencyLabel: '7.074 MHz' }),
      }),
    }));
    expect(patches).toContainEqual(expect.objectContaining({
      path: 'monitor',
      value: expect.objectContaining({ spectrum: { available: true, bins: [0, 50, 100], updatedAt: 10 } }),
    }));
  });

  it('maps server state.replace events emitted by DeviceUiWSServer', () => {
    const current = createInitialModel({ deviceId: 'd', profileId: 'p' });
    const patches = mapServerEventToPatches({
      type: 'state.replace',
      data: {
        schemaVersion: 1,
        page: 'access',
        updatedAt: 1,
        device: { id: 'server', profile: 'server-projection', renderer: 'device-ui-ws' },
        network: { kind: 'wifi', connected: true, interfaceName: 'wlan0', ssid: 'Field', ipAddress: '192.168.1.20', signalPercent: 80, helperAvailable: true },
        access: { url: 'http://192.168.1.20:8076', qrText: 'http://192.168.1.20:8076', pairingCode: null, pairingExpiresAt: null, browserClientCount: 2 },
        radio: { serverConnected: true, engineState: 'idle', radioConnected: false, frequencyHz: null, mode: 'FT8', band: null, pttActive: false, txOperatorIds: [], txText: null, slotSecondsRemaining: null },
        spectrum: { timestamp: 1, bins: [], peakBin: null },
        recentMessages: [],
        alert: null,
      },
    }, current);

    expect(patches).toContainEqual(expect.objectContaining({
      path: 'network',
      value: expect.objectContaining({ primary: 'wifi', wifi: expect.objectContaining({ ssid: 'Field', ip: '192.168.1.20' }) }),
    }));
    expect(patches).toContainEqual({ path: 'access', value: { url: 'http://192.168.1.20:8076', pairingCode: undefined, expiresAt: undefined, qrKind: 'access-url' } });
  });
});
