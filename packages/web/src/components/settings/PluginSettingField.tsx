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

  if (descriptor.type === 'object[]') {
    const rows = Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : Array.isArray(descriptor.default)
        ? descriptor.default.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
        : [];
    const fields = descriptor.itemFields ?? [];
    const nextId = () => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    };
    const updateRow = (index: number, key: string, nextValue: unknown) => {
      onChange(rows.map((row, rowIndex) => rowIndex === index ? { ...row, [key]: nextValue } : row));
    };
    const removeRow = (index: number) => {
      onChange(rows.filter((_, rowIndex) => rowIndex !== index));
    };
    const addRow = () => {
      const nextRow: Record<string, unknown> = { id: nextId() };
      for (const field of fields) {
        if (!(field.key in nextRow)) {
          nextRow[field.key] = field.type === 'boolean' ? false : '';
        }
      }
      onChange([...rows, nextRow]);
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
                <div className="grid gap-2 md:grid-cols-2">
                  {fields.map((field) => {
                    const fieldLabel = resolvePluginLabel(field.label, pluginName);
                    const fieldDescription = field.description ? resolvePluginLabel(field.description, pluginName) : undefined;
                    if (field.type === 'boolean') {
                      return (
                        <div key={field.key} className="flex items-center justify-between gap-3 rounded-md border border-default-200/60 bg-content1 px-3 py-2">
                          <span className="text-sm text-default-700">{fieldLabel}</span>
                          <Switch
                            size="sm"
                            isSelected={Boolean(row[field.key])}
                            onValueChange={(nextValue) => updateRow(index, field.key, nextValue)}
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
                        value={String(row[field.key] ?? '')}
                        onValueChange={(nextValue) =>
                          updateRow(index, field.key, field.type === 'number' ? Number(nextValue) : nextValue)
                        }
                        variant="bordered"
                      />
                    );
                  })}
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
