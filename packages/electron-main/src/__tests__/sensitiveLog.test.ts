import { describe, expect, it } from 'vitest';
import {
  redactSensitiveLogValue,
  redactSensitiveText,
  registerSensitiveLogValue,
} from '../sensitiveLog.js';

describe('Electron sensitive log redaction', () => {
  it('redacts credential query parameters and fragments', () => {
    const value = 'open https://radio.test/?auth_token=legacy-secret#browser_login_code=one-time-secret';
    const redacted = redactSensitiveText(value);

    expect(redacted).not.toContain('legacy-secret');
    expect(redacted).not.toContain('one-time-secret');
    expect(redacted).toContain('auth_token=<redacted>');
    expect(redacted).toContain('browser_login_code=<redacted>');
  });

  it('redacts registered high-entropy secrets even inside ordinary text', () => {
    const sentinel = 'txdr_LOG_SENTINEL_0123456789_abcdefghijklmnopqrstuvwxyz';
    registerSensitiveLogValue(sentinel);

    expect(redactSensitiveText(`unexpected value ${sentinel} leaked`)).toBe(
      'unexpected value <redacted> leaked',
    );
  });

  it('redacts structured credentials recursively', () => {
    expect(redactSensitiveLogValue({
      nested: { token: 'secret-token', jwt: 'secret-jwt' },
      authorization: 'Bearer secret',
      safe: 'visible',
    })).toEqual({
      nested: { token: '<redacted>', jwt: '<redacted>' },
      authorization: '<redacted>',
      safe: 'visible',
    });
  });
});
