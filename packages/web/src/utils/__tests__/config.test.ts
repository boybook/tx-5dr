import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWsUrl } from '../config';

function stubLocation(rawUrl: string): void {
  const url = new URL(rawUrl);
  vi.stubGlobal('window', {
    location: {
      protocol: url.protocol,
      host: url.host,
      hostname: url.hostname,
      port: url.port,
    },
  });
}

describe('normalizeWsUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps realtime websocket URLs on the current browser origin when an internal port leaked', () => {
    stubLocation('https://5dr2.992218.xyz/');

    expect(normalizeWsUrl('ws://5dr2.992218.xyz:8076/api/realtime/ws-compat')).toBe(
      'wss://5dr2.992218.xyz/api/realtime/ws-compat',
    );
  });

  it('preserves a different websocket host', () => {
    stubLocation('https://5dr2.992218.xyz/');

    expect(normalizeWsUrl('ws://radio.example.test:8076/api/realtime/ws-compat')).toBe(
      'wss://radio.example.test:8076/api/realtime/ws-compat',
    );
  });
});
