import { describe, expect, it } from 'vitest';
import {
  redactSensitiveLogValue,
  redactSensitiveText,
  registerSensitiveLogValue,
  serializeRequestForLog,
} from '../sensitive-log.js';

describe('server sensitive log redaction', () => {
  it('redacts request URLs, authorization values, and registered admin tokens', () => {
    const adminToken = 'txdr_SERVER_LOG_SENTINEL_0123456789_abcdefghijklmnopqrstuvwxyz';
    registerSensitiveLogValue(adminToken);
    const source = [
      `url=/api/example?auth_token=${adminToken}`,
      '#browser_login_code=txdr_blc_secret',
      'Authorization: Bearer signed-jwt-secret',
      `ordinary=${adminToken}`,
    ].join(' ');
    const result = redactSensitiveText(source);

    expect(result).not.toContain(adminToken);
    expect(result).not.toContain('txdr_blc_secret');
    expect(result).not.toContain('signed-jwt-secret');
  });

  it('redacts structured sensitive keys before console or file output', () => {
    expect(redactSensitiveLogValue({
      request: { token: 'secret', access_token: 'access-secret' },
      safe: 'visible',
    })).toEqual({
      request: { token: '<redacted>', access_token: '<redacted>' },
      safe: 'visible',
    });
  });

  it('never exposes query credentials from the Fastify request serializer', () => {
    const serialized = serializeRequestForLog({
      method: 'GET',
      url: '/logbook.html?auth_token=permanent-secret&mode=ft8#browser_login_code=one-time-secret',
      hostname: 'radio.test',
      ip: '127.0.0.1',
    });
    const output = JSON.stringify(serialized);

    expect(output).not.toContain('permanent-secret');
    expect(output).not.toContain('one-time-secret');
    expect(serialized).toMatchObject({
      method: 'GET',
      hostname: 'radio.test',
      remoteAddress: '127.0.0.1',
    });
  });
});
