import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import type { PluginStatus } from '@tx5dr/contracts';
import { PluginSettingField } from '../settings/PluginSettingField';
import { resolvePluginName } from '../../utils/pluginLocales';
import {
  arePluginSettingValuesEqual,
  getPluginSettingValidationIssue,
} from '../../utils/pluginSettings';

interface PluginOperatorSettingsFormProps {
  plugin: PluginStatus;
  settings: Record<string, unknown>;
  originalSettings: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  onSave: () => void;
  isSaving?: boolean;
  description?: string;
  className?: string;
}

export function getDefaultOperatorPluginSettings(plugin: PluginStatus): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(plugin.settings ?? {})) {
    if (descriptor.scope === 'operator' && descriptor.type !== 'info') {
      defaults[key] = descriptor.default;
    }
  }
  return defaults;
}

export function hasOperatorPluginSettings(plugin: PluginStatus): boolean {
  return Object.values(plugin.settings ?? {}).some((descriptor) => descriptor.scope === 'operator' && !descriptor.hidden);
}

export function canConfigurePluginForOperator(plugin: PluginStatus, operatorId: string): boolean {
  return plugin.type !== 'strategy' || (plugin.assignedOperatorIds?.includes(operatorId) ?? false);
}

export const PluginOperatorSettingsForm: React.FC<PluginOperatorSettingsFormProps> = ({
  plugin,
  settings,
  originalSettings,
  onChange,
  onSave,
  isSaving = false,
  description,
  className,
}) => {
  const { t } = useTranslation('settings');
  const operatorEntries = useMemo(() => Object.entries(plugin.settings ?? {}).filter(
    ([, descriptor]) => descriptor.scope === 'operator' && !descriptor.hidden
  ), [plugin.settings]);
  const currentSettings = useMemo(
    () => ({ ...getDefaultOperatorPluginSettings(plugin), ...settings }),
    [plugin, settings],
  );
  const originalWithDefaults = useMemo(
    () => ({ ...getDefaultOperatorPluginSettings(plugin), ...originalSettings }),
    [plugin, originalSettings],
  );
  const persistableKeys = operatorEntries
    .filter(([, descriptor]) => descriptor.type !== 'info')
    .map(([key]) => key);
  const hasValidationIssues = persistableKeys.some((key) => {
    const descriptor = plugin.settings?.[key];
    return descriptor
      ? Boolean(getPluginSettingValidationIssue(plugin.name, key, descriptor, currentSettings[key], currentSettings))
      : false;
  });
  const hasChanges = persistableKeys.some((key) => {
    const descriptor = plugin.settings?.[key];
    return descriptor
      ? !arePluginSettingValuesEqual(
        descriptor,
        currentSettings[key],
        originalWithDefaults[key],
        plugin.name,
        key,
      )
      : currentSettings[key] !== originalWithDefaults[key];
  });

  if (operatorEntries.length === 0) {
    return (
      <div className="rounded-xl border border-default-200/70 bg-default-50/40 px-4 py-3 text-xs text-default-400">
        {t('plugins.noOperatorSettings', 'This plugin has no operator settings.')}
      </div>
    );
  }

  return (
    <section className={className ?? 'rounded-xl border border-default-200/70 bg-default-50/40 px-4 py-3'}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h5 className="text-sm font-medium text-default-700">
            {resolvePluginName(plugin.name, plugin.name)}
          </h5>
          <p className="mt-1 text-xs text-default-400">
            {description ?? t('plugins.operatorPluginSettingsHint', 'Operator-specific plugin settings.')}
          </p>
        </div>
        {hasChanges && (
          <Button
            size="sm"
            color="primary"
            variant="flat"
            isLoading={isSaving}
            isDisabled={hasValidationIssues}
            onPress={onSave}
            className="shrink-0"
          >
            {t('common:button.save')}
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {operatorEntries.map(([key, descriptor]) => (
          <PluginSettingField
            key={key}
            fieldKey={key}
            descriptor={descriptor}
            value={currentSettings[key] ?? descriptor.default}
            onChange={(val) => onChange(key, val)}
            pluginName={plugin.name}
            settings={currentSettings}
          />
        ))}
      </div>
    </section>
  );
};
