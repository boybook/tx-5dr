import React from 'react';
import { Button, Switch, Input, Select, SelectItem, Textarea, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';
import type { PluginSettingDescriptor } from '@tx5dr/contracts';
import i18n from '../../i18n/index';
import { resolvePluginLabel } from '../../utils/pluginLocales';
import {
  getPluginSettingDescriptionKey,
  getPluginSettingValidationIssue,
} from '../../utils/pluginSettings';

interface PluginSettingFieldProps {
  fieldKey: string;
  descriptor: PluginSettingDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  /** 用于从插件独立命名空间查找 label 翻译 */
  pluginName: string;
  settings?: Record<string, unknown>;
}

const PluginSettingInfoIcon: React.FC<{ description: string; label: string }> = ({ description, label }) => (
  <Tooltip
    content={<div className="max-w-[260px] whitespace-normal text-xs leading-5">{description}</div>}
    placement="top"
    closeDelay={80}
  >
    <span
      className="inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full text-default-400 transition-colors hover:text-default-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      tabIndex={0}
      aria-label={label}
    >
      <FontAwesomeIcon icon={faCircleInfo} className="text-[13px]" />
    </span>
  </Tooltip>
);

const RESPONSIVE_SETTING_GRID_CLASS = 'grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr))]';
const RESPONSIVE_FIELD_GRID_CLASS = 'grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))]';

/**
 * 通用的单个插件设置项渲染组件
 * 根据 descriptor.type 自动选择合适的控件（Switch/Input/Select）
 *
 * label 走插件自带的独立 i18n 命名空间（plugin:{pluginName}），
 * 而不是系统的 settings.json，保持插件翻译独立可维护。
 */
export const PluginSettingField: React.FC<PluginSettingFieldProps> = ({
  fieldKey,
  descriptor,
  value,
  onChange,
  pluginName,
  settings,
}) => {
  const [optionSearch, setOptionSearch] = React.useState('');
  const [keyedOptionSearch, setKeyedOptionSearch] = React.useState<Record<string, string>>({});
  const label = resolvePluginLabel(descriptor.label, pluginName);
  const descriptionKey = getPluginSettingDescriptionKey(pluginName, fieldKey, descriptor, settings);
  const description = descriptionKey
    ? resolvePluginLabel(descriptionKey, pluginName)
    : '';
  const validationIssue = getPluginSettingValidationIssue(pluginName, fieldKey, descriptor, value, settings);
  const validationMessage = validationIssue
    ? i18n.t(validationIssue.key, {
      ns: `plugin:${pluginName}`,
      ...validationIssue.params,
      defaultValue: validationIssue.key,
    })
    : undefined;

  if (descriptor.type === 'info') {
    return (
      <div className="rounded-lg border border-default-200/60 bg-default-50/70 px-3 py-2.5">
        <div className="text-sm font-medium text-default-700">{label}</div>
        {description && (
          <div className="mt-1 whitespace-pre-line text-xs leading-5 text-default-500">{description}</div>
        )}
      </div>
    );
  }

  if (descriptor.type === 'boolean') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-default-200/60 bg-content1 px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-default-700">
          <span className="min-w-0">{label}</span>
          {description && (
            <PluginSettingInfoIcon
              description={description}
              label={`${label}: ${description}`}
            />
          )}
        </span>
        <Switch
          size="sm"
          isSelected={!!value}
          onValueChange={onChange}
        />
      </div>
    );
  }

  if (descriptor.type === 'number') {
    return (
      <Input
        size="sm"
        label={label}
        type="number"
        value={String(value ?? descriptor.default ?? '')}
        description={description || undefined}
        min={descriptor.min}
        max={descriptor.max}
        onValueChange={(v) => onChange(Number(v))}
        variant="bordered"
      />
    );
  }

  if (descriptor.type === 'string' && descriptor.options?.length) {
    const selectedValue = String(value ?? descriptor.default ?? '');
    const hasSelectedOption = descriptor.options.some((opt) => opt.value === selectedValue);
    return (
      <Select
        size="sm"
        label={label}
        description={description || undefined}
        selectedKeys={hasSelectedOption ? [selectedValue] : []}
        onSelectionChange={(keys) => {
          const val = Array.from(keys as Set<string>)[0];
          if (val) onChange(val);
        }}
        variant="bordered"
      >
        {(descriptor.options ?? []).map(opt => (
          <SelectItem key={opt.value}>
            {resolvePluginLabel(opt.label, pluginName)}
          </SelectItem>
        ))}
      </Select>
    );
  }

  if (descriptor.type === 'string[]') {
    if (descriptor.options?.length) {
      const selectedValues = typeof value === 'string'
        ? value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean)
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : Array.isArray(descriptor.default)
            ? descriptor.default.filter((item): item is string => typeof item === 'string')
            : [];
      const selectedSet = new Set(selectedValues);
      const normalizedSearch = optionSearch.trim().toLocaleLowerCase();
      const filteredOptions = (descriptor.options ?? []).filter((opt) => {
        if (!normalizedSearch) return true;
        const optionLabel = resolvePluginLabel(opt.label, pluginName).toLocaleLowerCase();
        return optionLabel.includes(normalizedSearch) || opt.value.toLocaleLowerCase().includes(normalizedSearch);
      });
      const toggleOption = (optionValue: string) => {
        if (selectedSet.has(optionValue)) {
          onChange(selectedValues.filter((entry) => entry !== optionValue));
          return;
        }
        onChange([...selectedValues, optionValue]);
      };

      return (
        <div className="rounded-lg border border-default-200/70 bg-content1 px-3 py-2.5">
          <div className="mb-2">
            <div className="text-sm font-medium text-default-700">{label}</div>
            {description && (
              <div className="mt-0.5 whitespace-pre-line text-xs leading-5 text-default-500">{description}</div>
            )}
          </div>
          <Input
            size="sm"
            aria-label={i18n.t('common:search', { defaultValue: 'Search' })}
            placeholder={i18n.t('common:search', { defaultValue: 'Search' })}
            value={optionSearch}
            onValueChange={setOptionSearch}
            variant="bordered"
          />
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-default-500">
            <span>
              {i18n.t('settings:plugins.selectedCount', {
                count: selectedValues.length,
                defaultValue: `${selectedValues.length} selected`,
              })}
            </span>
            {selectedValues.length > 0 && (
              <Button size="sm" variant="light" className="h-6 min-w-0 px-2 text-xs" onPress={() => onChange([])}>
                {i18n.t('common:button.clear', { defaultValue: 'Clear' })}
              </Button>
            )}
          </div>
          <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-default-200/70 bg-default-50/40 p-1">
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-default-400">
                {i18n.t('settings:plugins.noOptions', { defaultValue: 'No options found.' })}
              </div>
            ) : filteredOptions.map((opt) => {
              const optionLabel = resolvePluginLabel(opt.label, pluginName);
              const selected = selectedSet.has(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${selected ? 'bg-primary-50 text-primary-700' : 'text-default-600 hover:bg-default-100'}`}
                  onClick={() => toggleOption(opt.value)}
                >
                  <span className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[10px] ${selected ? 'border-primary-500 bg-primary-500 text-white' : 'border-default-300 bg-content1'}`}>
                    {selected ? '✓' : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{optionLabel}</span>
                </button>
              );
            })}
          </div>
          {validationMessage && (
            <div className="mt-1 text-xs text-danger">{validationMessage}</div>
          )}
        </div>
      );
    }

    const currentValue = typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').join('\n')
        : Array.isArray(descriptor.default)
          ? descriptor.default.filter((item): item is string => typeof item === 'string').join('\n')
          : '';

    return (
      <Textarea
        size="sm"
        label={label}
        description={description || undefined}
        value={currentValue}
        onValueChange={onChange}
        isInvalid={Boolean(validationMessage)}
        errorMessage={validationMessage}
        minRows={3}
        variant="bordered"
      />
    );
  }

  const objectFields = descriptor.itemFields ?? [];
  const nextId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  };
  const getObjectFieldDefault = (field: (typeof objectFields)[number]): unknown => {
    if ('default' in field && field.default !== undefined) return field.default;
    return field.type === 'boolean' ? false : '';
  };
  const createEmptyObjectRow = (): Record<string, unknown> => {
    const row: Record<string, unknown> = { id: nextId() };
    for (const field of objectFields) {
      row[field.key] = getObjectFieldDefault(field);
    }
    return row;
  };
  const renderObjectField = (
    row: Record<string, unknown>,
    field: (typeof objectFields)[number],
    updateField: (key: string, nextValue: unknown) => void,
  ) => {
    const fieldLabel = resolvePluginLabel(field.label, pluginName);
    const fieldDescription = field.description ? resolvePluginLabel(field.description, pluginName) : undefined;
    const currentValue = row[field.key] ?? getObjectFieldDefault(field);
    if (field.type === 'boolean') {
      return (
        <div key={field.key} className="flex items-center justify-between gap-3 rounded-md border border-default-200/60 bg-content1 px-3 py-2">
          <span className="text-sm text-default-700">{fieldLabel}</span>
          <Switch
            size="sm"
            isSelected={Boolean(currentValue)}
            onValueChange={(nextValue) => updateField(field.key, nextValue)}
          />
        </div>
      );
    }
    return (
      <Input
        key={field.key}
        size="sm"
        label={fieldLabel}
        description={fieldDescription}
        placeholder={field.placeholder}
        type={field.type === 'number' ? 'number' : 'text'}
        value={String(currentValue ?? '')}
        onValueChange={(nextValue) =>
          updateField(field.key, field.type === 'number' ? (nextValue === '' ? '' : Number(nextValue)) : nextValue)
        }
        variant="bordered"
      />
    );
  };

  if (descriptor.type === 'keyedStringArrays') {
    const currentRows = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : descriptor.default && typeof descriptor.default === 'object' && !Array.isArray(descriptor.default)
        ? descriptor.default as Record<string, unknown>
        : {};

    const getArrayValue = (key: string): string[] => {
      const rowValue = currentRows[key];
      if (typeof rowValue === 'string') {
        return rowValue.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
      }
      if (Array.isArray(rowValue)) {
        return rowValue.filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean);
      }
      return [];
    };

    const getTextValue = (key: string): string => {
      const rowValue = currentRows[key];
      if (typeof rowValue === 'string') return rowValue;
      if (Array.isArray(rowValue)) {
        return rowValue.filter((item): item is string => typeof item === 'string').join('\n');
      }
      return '';
    };

    const updateKey = (key: string, nextValue: string) => {
      onChange({
        ...currentRows,
        [key]: nextValue,
      });
    };

    const updateKeyArray = (key: string, nextValue: string[]) => {
      onChange({
        ...currentRows,
        [key]: nextValue,
      });
    };

    return (
      <div className="rounded-lg border border-default-200/70 bg-content1 px-3 py-2.5">
        <div className="mb-2">
          <div className="text-sm font-medium text-default-700">{label}</div>
          {description && (
            <div className="mt-0.5 whitespace-pre-line text-xs leading-5 text-default-500">{description}</div>
          )}
        </div>
        <div className={RESPONSIVE_SETTING_GRID_CLASS}>
          {(descriptor.keys ?? []).map((keyDescriptor) => {
            const keyLabel = resolvePluginLabel(keyDescriptor.label, pluginName);
            const keyDescription = keyDescriptor.description
              ? resolvePluginLabel(keyDescriptor.description, pluginName)
              : undefined;
            const isRowInvalid = validationIssue?.params?.band === keyDescriptor.label;
            if (descriptor.options?.length) {
              const selectedValues = getArrayValue(keyDescriptor.key);
              const selectedSet = new Set(selectedValues);
              const searchValue = keyedOptionSearch[keyDescriptor.key] ?? '';
              const normalizedSearch = searchValue.trim().toLocaleLowerCase();
              const filteredOptions = (descriptor.options ?? []).filter((opt) => {
                if (!normalizedSearch) return true;
                const optionLabel = resolvePluginLabel(opt.label, pluginName).toLocaleLowerCase();
                return optionLabel.includes(normalizedSearch) || opt.value.toLocaleLowerCase().includes(normalizedSearch);
              });
              const toggleOption = (optionValue: string) => {
                if (selectedSet.has(optionValue)) {
                  updateKeyArray(keyDescriptor.key, selectedValues.filter((entry) => entry !== optionValue));
                  return;
                }
                updateKeyArray(keyDescriptor.key, [...selectedValues, optionValue]);
              };

              return (
                <div key={keyDescriptor.key} className="rounded-md border border-default-200/70 bg-default-50/40 p-2">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-default-700">{keyLabel}</div>
                      {keyDescription && (
                        <div className="mt-0.5 text-[11px] leading-4 text-default-500">{keyDescription}</div>
                      )}
                    </div>
                    {selectedValues.length > 0 && (
                      <Button
                        size="sm"
                        variant="light"
                        className="h-6 min-w-0 shrink-0 px-2 text-[11px]"
                        onPress={() => updateKeyArray(keyDescriptor.key, [])}
                      >
                        {i18n.t('common:button.clear', { defaultValue: 'Clear' })}
                      </Button>
                    )}
                  </div>
                  <Input
                    size="sm"
                    aria-label={`${keyLabel} ${i18n.t('common:search', { defaultValue: 'Search' })}`}
                    placeholder={i18n.t('common:search', { defaultValue: 'Search' })}
                    value={searchValue}
                    onValueChange={(nextValue) => setKeyedOptionSearch((prev) => ({
                      ...prev,
                      [keyDescriptor.key]: nextValue,
                    }))}
                    variant="bordered"
                  />
                  <div className="mt-1.5 text-[11px] text-default-500">
                    {i18n.t('settings:plugins.selectedCount', {
                      count: selectedValues.length,
                      defaultValue: `${selectedValues.length} selected`,
                    })}
                  </div>
                  <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border border-default-200/70 bg-content1 p-1">
                    {filteredOptions.length === 0 ? (
                      <div className="px-2 py-3 text-center text-xs text-default-400">
                        {i18n.t('settings:plugins.noOptions', { defaultValue: 'No options found.' })}
                      </div>
                    ) : filteredOptions.map((opt) => {
                      const optionLabel = resolvePluginLabel(opt.label, pluginName);
                      const selected = selectedSet.has(opt.value);
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${selected ? 'bg-primary-50 text-primary-700' : 'text-default-600 hover:bg-default-100'}`}
                          onClick={() => toggleOption(opt.value)}
                        >
                          <span className={`inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[10px] ${selected ? 'border-primary-500 bg-primary-500 text-white' : 'border-default-300 bg-content1'}`}>
                            {selected ? '✓' : ''}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{optionLabel}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            }

            return (
              <Textarea
                key={keyDescriptor.key}
                size="sm"
                label={keyLabel}
                description={keyDescription}
                value={getTextValue(keyDescriptor.key)}
                onValueChange={(nextValue) => updateKey(keyDescriptor.key, nextValue)}
                isInvalid={Boolean(isRowInvalid)}
                errorMessage={isRowInvalid ? validationMessage : undefined}
                minRows={2}
                variant="bordered"
              />
            );
          })}
        </div>
      </div>
    );
  }

  if (descriptor.type === 'keyedObjectArrays') {
    const currentRows = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : descriptor.default && typeof descriptor.default === 'object' && !Array.isArray(descriptor.default)
        ? descriptor.default as Record<string, unknown>
        : {};
    const getRowsForKey = (key: string): Record<string, unknown>[] => {
      const rowValue = currentRows[key];
      return Array.isArray(rowValue)
        ? rowValue.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
    };
    const updateRowsForKey = (key: string, rows: Record<string, unknown>[]) => {
      onChange({
        ...currentRows,
        [key]: rows,
      });
    };

    return (
      <div className="rounded-lg border border-default-200/70 bg-content1 px-3 py-2.5">
        <div className="mb-2">
          <div className="text-sm font-medium text-default-700">{label}</div>
          {description && (
            <div className="mt-0.5 whitespace-pre-line text-xs leading-5 text-default-500">{description}</div>
          )}
        </div>
        <div className={RESPONSIVE_SETTING_GRID_CLASS}>
          {(descriptor.keys ?? []).map((keyDescriptor) => {
            const keyLabel = resolvePluginLabel(keyDescriptor.label, pluginName);
            const keyDescription = keyDescriptor.description
              ? resolvePluginLabel(keyDescriptor.description, pluginName)
              : undefined;
            const rows = getRowsForKey(keyDescriptor.key);
            const addRow = () => updateRowsForKey(keyDescriptor.key, [...rows, createEmptyObjectRow()]);
            const updateRow = (index: number, fieldKey: string, nextValue: unknown) => {
              updateRowsForKey(keyDescriptor.key, rows.map((row, rowIndex) =>
                rowIndex === index ? { ...row, [fieldKey]: nextValue } : row
              ));
            };
            const removeRow = (index: number) => {
              updateRowsForKey(keyDescriptor.key, rows.filter((_, rowIndex) => rowIndex !== index));
            };

            return (
              <div key={keyDescriptor.key} className="rounded-md border border-default-200/70 bg-default-50/40 p-2">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-default-700">{keyLabel}</div>
                    {keyDescription && (
                      <div className="mt-0.5 text-[11px] leading-4 text-default-500">{keyDescription}</div>
                    )}
                  </div>
                  <Button size="sm" variant="flat" className="h-7 min-w-0 shrink-0 px-2 text-[11px]" onPress={addRow}>
                    {i18n.t('common:button.add', { defaultValue: 'Add' })}
                  </Button>
                </div>
                {rows.length === 0 ? (
                  <div className="rounded-md border border-dashed border-default-200 px-3 py-4 text-center text-xs text-default-400">
                    {i18n.t('settings:plugins.noItems', { defaultValue: 'No items yet.' })}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {rows.map((row, index) => (
                      <div key={String(row.id ?? index)} className="rounded-md border border-default-200/70 bg-content1 p-2">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-default-500">
                            {i18n.t('settings:plugins.itemNumber', { index: index + 1, defaultValue: `Item ${index + 1}` })}
                          </span>
                          <Button size="sm" color="danger" variant="light" onPress={() => removeRow(index)}>
                            {i18n.t('common:button.delete', { defaultValue: 'Delete' })}
                          </Button>
                        </div>
                        <div className={RESPONSIVE_FIELD_GRID_CLASS}>
                          {objectFields.map((field) => renderObjectField(row, field, (fieldKey, nextValue) =>
                            updateRow(index, fieldKey, nextValue)
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (descriptor.type === 'keyedObjects') {
    const currentRows = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : descriptor.default && typeof descriptor.default === 'object' && !Array.isArray(descriptor.default)
        ? descriptor.default as Record<string, unknown>
        : {};
    const getObjectForKey = (key: string): Record<string, unknown> => {
      const rowValue = currentRows[key];
      return rowValue && typeof rowValue === 'object' && !Array.isArray(rowValue)
        ? rowValue as Record<string, unknown>
        : {};
    };
    const updateObjectForKey = (key: string, nextRow: Record<string, unknown>) => {
      onChange({
        ...currentRows,
        [key]: nextRow,
      });
    };

    return (
      <div className="rounded-lg border border-default-200/70 bg-content1 px-3 py-2.5">
        <div className="mb-2">
          <div className="text-sm font-medium text-default-700">{label}</div>
          {description && (
            <div className="mt-0.5 whitespace-pre-line text-xs leading-5 text-default-500">{description}</div>
          )}
        </div>
        <div className={RESPONSIVE_SETTING_GRID_CLASS}>
          {(descriptor.keys ?? []).map((keyDescriptor) => {
            const keyLabel = resolvePluginLabel(keyDescriptor.label, pluginName);
            const keyDescription = keyDescriptor.description
              ? resolvePluginLabel(keyDescriptor.description, pluginName)
              : undefined;
            const row = getObjectForKey(keyDescriptor.key);
            return (
              <div key={keyDescriptor.key} className="rounded-md border border-default-200/70 bg-default-50/40 p-2">
                <div className="mb-2 min-w-0">
                  <div className="text-xs font-medium text-default-700">{keyLabel}</div>
                  {keyDescription && (
                    <div className="mt-0.5 text-[11px] leading-4 text-default-500">{keyDescription}</div>
                  )}
                </div>
                <div className="grid gap-2">
                  {objectFields.map((field) => renderObjectField(row, field, (fieldKey, nextValue) =>
                    updateObjectForKey(keyDescriptor.key, { ...row, [fieldKey]: nextValue })
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (descriptor.type === 'object[]') {
    const rows = Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : Array.isArray(descriptor.default)
        ? descriptor.default.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
    const updateRow = (index: number, key: string, nextValue: unknown) => {
      onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: nextValue } : row));
    };
    const removeRow = (index: number) => {
      onChange(rows.filter((_, rowIndex) => rowIndex !== index));
    };
    const addRow = () => {
      onChange([...rows, createEmptyObjectRow()]);
    };

    return (
      <div className="rounded-lg border border-default-200/70 bg-content1 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-default-700">{label}</div>
            {description && (
              <div className="mt-0.5 text-xs leading-5 text-default-500">{description}</div>
            )}
          </div>
          <Button size="sm" variant="flat" onPress={addRow}>
            {i18n.t('common:button.add', { defaultValue: 'Add' })}
          </Button>
        </div>
        {rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-default-200 px-3 py-4 text-center text-xs text-default-400">
            {i18n.t('settings:plugins.noItems', { defaultValue: 'No items yet.' })}
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row, index) => (
              <div key={String(row.id ?? index)} className="rounded-md border border-default-200/70 bg-default-50/50 p-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-default-500">
                    {i18n.t('settings:plugins.itemNumber', { index: index + 1, defaultValue: `Item ${index + 1}` })}
                  </span>
                  <Button size="sm" color="danger" variant="light" onPress={() => removeRow(index)}>
                    {i18n.t('common:button.delete', { defaultValue: 'Delete' })}
                  </Button>
                </div>
                <div className={RESPONSIVE_FIELD_GRID_CLASS}>
                  {objectFields.map((field) => renderObjectField(row, field, (fieldKey, nextValue) =>
                    updateRow(index, fieldKey, nextValue)
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <Input
      size="sm"
      label={label}
      description={description || undefined}
      value={String(value ?? descriptor.default ?? '')}
      onValueChange={onChange}
      variant="bordered"
    />
  );
};
