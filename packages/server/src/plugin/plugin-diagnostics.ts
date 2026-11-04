import type { PluginAutoDisableInfo, PluginErrorRecord } from '@tx5dr/contracts';
import { redactSensitiveText } from '../utils/sensitive-log.js';
import type { PluginInstance } from './types.js';

export function createPluginErrorRecord(operation: string, error: unknown): PluginErrorRecord {
  return {
    timestamp: Date.now(),
    operation,
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 4000),
  };
}

/** Capture the failure evidence before teardown or concurrent callbacks can alter it. */
export function recordPluginAutoDisable(
  instance: PluginInstance,
  reason: PluginAutoDisableInfo['reason'],
  error: PluginErrorRecord,
  errors: PluginErrorRecord[] = [error],
): PluginAutoDisableInfo {
  const info: PluginAutoDisableInfo = {
    reason,
    timestamp: error.timestamp,
    operation: error.operation,
    message: error.message,
    operatorId: instance.scope.kind === 'operator' ? instance.scope.operatorId : undefined,
    errors: errors.slice(-5).map((entry) => ({ ...entry })),
  };
  instance.autoDisabled = true;
  instance.lastError = `[${error.operation}] ${error.message}`;
  instance.autoDisableInfo = info;
  return info;
}
