/**
 * 统一日志封装
 * 通过 LOG_LEVEL 环境变量控制输出级别
 *
 * LOG_LEVEL=debug|info|warn|error
 * 默认：production=warn, development=info
 */

const LOG_LEVEL = process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === 'production' ? 'warn' : 'info');

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 0) >= (LEVELS[LOG_LEVEL] ?? 1);
}

export interface Logger {
  debug: (msg: string, ctx?: unknown) => void;
  info: (msg: string, ctx?: unknown) => void;
  warn: (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
}

export function createLogger(module: string): Logger {
  return {
    debug: (msg: string, ctx?: unknown) => {
      if (!shouldLog('debug')) return;
      if (ctx !== undefined) {
        console.debug(`[${module}] ${msg}`, ctx);
      } else {
        console.debug(`[${module}] ${msg}`);
      }
    },
    info: (msg: string, ctx?: unknown) => {
      if (!shouldLog('info')) return;
      if (ctx !== undefined) {
        console.log(`[${module}] ${msg}`, ctx);
      } else {
        console.log(`[${module}] ${msg}`);
      }
    },
    warn: (msg: string, err?: unknown) => {
      if (!shouldLog('warn')) return;
      if (err !== undefined) {
        console.warn(`⚠️ [${module}] ${msg}`, err);
      } else {
        console.warn(`⚠️ [${module}] ${msg}`);
      }
    },
    error: (msg: string, err?: unknown) => {
      if (err !== undefined) {
        console.error(`❌ [${module}] ${msg}`, err);
      } else {
        console.error(`❌ [${module}] ${msg}`);
      }
    },
  };
}
