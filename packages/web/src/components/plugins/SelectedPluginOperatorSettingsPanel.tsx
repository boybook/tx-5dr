import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, CardBody, Tab, Tabs } from '@heroui/react';
import { api } from '@tx5dr/core';
import type { PluginStatus, RadioOperatorConfig } from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import {
  arePluginSettingValuesEqual,
  getPluginSettingValidationIssue,
  normalizePluginSettingsForSave,
} from '../../utils/pluginSettings';
import {
  canConfigurePluginForOperator,
  getDefaultOperatorPluginSettings,
  hasOperatorPluginSettings,
  PluginOperatorSettingsForm,
} from './PluginOperatorSettingsForm';

const logger = createLogger('SelectedPluginOperatorSettingsPanel');

interface SelectedPluginOperatorSettingsPanelProps {
  plugin: PluginStatus;
  operators: RadioOperatorConfig[];
  isLoadingOperators?: boolean;
  operatorsError?: string | null;
  onRetryLoadOperators?: () => void;
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export interface SelectedPluginOperatorSettingsPanelRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

export const SelectedPluginOperatorSettingsPanel = forwardRef<SelectedPluginOperatorSettingsPanelRef, SelectedPluginOperatorSettingsPanelProps>(({
  plugin,
  operators,
  isLoadingOperators = false,
  operatorsError = null,
  onRetryLoadOperators,
  onUnsavedChanges,
}, ref) => {
  const { t } = useTranslation('settings');
  const [activeOperatorId, setActiveOperatorId] = useState<string | null>(operators[0]?.id ?? null);
  const [settingsMap, setSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
  const [originalSettingsMap, setOriginalSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  const hasOperatorSettings = hasOperatorPluginSettings(plugin);

  useEffect(() => {
    setSettingsMap({});
    setOriginalSettingsMap({});
    setLoadingMap({});
    setSavingMap({});
    setErrorMap({});
    setActiveOperatorId((current) => {
      if (current && operators.some((operator) => operator.id === current)) {
        return current;
      }
      return operators[0]?.id ?? null;
    });
  }, [operators, plugin.name]);

  const loadOperatorSettings = useCallback(async (operatorId: string, force = false) => {
    if (!hasOperatorSettings || (!force && operatorId in settingsMap) || loadingMap[operatorId]) {
      return;
    }

    const defaults = getDefaultOperatorPluginSettings(plugin);
    setLoadingMap((prev) => ({ ...prev, [operatorId]: true }));
    setSettingsMap((prev) => ({ ...prev, [operatorId]: defaults }));
    setOriginalSettingsMap((prev) => ({ ...prev, [operatorId]: defaults }));
    setErrorMap((prev) => {
      const next = { ...prev };
      delete next[operatorId];
      return next;
    });

    try {
      const response = await api.getPluginOperatorSettings(plugin.name, operatorId);
      const merged = { ...defaults, ...(response?.settings ?? {}) };
      setSettingsMap((prev) => ({ ...prev, [operatorId]: merged }));
      setOriginalSettingsMap((prev) => ({ ...prev, [operatorId]: merged }));
    } catch (err: unknown) {
      logger.error('Failed to load operator plugin settings', err);
      setErrorMap((prev) => ({
        ...prev,
        [operatorId]: err instanceof Error ? err.message : t('plugins.operatorSettingsLoadFailed', 'Failed to load operator settings.'),
      }));
    } finally {
      setLoadingMap((prev) => {
        const next = { ...prev };
        delete next[operatorId];
        return next;
      });
    }
  }, [hasOperatorSettings, loadingMap, plugin, settingsMap, t]);

  useEffect(() => {
    if (activeOperatorId) {
      void loadOperatorSettings(activeOperatorId);
    }
  }, [activeOperatorId, loadOperatorSettings]);

  const dirtyOperatorIds = useMemo(() => {
    return Object.keys(settingsMap).filter((operatorId) => {
      const current = settingsMap[operatorId] ?? {};
      const original = originalSettingsMap[operatorId] ?? {};
      return Object.keys(current).some((key) => {
        const descriptor = plugin.settings?.[key];
        if (descriptor?.scope !== 'operator' || descriptor.hidden) return false;
        return descriptor
          ? !arePluginSettingValuesEqual(descriptor, current[key], original[key], plugin.name, key)
          : current[key] !== original[key];
      });
    });
  }, [originalSettingsMap, plugin, settingsMap]);

  useEffect(() => {
    onUnsavedChanges?.(dirtyOperatorIds.length > 0);
  }, [dirtyOperatorIds.length, onUnsavedChanges]);

  const handleChange = useCallback((operatorId: string, key: string, value: unknown) => {
    setSettingsMap((prev) => ({
      ...prev,
      [operatorId]: {
        ...(prev[operatorId] ?? getDefaultOperatorPluginSettings(plugin)),
        [key]: value,
      },
    }));
  }, [plugin]);

  const handleSaveOperator = useCallback(async (operatorId: string) => {
    setSavingMap((prev) => ({ ...prev, [operatorId]: true }));
    try {
      const currentSettings = settingsMap[operatorId] ?? {};
      const hasValidationIssues = Object.entries(plugin.settings ?? {}).some(([key, descriptor]) => (
        descriptor.scope === 'operator'
        && descriptor.type !== 'info'
        && !descriptor.hidden
        && Boolean(getPluginSettingValidationIssue(
          plugin.name,
          key,
          descriptor,
          currentSettings[key],
          currentSettings,
        ))
      ));
      if (hasValidationIssues) {
        logger.warn('Skipped saving operator plugin settings because validation failed', {
          pluginName: plugin.name,
          operatorId,
        });
        return;
      }

      setErrorMap((prev) => {
        const next = { ...prev };
        delete next[operatorId];
        return next;
      });
      const normalizedSettings = normalizePluginSettingsForSave(
        plugin,
        currentSettings,
        'operator',
      );
      await api.updatePluginOperatorSettings(plugin.name, operatorId, normalizedSettings);
      setSettingsMap((prev) => ({ ...prev, [operatorId]: normalizedSettings }));
      setOriginalSettingsMap((prev) => ({ ...prev, [operatorId]: normalizedSettings }));
    } catch (err: unknown) {
      logger.error('Failed to save operator plugin settings', err);
      setErrorMap((prev) => ({
        ...prev,
        [operatorId]: err instanceof Error ? err.message : t('plugins.operatorSettingsSaveFailed', 'Failed to save operator settings.'),
      }));
    } finally {
      setSavingMap((prev) => ({ ...prev, [operatorId]: false }));
    }
  }, [plugin, settingsMap, t]);

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => dirtyOperatorIds.length > 0,
    save: async () => {
      for (const operatorId of dirtyOperatorIds) {
        await handleSaveOperator(operatorId);
      }
    },
  }), [dirtyOperatorIds, handleSaveOperator]);

  if (!hasOperatorSettings) {
    return null;
  }

  return (
    <Card className="border border-default-200/70 bg-default-50/50 shadow-none">
      <CardBody className="gap-2 p-2">
        {operatorsError && (
          <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
            <div>{t('plugins.operatorSettingsLoadFailed', 'Failed to load operator settings.')}</div>
            <div className="mt-1 text-danger-600">{operatorsError}</div>
            {onRetryLoadOperators && (
              <Button size="sm" variant="flat" color="danger" className="mt-2" onPress={onRetryLoadOperators}>
                {t('common:button.retry', 'Retry')}
              </Button>
            )}
          </div>
        )}
        {!operatorsError && isLoadingOperators && (
          <div className="text-xs text-default-400">{t('common:status.loading')}</div>
        )}
        {!operatorsError && !isLoadingOperators && operators.length === 0 && (
          <div className="text-xs text-default-400">
            {t('plugins.noOperatorsForPluginSettings', 'No operators are available for operator settings.')}
          </div>
        )}
        {!operatorsError && operators.length > 0 && activeOperatorId && (
          <Tabs
            aria-label={t('plugins.operatorScopedSettings', 'Operator Settings')}
            selectedKey={activeOperatorId}
            onSelectionChange={(key) => setActiveOperatorId(String(key))}
            size="sm"
            variant="underlined"
            classNames={{
              tabList: 'overflow-x-auto p-0',
              tab: 'h-8 px-2',
              panel: 'p-0 pt-1',
            }}
          >
            {operators.map((operator) => {
              const canConfigure = canConfigurePluginForOperator(plugin, operator.id);
              return (
                <Tab key={operator.id} title={operator.myCallsign || operator.id}>
                  <div>
                    {!canConfigure ? (
                      <div className="rounded-xl border border-default-200/70 bg-default-50/40 px-4 py-3 text-xs text-default-400">
                        {t('plugins.operatorStrategyNotAssigned', 'Assign this strategy plugin to the operator before editing its operator settings.')}
                      </div>
                    ) : errorMap[operator.id] ? (
                      <div className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
                        {errorMap[operator.id]}
                        <Button
                          size="sm"
                          variant="flat"
                          color="danger"
                          className="mt-2"
                          onPress={() => {
                            void loadOperatorSettings(operator.id, true);
                          }}
                        >
                          {t('common:button.retry', 'Retry')}
                        </Button>
                      </div>
                    ) : loadingMap[operator.id] ? (
                      <div className="text-xs text-default-400">{t('common:status.loading')}</div>
                    ) : (
                      <PluginOperatorSettingsForm
                        plugin={plugin}
                        settings={settingsMap[operator.id] ?? {}}
                        originalSettings={originalSettingsMap[operator.id] ?? {}}
                        onChange={(key, value) => handleChange(operator.id, key, value)}
                        onSave={() => { void handleSaveOperator(operator.id); }}
                        isSaving={Boolean(savingMap[operator.id])}
                        description={plugin.type === 'strategy'
                          ? t('plugins.operatorStrategySettingsHint', 'Settings for the current strategy plugin.')
                          : t('plugins.operatorPluginSettingsHint', 'Operator-specific plugin settings.')}
                        className="rounded-xl border border-default-200/70 bg-content1/60 px-3 py-2"
                      />
                    )}
                  </div>
                </Tab>
              );
            })}
          </Tabs>
        )}
      </CardBody>
    </Card>
  );
});

SelectedPluginOperatorSettingsPanel.displayName = 'SelectedPluginOperatorSettingsPanel';
