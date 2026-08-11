const SENSITIVE_KEYS = new Set([
  'auth_token',
  'browser_login_code',
  'token',
  'access_token',
  'jwt',
  'authorization',
]);

const sensitiveValues = new Set<string>();

export function registerSensitiveLogValue(value: string | null | undefined): void {
  if (value && value.length >= 8) sensitiveValues.add(value);
}

export function redactSensitiveText(value: string): string {
  let redacted = value
    .replace(/([?&#](?:auth_token|browser_login_code|token|access_token|jwt|authorization)=)[^&#\s]*/gi, '$1<redacted>')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;}]+/gi, '$1<redacted>')
    .replace(/((?:"|')?(?:auth_token|browser_login_code|token|access_token|jwt|authorization)(?:"|')?\s*[:=]\s*(?:"|')?)[^"'&#\s,;}]+/gi, '$1<redacted>');

  for (const secret of sensitiveValues) {
    redacted = redacted.split(secret).join('<redacted>');
  }
  return redacted;
}

export function redactSensitiveLogValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '<circular>';
  seen.add(value);

  if (value instanceof Error) {
    const error = new Error(redactSensitiveText(value.message));
    error.name = value.name;
    error.stack = value.stack ? redactSensitiveText(value.stack) : undefined;
    return error;
  }

  if (Array.isArray(value)) return value.map(item => redactSensitiveLogValue(item, seen));

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? '<redacted>'
      : redactSensitiveLogValue(item, seen);
  }
  return result;
}

export function installElectronLogRedaction(logInstance: typeof electronLog): void {
  logInstance.hooks.push((message) => {
    message.data = message.data.map(item => redactSensitiveLogValue(item));
    return message;
  });
}
import type electronLog from 'electron-log/main';
