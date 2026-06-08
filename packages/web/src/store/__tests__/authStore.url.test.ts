import { describe, expect, it } from 'vitest';
import { buildUrlWithoutAuthToken } from '../authStore';

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
});
