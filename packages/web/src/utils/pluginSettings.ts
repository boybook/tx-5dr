import type { PluginSettingDescriptor, PluginStatus } from '@tx5dr/contracts';
import { validateFilterRuleLine } from '@tx5dr/core';

export interface PluginSettingValidationIssue {
  key: string;
  params?: Record<string, unknown>;
}
const WATCH_LIST_REGEX_META_CHARS = /[\\^$.*+?()[\]{}|]/;

function normalizeStringArrayValue(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeWatchedCallsignWatchListValue(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function isWatchListComment(entry: string): boolean {
  return entry.startsWith('#');
}

function looksLikeRegexRule(entry: string): boolean {
  return WATCH_LIST_REGEX_META_CHARS.test(entry);
}

function normalizeByPluginSetting(
  pluginName: string | undefined,
  fieldKey: string | undefined,
  descriptor: PluginSettingDescriptor,
  value: unknown,
): unknown {
  if (descriptor.type !== 'string[]') {
    return value;
  }

  if (pluginName === 'watched-callsign-autocall' && fieldKey === 'watchList') {
    return normalizeWatchedCallsignWatchListValue(value);
  }

  if (pluginName === 'callsign-filter' && fieldKey === 'filterRules') {
    return normalizeWatchedCallsignWatchListValue(value);
  }

  return normalizeStringArrayValue(value);
}

export function normalizePluginSettingValue(
  descriptor: PluginSettingDescriptor,
  value: unknown,
  pluginName?: string,
  fieldKey?: string,
): unknown {
  return normalizeByPluginSetting(pluginName, fieldKey, descriptor, value);
}

export function arePluginSettingValuesEqual(
  descriptor: PluginSettingDescriptor,
  left: unknown,
  right: unknown,
  pluginName?: string,
  fieldKey?: string,
): boolean {
  if (descriptor.type === 'string[]') {
    const normalizedLeft = normalizeByPluginSetting(pluginName, fieldKey, descriptor, left);
    const normalizedRight = normalizeByPluginSetting(pluginName, fieldKey, descriptor, right);
    return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
  }

  return left === right;
}

export function normalizePluginSettingsForSave(
  plugin: PluginStatus,
  settings: Record<string, unknown>,
  scope: 'global' | 'operator',
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, descriptor] of Object.entries(plugin.settings ?? {})) {
    if (descriptor.type === 'info') {
      continue;
    }

    const descriptorScope = descriptor.scope ?? 'global';
    if (descriptorScope !== scope) {
      continue;
    }

    normalized[key] = normalizePluginSettingValue(descriptor, settings[key], plugin.name, key);
  }

  return normalized;
}

export function getPluginSettingValidationIssue(
  pluginName: string,
  fieldKey: string,
  descriptor: PluginSettingDescriptor,
  value: unknown,
): PluginSettingValidationIssue | null {
  if (descriptor.type !== 'string[]') {
    return null;
  }

  if (pluginName === 'watched-callsign-autocall' && fieldKey === 'watchList') {
    const entries = normalizeWatchedCallsignWatchListValue(value);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || isWatchListComment(entry) || !looksLikeRegexRule(entry)) {
        continue;
      }

      try {
        new RegExp(entry, 'i');
      } catch {
        return {
          key: 'watchListInvalidRegexSyntax',
          params: { line: index + 1 },
        };
      }
    }
    return null;
  }

  if (pluginName === 'callsign-filter' && fieldKey === 'filterRules') {
    const entries = normalizeWatchedCallsignWatchListValue(value);
    for (let index = 0; index < entries.length; index += 1) {
      const issue = validateFilterRuleLine(entries[index], index + 1);
      if (issue) return issue;
    }
    return null;
  }

  return null;
}
