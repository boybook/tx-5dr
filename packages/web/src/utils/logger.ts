/**
 * Browser-safe logger.
 * debug/info are only output in development builds (import.meta.env.DEV).
 * warn/error always output.
 */

const isDev = import.meta.env.DEV;

function formatContext(context: unknown): string {
  if (context === undefined) return '';
  if (context instanceof Error) return ` ${context.stack ?? context.message}`;
  if (typeof context === 'string') return ` ${context}`;
  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return ` ${String(context)}`;
  }
}

function formatMessage(module: string, msg: string, context?: unknown): string {
  return `[${module}] ${msg}${formatContext(context)}`;
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
      if (!isDev) return;
      console.debug(formatMessage(module, msg, ctx));
    },
    info: (msg, ctx) => {
      if (!isDev) return;
      console.info(formatMessage(module, msg, ctx));
    },
    warn: (msg, err) => {
      console.warn(formatMessage(module, msg, err));
    },
    error: (msg, err) => {
      console.error(formatMessage(module, msg, err));
    },
  };
}
