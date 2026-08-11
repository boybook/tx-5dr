/**
 * Electron main process logger, backed by electron-log.
 * Provides the same createLogger() API as server and web packages.
 */

import log from 'electron-log/main';
import { redactSensitiveLogValue, redactSensitiveText } from '../sensitiveLog.js';

export interface Logger {
  debug: (msg: string, ctx?: unknown) => void;
  info:  (msg: string, ctx?: unknown) => void;
  warn:  (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx) => {
      const safeMessage = redactSensitiveText(`[${module}] ${msg}`);
      ctx !== undefined ? log.debug(safeMessage, redactSensitiveLogValue(ctx)) : log.debug(safeMessage);
    },
    info: (msg, ctx) => {
      const safeMessage = redactSensitiveText(`[${module}] ${msg}`);
      ctx !== undefined ? log.info(safeMessage, redactSensitiveLogValue(ctx)) : log.info(safeMessage);
    },
    warn: (msg, err) => {
      const safeMessage = redactSensitiveText(`[${module}] ${msg}`);
      err !== undefined ? log.warn(safeMessage, redactSensitiveLogValue(err)) : log.warn(safeMessage);
    },
    error: (msg, err) => {
      const safeMessage = redactSensitiveText(`[${module}] ${msg}`);
      err !== undefined ? log.error(safeMessage, redactSensitiveLogValue(err)) : log.error(safeMessage);
    },
  };
}
