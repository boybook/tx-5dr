import { describe, expect, it } from 'vitest';

import {
  DeviceUiBootstrapSnapshotSchema,
  DeviceUiWsEventSchema,
  DeviceUiJwtPayloadSchema,
  DeviceUiSessionRequestSchema,
  DeviceUiSessionResponseSchema,
} from '../device-ui.schema.js';

describe('device UI schemas', () => {
  it('accepts the dedicated device UI JWT payload only', () => {
    expect(DeviceUiJwtPayloadSchema.parse({
      typ: 'device-ui',
      aud: 'tx5dr-device-ui',
      deviceId: 'panel-1',
      sessionId: 'session-1',
      iat: 1,
      exp: 2,
    }).aud).toBe('tx5dr-device-ui');

    expect(() => DeviceUiJwtPayloadSchema.parse({
      typ: 'access',
      aud: 'tx5dr-device-ui',
      deviceId: 'panel-1',
      sessionId: 'session-1',
      iat: 1,
      exp: 2,
    })).toThrow();
  });

  it('describes session request and response contracts', () => {
    expect(DeviceUiSessionRequestSchema.parse({ deviceId: 'panel-1', sessionToken: 'secret' }).deviceId).toBe('panel-1');
    expect(DeviceUiSessionResponseSchema.parse({
      jwt: 'jwt',
      deviceId: 'panel-1',
      sessionId: 'session-1',
      expiresAt: 1_700_000_001_000,
    }).sessionId).toBe('session-1');
  });

  it('describes the mode-aware bootstrap snapshot and WS event', () => {
    const snapshot = DeviceUiBootstrapSnapshotSchema.parse({
      server: { status: 'ok', version: 'test', webPort: 8076 },
      engine: { running: true, mode: 'digital', currentMode: { name: 'FT8', slotMs: 15000 }, state: 'running' },
      radio: { connected: true, frequency: 7074000, radioMode: 'USB-D', ptt: false, tx: false },
      ft8: {
        slot: null,
        utc: null,
        cycle: null,
        periodMs: 15000,
        recentDecodeRawMessages: ['CQ TEST AA00'],
        lastDecodeRawMessage: 'CQ TEST AA00',
        recentFrames: [{ snr: -10, freq: 1200, dt: 0.1, message: 'CQ TEST AA00', operatorId: null }],
        currentTx: { active: false, operatorIds: [], messages: [], lastMessage: null, slotStartMs: null },
      },
      voice: {
        active: false,
        radioMode: null,
        pttLocked: false,
        pttLockedByLabel: null,
        keyerActive: false,
        keyerMode: null,
        keyerSlotId: null,
      },
      access: { localUrl: 'http://localhost:8076' },
      updatedAt: 1,
    });

    expect(snapshot.ft8.lastDecodeRawMessage).toBe('CQ TEST AA00');
    expect(DeviceUiWsEventSchema.parse({
      type: 'snapshot',
      payload: snapshot,
      timestamp: '2026-05-14T00:00:00.000Z',
    }).payload.server.status).toBe('ok');
  });
});
