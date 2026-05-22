import type { PluginObjectArrayField, PluginSettingCondition, PluginSettingDescriptor, PluginStatus } from '@tx5dr/contracts';
import {
  normalizeCallsignFilterMode,
  normalizeTextMatchMode,
  validateFilterRuleLine,
  validateLegacyAutoRegexTextMatchRuleLine,
  validateTextMatchRuleLine,
} from '@tx5dr/core';

export interface PluginSettingValidationIssue {
  key: string;
  params?: Record<string, unknown>;
}
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

function normalizeObjectFieldValue(field: PluginObjectArrayField, value: unknown): unknown {
  if (field.type === 'boolean') {
    return value === true;
  }
  if (field.type === 'number') {
    if (value === '' || value === null || value === undefined) return undefined;
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return typeof value === 'string' ? value.trim() : '';
}

function isDefaultObjectFieldValue(field: PluginObjectArrayField, value: unknown): boolean {
  const defaultValue = field.default ?? (field.type === 'boolean' ? false : field.type === 'number' ? undefined : '');
  return Object.is(value, defaultValue);
}

function normalizeObjectValue(
  value: unknown,
  fields: PluginObjectArrayField[],
): { value: Record<string, unknown>; hasContent: boolean } {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const normalized: Record<string, unknown> = {};
  let hasContent = false;

  if (typeof source.id === 'string' && source.id.trim()) {
    normalized.id = source.id.trim();
  }

  for (const field of fields) {
    const fieldValue = normalizeObjectFieldValue(field, source[field.key]);
    if (fieldValue !== undefined) {
      normalized[field.key] = fieldValue;
      if (!isDefaultObjectFieldValue(field, fieldValue)) {
        hasContent = true;
      }
    }
  }

  return { value: normalized, hasContent };
}

function normalizeObjectArrayValue(value: unknown, fields: PluginObjectArrayField[]): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeObjectValue(entry, fields))
    .filter((entry) => entry.hasContent)
    .map((entry) => entry.value);
}

function normalizeKeyedObjectArraysValue(
  value: unknown,
  fields: PluginObjectArrayField[],
): Record<string, Record<string, unknown>[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, Record<string, unknown>[]> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const rows = normalizeObjectArrayValue(rawValue, fields);
    if (rows.length > 0) {
      normalized[key] = rows;
    }
  }
  return normalized;
}

function normalizeKeyedObjectsValue(
  value: unknown,
  fields: PluginObjectArrayField[],
): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const entry = normalizeObjectValue(rawValue, fields);
    if (entry.hasContent) {
      normalized[key] = entry.value;
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


function normalizeByPluginSetting(
  pluginName: string | undefined,
  fieldKey: string | undefined,
  descriptor: PluginSettingDescriptor,
  value: unknown,
): unknown {
  if (!['string[]', 'keyedStringArrays', 'keyedObjectArrays', 'keyedObjects'].includes(descriptor.type)) {
    return value;
  }

  if (descriptor.type === 'keyedStringArrays') {
    return normalizeKeyedStringArraysValue(
      value,
      descriptor.options?.length ? normalizeStringArrayValue : normalizeWatchedCallsignWatchListValue,
    );
  }

  if (descriptor.type === 'keyedObjectArrays') {
    return normalizeKeyedObjectArraysValue(value, descriptor.itemFields ?? []);
  }

  if (descriptor.type === 'keyedObjects') {
    return normalizeKeyedObjectsValue(value, descriptor.itemFields ?? []);
  }

  if ((pluginName === 'watched-callsign-autocall' && fieldKey === 'watchList')
    || (pluginName === 'watched-grid-autocall' && fieldKey === 'gridWatchList')) {
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
  if (['string[]', 'keyedStringArrays', 'keyedObjectArrays', 'keyedObjects'].includes(descriptor.type)) {
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

    const value = normalizePluginSettingValue(descriptor, settings[key], plugin.name, key);
    if ((descriptor.type === 'keyedObjectArrays' || descriptor.type === 'keyedObjects')
      && value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).length === 0) {
      continue;
    }
    normalized[key] = value;
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
    const mode = normalizeTextMatchMode(settings?.watchMatchMode ?? settings?.matchMode);
    const hasExplicitMode = Boolean(settings && Object.prototype.hasOwnProperty.call(settings, 'watchMatchMode'));
    for (let index = 0; index < entries.length; index += 1) {
      const issue = hasExplicitMode
        ? validateTextMatchRuleLine(entries[index], index + 1, mode, { issueKey: 'watchListInvalidRegexSyntax' })
        : mode === 'regex'
          ? validateTextMatchRuleLine(entries[index], index + 1, 'regex', { issueKey: 'watchListInvalidRegexSyntax' })
          : validateLegacyAutoRegexTextMatchRuleLine(entries[index], index + 1, { issueKey: 'watchListInvalidRegexSyntax' });
      if (issue) return issue;
    }
    return null;
  }

  if (pluginName === 'watched-grid-autocall' && fieldKey === 'gridWatchList') {
    const entries = normalizeWatchedCallsignWatchListValue(value);
    const mode = normalizeTextMatchMode(settings?.gridMatchMode);
    for (let index = 0; index < entries.length; index += 1) {
      const issue = validateTextMatchRuleLine(entries[index], index + 1, mode, {
        issueKey: 'gridWatchListInvalidRegexSyntax',
      });
      if (issue) return issue;
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
