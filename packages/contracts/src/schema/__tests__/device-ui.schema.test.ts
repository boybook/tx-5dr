import { describe, expect, it } from 'vitest';
import {
  DeviceServiceJwtPayloadSchema,
  DeviceUiModelSchema,
  DeviceUiPatchOpSchema,
  DeviceUiServerEventSchema,
} from '../device-ui.schema.js';

function createModel() {
  return {
    schemaVersion: 1,
    page: 'access',
    updatedAt: 1,
    device: { id: 'abc123', profile: 'tft-ili9486-320x480-touch', renderer: 'tx5dr-panel-lvgl' },
    network: { kind: 'wifi', connected: true, interfaceName: 'wlan0', ssid: 'Lab', ipAddress: '192.168.1.50', signalPercent: 88, helperAvailable: true },
    access: { url: 'http://192.168.1.50:8076', qrText: 'http://192.168.1.50:8076', pairingCode: '123456', pairingExpiresAt: 2, browserClientCount: 1 },
    radio: { serverConnected: true, engineState: 'running', radioConnected: true, frequencyHz: 14074000, mode: 'FT8', band: '20m', pttActive: false, txOperatorIds: [], txText: null, slotSecondsRemaining: 9 },
    spectrum: { timestamp: 1, bins: [0, 0.5, 1], peakBin: 2 },
    recentMessages: [{ id: 'm1', timestamp: 1, direction: 'rx', text: 'CQ TEST', callsign: 'TEST', related: true, snr: -10 }],
    alert: null,
  } as const;
}

describe('device-ui contracts', () => {
  it('accepts the locked MVP state model', () => {
    expect(DeviceUiModelSchema.parse(createModel()).page).toBe('access');
  });

  it('accepts typed patches instead of generic JSON patch', () => {
    const patch = DeviceUiPatchOpSchema.parse({ path: 'page', value: 'monitor' });
    expect(patch).toEqual({ path: 'page', value: 'monitor' });
  });

  it('requires the dedicated device JWT audience', () => {
    expect(DeviceServiceJwtPayloadSchema.parse({ sub: 'd1', deviceId: 'd1', aud: 'tx5dr-device-ui', scope: 'device-ui', iat: 1, exp: 2 }).aud).toBe('tx5dr-device-ui');
    expect(() => DeviceServiceJwtPayloadSchema.parse({ sub: 'd1', deviceId: 'd1', aud: 'wrong', scope: 'device-ui', iat: 1, exp: 2 })).toThrow();
  });

  it('validates websocket event envelopes', () => {
    const event = DeviceUiServerEventSchema.parse({ type: 'state.replace', data: createModel() });
    expect(event.type).toBe('state.replace');
  });
});
