import type { PluginSettingCondition, PluginSettingDescriptor, PluginStatus } from '@tx5dr/contracts';
import { normalizeCallsignFilterMode, validateFilterRuleLine } from '@tx5dr/core';

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

function normalizeKeyedStringArraysValue(
  value: unknown,
  entryNormalizer: (value: unknown) => string[] = normalizeWatchedCallsignWatchListValue,
): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string[]> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const entries = entryNormalizer(rawValue);
    if (entries.length > 0) {
      normalized[key] = entries;
    }
  }
  return normalized;
}

function areConditionValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function matchesPluginSettingCondition(
  condition: PluginSettingCondition | undefined,
  settings?: Record<string, unknown>,
): boolean {
  if (!condition) return true;

  if (Array.isArray(condition.allOf) && !condition.allOf.every((child) =>
    matchesPluginSettingCondition(child, settings)
  )) {
    return false;
  }

  if (Array.isArray(condition.anyOf) && !condition.anyOf.some((child) =>
    matchesPluginSettingCondition(child, settings)
  )) {
    return false;
  }

  if (condition.setting) {
    const value = settings?.[condition.setting];
    if ('equals' in condition && !areConditionValuesEqual(value, condition.equals)) {
      return false;
    }
    if ('notEquals' in condition && areConditionValuesEqual(value, condition.notEquals)) {
      return false;
    }
  }

  return true;
}

export function isPluginSettingVisible(
  descriptor: PluginSettingDescriptor,
  settings?: Record<string, unknown>,
): boolean {
  return !descriptor.hidden && matchesPluginSettingCondition(descriptor.visibleWhen, settings);
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
  if (descriptor.type !== 'string[]' && descriptor.type !== 'keyedStringArrays') {
    return value;
  }

  if (descriptor.type === 'keyedStringArrays') {
    return normalizeKeyedStringArraysValue(
      value,
      descriptor.options?.length ? normalizeStringArrayValue : normalizeWatchedCallsignWatchListValue,
    );
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
  if (descriptor.type === 'string[]' || descriptor.type === 'keyedStringArrays') {
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
    if (descriptor.type === 'info' || descriptor.hidden) {
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

export function getPluginSettingDescriptionKey(
  pluginName: string,
  fieldKey: string,
  descriptor: PluginSettingDescriptor,
  settings?: Record<string, unknown>,
): string | undefined {
  const override = descriptor.descriptionWhen?.find((entry) =>
    matchesPluginSettingCondition(entry.when, settings)
  );
  if (override) {
    return override.description;
  }

  return descriptor.description;
}

export function getPluginSettingValidationIssue(
  pluginName: string,
  fieldKey: string,
  descriptor: PluginSettingDescriptor,
  value: unknown,
  settings?: Record<string, unknown>,
): PluginSettingValidationIssue | null {
  if (descriptor.type !== 'string[]' && descriptor.type !== 'keyedStringArrays') {
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
    const mode = normalizeCallsignFilterMode(settings?.filterMode);
    for (let index = 0; index < entries.length; index += 1) {
      const issue = validateFilterRuleLine(entries[index], index + 1, mode);
      if (issue) return issue;
    }
    return null;
  }

  if (pluginName === 'callsign-filter' && fieldKey === 'bandFilterRules') {
    const entriesByKey = normalizeKeyedStringArraysValue(value);
    const mode = normalizeCallsignFilterMode(settings?.filterMode);
    for (const keyDescriptor of descriptor.keys ?? []) {
      const entries = entriesByKey[keyDescriptor.key] ?? [];
      for (let index = 0; index < entries.length; index += 1) {
        const issue = validateFilterRuleLine(entries[index], index + 1, mode);
        if (issue) {
          return {
            key: 'filterRulesInvalidBandRegexSyntax',
            params: {
              ...(issue.params ?? {}),
              band: keyDescriptor.label,
            },
          };
        }
      }
    }
    return null;
  }

  return null;
}
