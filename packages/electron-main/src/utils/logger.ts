/**
 * Electron main process logger, backed by electron-log.
 * Provides the same createLogger() API as server and web packages.
 */

import log from 'electron-log/main';

export interface Logger {
  debug: (msg: string, ctx?: unknown) => void;
  info:  (msg: string, ctx?: unknown) => void;
  warn:  (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx) => {
      ctx !== undefined ? log.debug(`[${module}] ${msg}`, ctx) : log.debug(`[${module}] ${msg}`);
    },
    info: (msg, ctx) => {
      ctx !== undefined ? log.info(`[${module}] ${msg}`, ctx) : log.info(`[${module}] ${msg}`);
    },
    warn: (msg, err) => {
      err !== undefined ? log.warn(`[${module}] ${msg}`, err) : log.warn(`[${module}] ${msg}`);
    },
    error: (msg, err) => {
      err !== undefined ? log.error(`[${module}] ${msg}`, err) : log.error(`[${module}] ${msg}`);
    },
  };
}
