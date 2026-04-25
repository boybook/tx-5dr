import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardBody, CardHeader } from '@heroui/react';
import type { PluginStatus } from '@tx5dr/contracts';
import { PluginSettingField } from '../settings/PluginSettingField';
import { resolvePluginName } from '../../utils/pluginLocales';

interface PluginSettingsPanelProps {
  plugin: PluginStatus;
  settings: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  isLoading?: boolean;
  embedded?: boolean;
}

export const PluginSettingsPanel: React.FC<PluginSettingsPanelProps> = ({
  plugin,
  settings,
  onChange,
  isLoading = false,
  embedded = false,
}) => {
  const { t } = useTranslation('settings');
  const pluginTitle = resolvePluginName(plugin.name, plugin.name);

  // 只展示 global scope 的设置（operator scope 在 OperatorPluginSettings 里）
  const globalEntries = useMemo(() => Object.entries(plugin.settings ?? {}).filter(
    ([, d]) => !d.scope || d.scope === 'global'
  ), [plugin.settings]);
  const hasOperatorEntries = useMemo(
    () => Object.values(plugin.settings ?? {}).some((descriptor) => descriptor.scope === 'operator'),
    [plugin.settings],
  );

  const effectiveSettings = useMemo(() => {
    const defaults: Record<string, unknown> = {};
    for (const [key, descriptor] of globalEntries) {
      defaults[key] = descriptor.default;
    }
    return { ...defaults, ...settings };
  }, [globalEntries, settings]);

  if (globalEntries.length === 0) {
    return (
      <div className="text-xs text-default-400 text-center py-2">
        {hasOperatorEntries
          ? t(
            'plugins.noGlobalSettingsWithOperatorHint',
            'This plugin has no global settings. Configure its operator-specific settings below.',
          )
          : t('plugins.noGlobalSettings', 'No global settings for this plugin.')}
      </div>
    );
  }

  return (
    <Card className={embedded ? 'border border-default-200/70 bg-default-50/50 shadow-none' : undefined}>
      <CardHeader className="pb-0 pt-2 px-3">
        <span className="text-xs font-medium text-default-600">
          {embedded
            ? t('plugins.globalSettings', 'Global Settings')
            : `${t('plugins.globalSettings', 'Global Settings')}: ${pluginTitle}`}
        </span>
      </CardHeader>
      <CardBody className="gap-3 pt-2">
        {globalEntries.map(([key, descriptor]) => (
          <PluginSettingField
            key={key}
            fieldKey={key}
            descriptor={descriptor}
            value={effectiveSettings[key] ?? descriptor.default}
            onChange={(val) => onChange(key, val)}
            pluginName={plugin.name}
            settings={effectiveSettings}
          />
        ))}
        {isLoading && (
          <div className="text-xs text-default-400">
            {t('common:status.loading')}
          </div>
        )}
      </CardBody>
    </Card>
  );
};
