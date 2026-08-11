import { describe, expect, it } from 'vitest';
import {
  buildUrlWithoutAuthCredentials,
  buildUrlWithoutAuthToken,
  authenticateUrlCredentials,
  getBrowserLoginCode,
} from '../authStore';

describe('auth URL token cleanup', () => {
  it('removes only auth_token and preserves page parameters', () => {
    expect(buildUrlWithoutAuthToken({
      pathname: '/logbook.html',
      search: '?operatorId=op-1&auth_token=secret&logBookId=book-1',
      hash: '#recent',
    })).toBe('/logbook.html?operatorId=op-1&logBookId=book-1#recent');
  });

  it('drops the query separator when auth_token was the only parameter', () => {
    expect(buildUrlWithoutAuthToken({
      pathname: '/',
      search: '?auth_token=secret',
      hash: '',
    })).toBe('/');
  });

  it('removes a one-time browser code fragment while preserving query parameters', () => {
    expect(buildUrlWithoutAuthCredentials({
      pathname: '/logbook.html',
      search: '?operatorId=op-1',
      hash: '#browser_login_code=txdr_blc_secret',
    })).toBe('/logbook.html?operatorId=op-1');
  });

  it('captures both credential forms and removes them together', () => {
    const location = {
      pathname: '/spectrum.html',
      search: '?auth_token=legacy-secret&mode=ft8',
      hash: '#browser_login_code=txdr_blc_secret',
    };

    expect(getBrowserLoginCode(location.hash)).toBe('txdr_blc_secret');
    expect(buildUrlWithoutAuthCredentials(location)).toBe('/spectrum.html?mode=ft8');
  });

  it('does not alter unrelated fragments', () => {
    expect(buildUrlWithoutAuthCredentials({
      pathname: '/',
      search: '',
      hash: '#recent',
    })).toBe('/#recent');
  });

  it('prefers a one-time code over a legacy sharing token', async () => {
    const response = {
      jwt: 'jwt',
      role: 'admin' as const,
      label: 'Admin',
      operatorIds: [],
    };
    const calls: string[] = [];
    const result = await authenticateUrlCredentials({
      browserLoginCode: 'one-time-code',
      legacyToken: 'legacy-token',
    }, {
      exchangeBrowserLoginCode: async ({ code }) => {
        calls.push(`code:${code}`);
        return response;
      },
      login: async (token) => {
        calls.push(`token:${token}`);
        return response;
      },
    });

    expect(result).toBe(response);
    expect(calls).toEqual(['code:one-time-code']);
  });

  it('falls back to a captured legacy token after code exchange fails', async () => {
    const response = {
      jwt: 'jwt',
      role: 'admin' as const,
      label: 'Admin',
      operatorIds: [],
    };
    const calls: string[] = [];
    const result = await authenticateUrlCredentials({
      browserLoginCode: 'expired-code',
      legacyToken: 'legacy-token',
    }, {
      exchangeBrowserLoginCode: async ({ code }) => {
        calls.push(`code:${code}`);
        throw new Error('expired');
      },
      login: async (token) => {
        calls.push(`token:${token}`);
        return response;
      },
    });

    expect(result).toBe(response);
    expect(calls).toEqual(['code:expired-code', 'token:legacy-token']);
  });
});
