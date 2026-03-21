/**
 * Browser-safe logger.
 * debug/info are only output in development builds (import.meta.env.DEV).
 * warn/error always output.
 */

const isDev = import.meta.env.DEV;

export interface Logger {
  debug: (msg: string, ctx?: unknown) => void;
  info:  (msg: string, ctx?: unknown) => void;
  warn:  (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx) => {
      if (!isDev) return;
      ctx !== undefined ? console.debug(`[${module}] ${msg}`, ctx) : console.debug(`[${module}] ${msg}`);
    },
    info: (msg, ctx) => {
      if (!isDev) return;
      ctx !== undefined ? console.log(`[${module}] ${msg}`, ctx) : console.log(`[${module}] ${msg}`);
    },
    warn: (msg, err) => {
      err !== undefined ? console.warn(`[${module}] ${msg}`, err) : console.warn(`[${module}] ${msg}`);
    },
    error: (msg, err) => {
      err !== undefined ? console.error(`[${module}] ${msg}`, err) : console.error(`[${module}] ${msg}`);
    },
  };
}
