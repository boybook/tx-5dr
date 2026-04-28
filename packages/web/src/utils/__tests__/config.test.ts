import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeWsUrl } from '../config';

function stubLocation(rawUrl: string): void {
  const url = new URL(rawUrl);
  vi.stubGlobal('window', {
    location: {
      href: url.href,
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
      'wss://5dr2.992218.xyz/api/realtime/ws-compat',
    );
  });

  it('uses the Electron/local page origin for realtime websocket offers', () => {
    stubLocation('http://127.0.0.1:8076/');

    expect(normalizeWsUrl('wss://5dr2.992218.xyz:8076/api/realtime/rtc-data-audio')).toBe(
      'ws://127.0.0.1:8076/api/realtime/rtc-data-audio',
    );
  });

  it('resolves relative realtime websocket paths against the current page origin', () => {
    stubLocation('https://5dr2.992218.xyz/');

    expect(normalizeWsUrl('/api/realtime/ws-compat')).toBe(
      'wss://5dr2.992218.xyz/api/realtime/ws-compat',
    );
  });
});
