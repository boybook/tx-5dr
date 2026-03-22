/**
 * Unified logger for server.
 * Controls console output level via LOG_LEVEL env var.
 * File persistence is handled by ConsoleLogger's console override.
 *
 * LOG_LEVEL=debug|info|warn|error
 * Default: production=warn, development=info
 */

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let _logLevel: string = process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'warn' : 'info');

/**
 * Override the active log level at runtime (e.g. from config file).
 * Unknown levels are silently ignored.
 */
export function setLogLevel(level: string): void {
  if (LEVELS[level] !== undefined) {
    _logLevel = level;
  }
}

export function getActiveLogLevel(): string {
  return _logLevel;
}

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 0) >= (LEVELS[_logLevel] ?? 1);
}

export interface Logger {
  debug: (msg: string, ctx?: unknown) => void;
  info:  (msg: string, ctx?: unknown) => void;
  warn:  (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg: string, ctx?: unknown) => {
      if (!shouldLog('debug')) return;
      ctx !== undefined ? console.debug(`[${module}] ${msg}`, ctx) : console.debug(`[${module}] ${msg}`);
    },
    info: (msg: string, ctx?: unknown) => {
      if (!shouldLog('info')) return;
      ctx !== undefined ? console.log(`[${module}] ${msg}`, ctx) : console.log(`[${module}] ${msg}`);
    },
    warn: (msg: string, err?: unknown) => {
      if (!shouldLog('warn')) return;
      err !== undefined ? console.warn(`[${module}] ${msg}`, err) : console.warn(`[${module}] ${msg}`);
    },
    error: (msg: string, err?: unknown) => {
      err !== undefined ? console.error(`[${module}] ${msg}`, err) : console.error(`[${module}] ${msg}`);
    },
  };
}
