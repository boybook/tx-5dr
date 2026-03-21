/**
 * Cross-environment logger for @tx5dr/core.
 * - Node.js: level controlled by process.env.LOG_LEVEL (default info in dev, warn in prod)
 * - Browser: defaults to info level (debug suppressed)
 * No file writing — runtime environments (server/web) handle persistence.
 */

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getLogLevel(): string {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.LOG_LEVEL ||
      (process.env.NODE_ENV === 'production' ? 'warn' : 'info');
  }
  return 'info'; // browser default: suppress debug
}

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 0) >= (LEVELS[getLogLevel()] ?? 1);
}

export interface Logger {
  debug: (msg: string, ctx?: unknown) => void;
  info:  (msg: string, ctx?: unknown) => void;
  warn:  (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx) => {
      if (!shouldLog('debug')) return;
      ctx !== undefined ? console.debug(`[${module}] ${msg}`, ctx) : console.debug(`[${module}] ${msg}`);
    },
    info: (msg, ctx) => {
      if (!shouldLog('info')) return;
      ctx !== undefined ? console.log(`[${module}] ${msg}`, ctx) : console.log(`[${module}] ${msg}`);
    },
    warn: (msg, err) => {
      if (!shouldLog('warn')) return;
      err !== undefined ? console.warn(`[${module}] ${msg}`, err) : console.warn(`[${module}] ${msg}`);
    },
    error: (msg, err) => {
      err !== undefined ? console.error(`[${module}] ${msg}`, err) : console.error(`[${module}] ${msg}`);
    },
  };
}
