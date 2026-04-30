/**
 * Unified logger for server.
 * Controls console output level via LOG_LEVEL env var.
 * File persistence is handled by ConsoleLogger's console override.
 *
 * LOG_LEVEL=debug|info|warn|error
 * Default: info. Debug is intentionally opt-in and module-scoped to avoid
 * blocking realtime audio with noisy stdout/log-file output.
 *
 * TX5DR_DEBUG_MODULES examples:
 *   VoiceTxOutputPipeline,VoiceTxJitterController
 *   realtime*
 *   *
 */

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let _logLevel: string = process.env.LOG_LEVEL || 'info';

function parseDebugModules(): string[] {
  return (process.env.TX5DR_DEBUG_MODULES || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

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

function isDebugModuleEnabled(module: string): boolean {
  const patterns = parseDebugModules();
  if (patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => {
    if (pattern === '*') {
      return true;
    }
    if (pattern.endsWith('*')) {
      return module.startsWith(pattern.slice(0, -1));
    }
    return module === pattern;
  });
}

function shouldLog(level: string, module: string): boolean {
  if (level === 'debug' && !isDebugModuleEnabled(module)) {
    return false;
  }
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
      if (!shouldLog('debug', module)) return;
      ctx !== undefined ? console.debug(`[${module}] ${msg}`, ctx) : console.debug(`[${module}] ${msg}`);
    },
    info: (msg: string, ctx?: unknown) => {
      if (!shouldLog('info', module)) return;
      ctx !== undefined ? console.log(`[${module}] ${msg}`, ctx) : console.log(`[${module}] ${msg}`);
    },
    warn: (msg: string, err?: unknown) => {
      if (!shouldLog('warn', module)) return;
      err !== undefined ? console.warn(`[${module}] ${msg}`, err) : console.warn(`[${module}] ${msg}`);
    },
    error: (msg: string, err?: unknown) => {
      err !== undefined ? console.error(`[${module}] ${msg}`, err) : console.error(`[${module}] ${msg}`);
    },
  };
}
