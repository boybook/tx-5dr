import React from 'react';
import { Switch, Input, Select, SelectItem, Textarea } from '@heroui/react';
import type { PluginSettingDescriptor } from '@tx5dr/contracts';
import i18n from '../../i18n/index';
import { resolvePluginLabel } from '../../utils/pluginLocales';
import { getPluginSettingValidationIssue } from '../../utils/pluginSettings';

interface PluginSettingFieldProps {
  fieldKey: string;
  descriptor: PluginSettingDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  /** 用于从插件独立命名空间查找 label 翻译 */
  pluginName: string;
}

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
}) => {
  const label = resolvePluginLabel(descriptor.label, pluginName);
  const description = descriptor.description
    ? resolvePluginLabel(descriptor.description, pluginName)
    : '';
  const validationIssue = getPluginSettingValidationIssue(pluginName, fieldKey, descriptor, value);
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
        <span className="text-sm text-default-700">{label}</span>
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
