import { describe, expect, it } from 'vitest';
import { formatLogArgs } from '../console-logger.js';
import { redactSensitiveLogValue } from '../sensitive-log.js';

class RadioError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RadioError';
  }
}

// Mirrors the console interception path: redact first, then format for the file.
function formatAsLogged(...args: unknown[]): string {
  return formatLogArgs(args.map((arg) => redactSensitiveLogValue(arg)));
}

describe('server log file formatting', () => {
  it('keeps the message, stack and diagnostic fields of a top-level error', () => {
    const line = formatAsLogged('[Server] uncaught exception', new RadioError('TCI connect failed: socket hang up', 'CONNECTION_FAILED'));

    expect(line).toContain('RadioError: TCI connect failed: socket hang up');
    expect(line).toContain('"code":"CONNECTION_FAILED"');
    expect(line).not.toBe('[Server] uncaught exception {"name":"RadioError"}');
  });

  it('keeps nested error details inside structured context', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4532'), { code: 'ECONNREFUSED' });
    const line = formatAsLogged('[Bridge] failed', { error: Object.assign(new Error('rigctld unavailable'), { cause }) });
    const parsed = JSON.parse(line.slice('[Bridge] failed '.length)) as {
      error: { name: string; message: string; stack?: string; cause: { message: string; code: string } };
    };

    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('rigctld unavailable');
    expect(parsed.error.stack).toContain('rigctld unavailable');
    expect(parsed.error.cause).toMatchObject({ message: 'connect ECONNREFUSED 127.0.0.1:4532', code: 'ECONNREFUSED' });
  });

  it('still redacts credentials carried by error messages and fields', () => {
    const error = Object.assign(new Error('GET /api?auth_token=secret-value failed'), { token: 'field-secret' });
    const line = formatAsLogged('[Http] request failed', error);

    expect(line).not.toContain('secret-value');
    expect(line).not.toContain('field-secret');
    expect(line).toContain('request failed');
  });
});
