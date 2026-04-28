import { describe, expect, it } from 'vitest';
import { resolveBrowserFacingRequestOrigin } from '../requestOrigin.js';

describe('resolveBrowserFacingRequestOrigin', () => {
  it('prefers the browser Origin over an internal forwarded port from a reverse proxy', () => {
    const origin = resolveBrowserFacingRequestOrigin({
      headers: {
        host: '5dr2.992218.xyz',
        origin: 'https://5dr2.992218.xyz',
        referer: 'https://5dr2.992218.xyz/',
        'x-forwarded-host': '5dr2.992218.xyz',
        'x-forwarded-port': '8076',
        'x-forwarded-proto': 'http',
      },
      requestProtocol: 'http',
      fallbackHost: '127.0.0.1:4000',
    });

    expect(origin).toEqual({
      protocol: 'https',
      host: '5dr2.992218.xyz',
    });
  });

  it('keeps an explicit browser-facing port from Origin when one is present', () => {
    const origin = resolveBrowserFacingRequestOrigin({
      headers: {
        host: '127.0.0.1:4000',
        origin: 'http://localhost:8076',
        referer: 'http://localhost:8076/',
      },
      requestProtocol: 'http',
      fallbackHost: '127.0.0.1:4000',
    });

    expect(origin).toEqual({
      protocol: 'http',
      host: 'localhost:8076',
    });
  });

  it('falls back to forwarded host and forwarded port when no browser origin is available', () => {
    const origin = resolveBrowserFacingRequestOrigin({
      headers: {
        host: '127.0.0.1:4000',
        'x-forwarded-host': 'radio.example.test',
        'x-forwarded-port': '8443',
        'x-forwarded-proto': 'https',
      },
      requestProtocol: 'http',
      fallbackHost: '127.0.0.1:4000',
    });

    expect(origin).toEqual({
      protocol: 'https',
      host: 'radio.example.test:8443',
    });
  });

  it('keeps the API host for intentionally cross-origin API callers', () => {
    const origin = resolveBrowserFacingRequestOrigin({
      headers: {
        host: 'radio.example.test:8076',
        origin: 'https://dashboard.example.test',
      },
      requestProtocol: 'http',
      fallbackHost: '127.0.0.1:4000',
    });

    expect(origin).toEqual({
      protocol: 'http',
      host: 'radio.example.test:8076',
    });
  });
});
