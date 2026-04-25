import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import { PluginSettingField } from './PluginSettingField';
import { createLogger } from '../../utils/logger';
import { pluginApi } from '../../utils/pluginApi';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { resolvePluginName } from '../../utils/pluginLocales';
import { PluginStrategySelector } from '../plugins/PluginStrategySelector';
import {
  arePluginSettingValuesEqual,
  getPluginSettingValidationIssue,
  normalizePluginSettingsForSave,
} from '../../utils/pluginSettings';

const logger = createLogger('OperatorPluginSettings');

interface OperatorPluginSettingsProps {
  operatorId: string;
}

/**
 * 展示在 OperatorSettings 操作员 Card 中的插件 operator-scope 设置
 *
 * 只渲染 scope='operator' 的设置项，每个插件一个 Card。
 * 数据来源：GET /api/plugins/operators/:operatorId
 * 保存路径：PUT /api/plugins/:name/operator/:id/settings
 */
export const OperatorPluginSettings: React.FC<OperatorPluginSettingsProps> = ({ operatorId }) => {
  const { t } = useTranslation('settings');
  const pluginSnapshot = usePluginSnapshot();
  const plugins = pluginSnapshot.plugins;
  const [settingsMap, setSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
  const [originalSettingsMap, setOriginalSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});
  const [currentStrategy, setCurrentStrategy] = useState('standard-qso');

  // 有 operator scope settings 的已启用插件
  const relevantPlugins = plugins.filter(p =>
    (
      (p.type === 'strategy'
        ? (p.assignedOperatorIds?.includes(operatorId) ?? false)
        : p.enabled)
    ) && Object.values(p.settings ?? {}).some(d => d.scope === 'operator')
  );
  const hasStrategyChoice = plugins.filter((plugin) => plugin.type === 'strategy').length > 1;

  useEffect(() => {
    pluginApi.getOperatorState(operatorId)
      .then((res) => {
        const remoteMap = res?.operatorSettings ?? {};
        setCurrentStrategy(res?.currentStrategy ?? 'standard-qso');
        const nextSettingsMap: Record<string, Record<string, unknown>> = {};

        relevantPlugins.forEach((plugin) => {
          const remote = remoteMap[plugin.name] ?? {};
          const withDefaults: Record<string, unknown> = {};
          for (const [key, descriptor] of Object.entries(plugin.settings ?? {})) {
            if (descriptor.scope === 'operator' && descriptor.type !== 'info') {
              withDefaults[key] = key in remote ? remote[key] : descriptor.default;
            }
          }
          nextSettingsMap[plugin.name] = withDefaults;
        });

        setSettingsMap(nextSettingsMap);
        setOriginalSettingsMap(nextSettingsMap);
      })
      .catch((err: unknown) => logger.error('Failed to load operator plugin settings', err));
  }, [operatorId, pluginSnapshot.generation, plugins]);

  const handleChange = useCallback((pluginName: string, key: string, value: unknown) => {
    setSettingsMap(prev => ({
      ...prev,
      [pluginName]: { ...(prev[pluginName] ?? {}), [key]: value },
    }));
  }, []);

  const handleSave = useCallback(async (pluginName: string) => {
    setSavingMap(prev => ({ ...prev, [pluginName]: true }));
    try {
      const plugin = relevantPlugins.find((entry) => entry.name === pluginName);
      if (!plugin) {
        return;
      }
      const hasValidationIssues = Object.entries(plugin.settings ?? {}).some(([key, descriptor]) => (
        descriptor.scope === 'operator'
        && descriptor.type !== 'info'
        && Boolean(getPluginSettingValidationIssue(
          plugin.name,
          key,
          descriptor,
          settingsMap[pluginName]?.[key],
          settingsMap[pluginName],
        ))
      ));
      if (hasValidationIssues) {
        logger.warn('Skipped saving operator plugin settings because validation failed', {
          pluginName,
          operatorId,
        });
        return;
      }

      const nextSettings = normalizePluginSettingsForSave(
        plugin,
        settingsMap[pluginName] ?? {},
        'operator',
      );
      await api.updatePluginOperatorSettings(pluginName, operatorId, nextSettings);
      setSettingsMap(prev => ({
        ...prev,
        [pluginName]: nextSettings,
      }));
      setOriginalSettingsMap(prev => ({
        ...prev,
        [pluginName]: nextSettings,
      }));
    } catch (err: unknown) {
      logger.error(`Failed to save operator settings for ${pluginName}`, err);
    } finally {
      setSavingMap(prev => ({ ...prev, [pluginName]: false }));
    }
  }, [operatorId, relevantPlugins, settingsMap]);

  const [expanded, setExpanded] = useState(true);

  if (!hasStrategyChoice && relevantPlugins.length === 0) return null;

  return (
    <div className="space-y-3">
      <div
        className="pt-1 flex items-center gap-2 cursor-pointer select-none"
        onClick={() => setExpanded(prev => !prev)}
      >
        <FontAwesomeIcon
          icon={faChevronRight}
          className={`text-default-400 text-xs transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="text-xs text-default-400 uppercase tracking-wider">
          {t('plugins.operatorSettings', 'Plugin Settings')}
        </span>
      </div>
      {expanded && (
        <>
          <PluginStrategySelector
            operatorId={operatorId}
            currentStrategy={currentStrategy}
            onStrategyChange={setCurrentStrategy}
          />
        </>
      )}
      {expanded && relevantPlugins.map(plugin => {
        const operatorEntries = Object.entries(plugin.settings ?? {}).filter(
          ([, d]) => d.scope === 'operator'
        );
        const currentSettings = settingsMap[plugin.name] ?? {};
        const originalSettings = originalSettingsMap[plugin.name] ?? {};
        const persistableKeys = operatorEntries
          .filter(([, descriptor]) => descriptor.type !== 'info')
          .map(([key]) => key);
        const hasValidationIssues = persistableKeys.some((key) => {
          const descriptor = plugin.settings?.[key];
          return descriptor
            ? Boolean(getPluginSettingValidationIssue(plugin.name, key, descriptor, currentSettings[key], currentSettings))
            : false;
        });
        const normalizedHasChanges = persistableKeys.some((key) => {
          const descriptor = plugin.settings?.[key];
          return descriptor
            ? !arePluginSettingValuesEqual(
              descriptor,
              currentSettings[key],
              originalSettings[key],
              plugin.name,
              key,
            )
            : currentSettings[key] !== originalSettings[key];
        });

        return (
          <section
            key={plugin.name}
            className="rounded-xl border border-default-200/70 bg-default-50/40 px-4 py-3"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h5 className="text-sm font-medium text-default-700">
                  {resolvePluginName(plugin.name, plugin.name)}
                </h5>
                <p className="mt-1 text-xs text-default-400">
                  {plugin.type === 'strategy'
                    ? t('plugins.operatorStrategySettingsHint', 'Settings for the current strategy plugin.')
                    : t('plugins.operatorPluginSettingsHint', 'Operator-specific plugin settings.')}
                </p>
              </div>
              {normalizedHasChanges && (
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  isLoading={savingMap[plugin.name]}
                  isDisabled={hasValidationIssues}
                  onPress={() => handleSave(plugin.name)}
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
                  onChange={(val) => handleChange(plugin.name, key, val)}
                  pluginName={plugin.name}
                  settings={currentSettings}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};
