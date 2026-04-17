import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Input,
  Select,
  SelectItem,
  Spinner,
  Textarea,
} from '@heroui/react';
import { useConnection } from '../../../store/radioStore';
import { api } from '@tx5dr/core';
import type {
  PluginPanelDescriptor,
  PluginQuickAction,
  PluginQuickSetting,
  PluginSettingDescriptor,
  PluginStatus,
} from '@tx5dr/contracts';
import { createLogger } from '../../../utils/logger';
import { pluginApi } from '../../../utils/pluginApi';
import { resolvePluginLabel, resolvePluginName } from '../../../utils/pluginLocales';
import { usePluginSnapshot } from '../../../hooks/usePluginSnapshot';
import {
  arePluginSettingValuesEqual,
  getPluginSettingValidationIssue,
  normalizePluginSettingsForSave,
} from '../../../utils/pluginSettings';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck } from '@fortawesome/free-solid-svg-icons';
import { PluginPanelRenderer } from '../../plugins/PluginPanelRenderer';

const logger = createLogger('AutomationSettingsPanel');

interface AutomationSettingsPanelProps {
  operatorId: string;
}

interface PluginQuickGroup {
  plugin: PluginStatus;
  actions: PluginQuickAction[];
  settings: PluginQuickSetting[];
  panels: PluginPanelDescriptor[];
}

const QUICK_ACTION_SPINNER = (
  <Spinner
    size="sm"
    variant="simple"
    color="current"
    classNames={{ base: 'shrink-0' }}
  />
);

function hasOperatorQuickSetting(
  plugin: PluginStatus,
  quickSetting: PluginQuickSetting,
): boolean {
  const descriptor = plugin.settings?.[quickSetting.settingKey];
  return Boolean(descriptor && descriptor.scope === 'operator' && descriptor.type !== 'info');
}

function getQuickGroupRank(plugin: PluginStatus): number {
  if (plugin.type === 'strategy') {
    return 0;
  }

  if (plugin.capabilities?.includes('auto_call_candidate')) {
    return 1;
  }

  if (plugin.capabilities?.includes('auto_call_execution')) {
    return 2;
  }

  return 3;
}

function useDelayedBusyKey(busyKey: string | null, delayMs = 500): string | null {
  const [visibleBusyKey, setVisibleBusyKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!busyKey) {
      setVisibleBusyKey(null);
      return;
    }

    const timer = window.setTimeout(() => {
      setVisibleBusyKey(busyKey);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [busyKey, delayMs]);

  return visibleBusyKey === busyKey ? visibleBusyKey : null;
}

function AutomationSettingsPanelSkeleton(): React.JSX.Element {
  return (
    <div className="w-[260px] space-y-1.5 p-1">
      <div className="h-2 w-16 animate-pulse rounded-full bg-default-200/80" />
      <div className="h-8 w-full animate-pulse rounded-md bg-default-100/90" />
    </div>
  );
}

export const AutomationSettingsPanel: React.FC<AutomationSettingsPanelProps> = ({ operatorId }) => {
  const { t } = useTranslation('settings');
  const connection = useConnection();
  const pluginSnapshot = usePluginSnapshot();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>('');
  const [draftSettingsMap, setDraftSettingsMap] = React.useState<Record<string, Record<string, unknown>>>({});
  const [savedSettingsMap, setSavedSettingsMap] = React.useState<Record<string, Record<string, unknown>>>({});
  const [savingSettingKey, setSavingSettingKey] = React.useState<string | null>(null);
  const [runningButtonKey, setRunningButtonKey] = React.useState<string | null>(null);
  const visibleSavingSettingKey = useDelayedBusyKey(savingSettingKey);
  const visibleRunningButtonKey = useDelayedBusyKey(runningButtonKey);

  const operatorSettingsSchemaSignature = React.useMemo(() => (
    pluginSnapshot.plugins
      .map((plugin) => {
        const settingsSignature = Object.entries(plugin.settings ?? {})
          .filter(([, descriptor]) => descriptor.scope === 'operator' && descriptor.type !== 'info')
          .map(([key, descriptor]) => [
            key,
            descriptor.type,
            JSON.stringify(descriptor.default ?? null),
            JSON.stringify(descriptor.options ?? []),
          ].join(':'))
          .sort()
          .join('|');
        const quickSettingsSignature = (plugin.quickSettings ?? [])
          .map((entry) => entry.settingKey)
          .sort()
          .join('|');
        return [plugin.name, settingsSignature, quickSettingsSignature].join('::');
      })
      .sort()
      .join('||')
  ), [pluginSnapshot.plugins]);

  const schemaPlugins = React.useMemo(
    () => pluginSnapshot.plugins,
    [operatorSettingsSchemaSignature],
  );

  const buildSettingsWithDefaults = React.useCallback((
    remoteMap: Record<string, Record<string, unknown>>,
  ): Record<string, Record<string, unknown>> => {
    const nextMap: Record<string, Record<string, unknown>> = {};

    for (const plugin of schemaPlugins) {
      const current = remoteMap[plugin.name] ?? {};
      const nextSettings: Record<string, unknown> = {};
      for (const [key, descriptor] of Object.entries(plugin.settings ?? {})) {
        if (descriptor.scope === 'operator' && descriptor.type !== 'info') {
          nextSettings[key] = key in current ? current[key] : descriptor.default;
        }
      }

      if (Object.keys(nextSettings).length > 0 || plugin.name in remoteMap) {
        nextMap[plugin.name] = nextSettings;
      }
    }

    return nextMap;
  }, [schemaPlugins]);

  const activeGroups = React.useMemo<PluginQuickGroup[]>(() => {
    return pluginSnapshot.plugins
      .map((plugin, index) => ({ plugin, index }))
      .filter((plugin) => {
        const settings = (plugin.plugin.quickSettings ?? []).filter((entry) => hasOperatorQuickSetting(plugin.plugin, entry));
        const actions = plugin.plugin.quickActions ?? [];
        const panels = (plugin.plugin.panels ?? []).filter((p) => p.slot === 'automation');
        if (settings.length === 0 && actions.length === 0 && panels.length === 0) {
          return false;
        }
        if (plugin.plugin.type === 'strategy') {
          return plugin.plugin.assignedOperatorIds?.includes(operatorId) ?? false;
        }
        return plugin.plugin.enabled;
      })
      .sort((left, right) => {
        const rankDiff = getQuickGroupRank(left.plugin) - getQuickGroupRank(right.plugin);
        if (rankDiff !== 0) {
          return rankDiff;
        }

        return left.index - right.index;
      })
      .map((plugin) => ({
        plugin: plugin.plugin,
        settings: (plugin.plugin.quickSettings ?? []).filter((entry) => hasOperatorQuickSetting(plugin.plugin, entry)),
        actions: plugin.plugin.quickActions ?? [],
        panels: (plugin.plugin.panels ?? []).filter((p) => p.slot === 'automation'),
      }));
  }, [operatorId, pluginSnapshot.plugins]);

  React.useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError('');
    pluginApi.getOperatorState(operatorId)
      .then((res) => {
        if (cancelled) {
          return;
        }
        const remoteMap = res?.operatorSettings ?? {};
        const nextMap = buildSettingsWithDefaults(remoteMap);
        setDraftSettingsMap(nextMap);
        setSavedSettingsMap(nextMap);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        logger.error('Failed to load operator plugin settings', err);
        setError(err instanceof Error ? err.message : t('automation.updateFailed'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [buildSettingsWithDefaults, operatorId, t]);

  const getEffectiveValue = React.useCallback((
    plugin: PluginStatus,
    descriptor: PluginSettingDescriptor,
    key: string,
    source: Record<string, Record<string, unknown>>,
  ): unknown => {
    const settings = source[plugin.name] ?? {};
    return key in settings ? settings[key] : descriptor.default;
  }, []);

  const persistPluginSettings = React.useCallback(async (
    plugin: PluginStatus,
    nextPluginSettings: Record<string, unknown>,
    settingKey: string,
  ) => {
    const actionKey = `${plugin.name}:${settingKey}`;
    setSavingSettingKey(actionKey);
    setError('');

    try {
      const normalizedSettings = normalizePluginSettingsForSave(plugin, nextPluginSettings, 'operator');
      await api.updatePluginOperatorSettings(plugin.name, operatorId, normalizedSettings);
      setDraftSettingsMap((prev) => ({
        ...prev,
        [plugin.name]: normalizedSettings,
      }));
      setSavedSettingsMap((prev) => ({
        ...prev,
        [plugin.name]: normalizedSettings,
      }));
    } catch (err) {
      logger.error('Failed to update automation quick setting', err);
      setError(err instanceof Error ? err.message : t('automation.updateFailed'));
      setDraftSettingsMap((prev) => ({
        ...prev,
        [plugin.name]: savedSettingsMap[plugin.name] ?? {},
      }));
    } finally {
      setSavingSettingKey(null);
    }
  }, [operatorId, savedSettingsMap, t]);

  const handleSettingDraftChange = React.useCallback((
    pluginName: string,
    key: string,
    value: unknown,
  ) => {
    setDraftSettingsMap((prev) => ({
      ...prev,
      [pluginName]: {
        ...(prev[pluginName] ?? {}),
        [key]: value,
      },
    }));
  }, []);

  const handleBooleanToggle = React.useCallback(async (
    plugin: PluginStatus,
    key: string,
    nextValue: boolean,
  ) => {
    const nextSettings = {
      ...(draftSettingsMap[plugin.name] ?? {}),
      [key]: nextValue,
    };
    setDraftSettingsMap((prev) => ({
      ...prev,
      [plugin.name]: nextSettings,
    }));
    await persistPluginSettings(plugin, nextSettings, key);
  }, [draftSettingsMap, persistPluginSettings]);

  const handleImmediateValueChange = React.useCallback(async (
    plugin: PluginStatus,
    key: string,
    nextValue: string,
  ) => {
    const nextSettings = {
      ...(draftSettingsMap[plugin.name] ?? {}),
      [key]: nextValue,
    };
    setDraftSettingsMap((prev) => ({
      ...prev,
      [plugin.name]: nextSettings,
    }));
    await persistPluginSettings(plugin, nextSettings, key);
  }, [draftSettingsMap, persistPluginSettings]);

  const handleSaveDraftSetting = React.useCallback(async (
    plugin: PluginStatus,
    key: string,
  ) => {
    const descriptor = plugin.settings?.[key];
    if (!descriptor) {
      return;
    }

    const currentValue = getEffectiveValue(plugin, descriptor, key, draftSettingsMap);
    const validationIssue = getPluginSettingValidationIssue(plugin.name, key, descriptor, currentValue);
    if (validationIssue) {
      return;
    }

    await persistPluginSettings(plugin, draftSettingsMap[plugin.name] ?? {}, key);
  }, [draftSettingsMap, getEffectiveValue, persistPluginSettings]);

  const handleButtonAction = React.useCallback(async (plugin: PluginStatus, action: PluginQuickAction) => {
    const actionKey = `${plugin.name}:${action.id}`;
    setRunningButtonKey(actionKey);
    setError('');

    try {
      connection.state.radioService?.sendPluginUserAction(plugin.name, action.id, operatorId);
    } catch (err) {
      logger.error('Failed to run plugin quick action', err);
      setError(err instanceof Error ? err.message : t('automation.updateFailed'));
    } finally {
      window.setTimeout(() => {
        setRunningButtonKey((current) => current === actionKey ? null : current);
      }, 250);
    }
  }, [connection.state.radioService, operatorId, t]);

  if (loading) {
    return <AutomationSettingsPanelSkeleton />;
  }

  if (activeGroups.length === 0) {
    return (
      <div className="py-2 text-xs text-default-400">
        {t('automation.empty', 'No quick automation actions are available for this operator.')}
      </div>
    );
  }

  return (
    <div className="w-[260px] space-y-2.5 p-1">
      {error && (
        <div className="rounded-md border border-danger-200 bg-danger-50 px-2.5 py-2 text-[11px] leading-5 text-danger-700">
          {error}
        </div>
      )}

      {activeGroups.map(({ plugin, settings, actions, panels }) => (
        <section key={plugin.name} className="space-y-1.5">
          <div className="px-1 text-[10px] uppercase tracking-[0.12em] text-default-400">
            {resolvePluginName(plugin.name, plugin.name)}
          </div>

          {settings.length > 0 && (
            <div className="space-y-1.5">
              {settings.map((entry) => {
                const descriptor = plugin.settings?.[entry.settingKey];
                if (!descriptor || descriptor.type === 'info') {
                  return null;
                }

                const currentValue = getEffectiveValue(plugin, descriptor, entry.settingKey, draftSettingsMap);
                const savedValue = getEffectiveValue(plugin, descriptor, entry.settingKey, savedSettingsMap);
                const dirty = !arePluginSettingValuesEqual(
                  descriptor,
                  currentValue,
                  savedValue,
                  plugin.name,
                  entry.settingKey,
                );
                const validationIssue = getPluginSettingValidationIssue(
                  plugin.name,
                  entry.settingKey,
                  descriptor,
                  currentValue,
                );
                const validationMessage = validationIssue
                  ? resolvePluginLabel(validationIssue.key, plugin.name).replace('{{line}}', String(validationIssue.params?.line ?? ''))
                  : '';
                const fieldId = `${plugin.name}:${entry.settingKey}`;
                const label = resolvePluginLabel(descriptor.label, plugin.name);

                if (descriptor.type === 'boolean') {
                  const isEnabled = currentValue === true;
                  return (
                    <Button
                      key={fieldId}
                      size="sm"
                      variant="light"
                      className={`h-8 w-full min-w-0 justify-between rounded-md border border-default-200/70 px-2.5 ${
                        isEnabled ? 'bg-primary-50 text-primary-700' : 'bg-content1 text-default-700'
                      }`}
                      isDisabled={savingSettingKey === fieldId}
                      isLoading={visibleSavingSettingKey === fieldId}
                      spinner={QUICK_ACTION_SPINNER}
                      spinnerPlacement="end"
                      onPress={() => {
                        void handleBooleanToggle(plugin, entry.settingKey, !isEnabled);
                      }}
                    >
                      <span className="min-w-0 text-xs">{label}</span>
                      <FontAwesomeIcon
                        icon={faCheck}
                        className={isEnabled ? 'text-primary-600' : 'opacity-0'}
                      />
                    </Button>
                  );
                }

                if (descriptor.type === 'string' && descriptor.options?.length) {
                  const selectedValue = String(currentValue ?? descriptor.default ?? '');
                  const hasSelectedOption = descriptor.options.some((option) => option.value === selectedValue);
                  return (
                    <div
                      key={fieldId}
                      className="rounded-md border border-default-200/70 bg-content1 px-2.5 py-2"
                    >
                      <div className="mb-1 text-[11px] text-default-500">{label}</div>
                      <Select
                        size="sm"
                        aria-label={label}
                        classNames={{
                          trigger: 'min-h-8 h-8 px-2 rounded-md',
                          value: 'text-xs',
                          popoverContent: 'min-w-[180px]',
                        }}
                        disallowEmptySelection
                        selectedKeys={hasSelectedOption ? [selectedValue] : []}
                        isDisabled={savingSettingKey === fieldId}
                        onSelectionChange={(keys) => {
                          const value = Array.from(keys as Set<string>)[0];
                          if (value) {
                            void handleImmediateValueChange(plugin, entry.settingKey, value);
                          }
                        }}
                      >
                        {(descriptor.options ?? []).map((option) => (
                          <SelectItem key={option.value}>
                            {resolvePluginLabel(option.label, plugin.name)}
                          </SelectItem>
                        ))}
                      </Select>
                    </div>
                  );
                }

                if (descriptor.type === 'string[]') {
                  const textValue = typeof currentValue === 'string'
                    ? currentValue
                    : Array.isArray(currentValue)
                      ? currentValue.filter((item): item is string => typeof item === 'string').join('\n')
                      : '';
                  return (
                    <div
                      key={fieldId}
                      className="rounded-md border border-default-200/70 bg-content1 px-2.5 py-2"
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-default-500">{label}</span>
                        {dirty && (
                          <Button
                            size="sm"
                            color="primary"
                            variant="flat"
                            className="h-6 min-w-0 rounded-md px-2 text-[11px]"
                            isDisabled={Boolean(validationIssue) || savingSettingKey === fieldId}
                            isLoading={visibleSavingSettingKey === fieldId}
                            spinner={QUICK_ACTION_SPINNER}
                            spinnerPlacement="end"
                            onPress={() => void handleSaveDraftSetting(plugin, entry.settingKey)}
                          >
                            {t('common:button.save')}
                          </Button>
                        )}
                      </div>
                      <Textarea
                        size="sm"
                        aria-label={label}
                        value={textValue}
                        onValueChange={(value) => handleSettingDraftChange(plugin.name, entry.settingKey, value)}
                        minRows={2}
                        maxRows={6}
                        isInvalid={Boolean(validationIssue)}
                        errorMessage={validationMessage || undefined}
                        classNames={{
                          input: 'text-xs leading-5',
                          inputWrapper: 'rounded-md px-2 py-1 shadow-none',
                          errorMessage: 'text-[11px]',
                        }}
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={fieldId}
                    className="rounded-md border border-default-200/70 bg-content1 px-2.5 py-2"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-default-500">{label}</span>
                      {dirty && (
                        <Button
                          size="sm"
                          color="primary"
                          variant="flat"
                          className="h-6 min-w-0 rounded-md px-2 text-[11px]"
                          isDisabled={Boolean(validationIssue) || savingSettingKey === fieldId}
                          isLoading={visibleSavingSettingKey === fieldId}
                          spinner={QUICK_ACTION_SPINNER}
                          spinnerPlacement="end"
                          onPress={() => void handleSaveDraftSetting(plugin, entry.settingKey)}
                        >
                          {t('common:button.save')}
                        </Button>
                      )}
                    </div>
                    <Input
                      size="sm"
                      aria-label={label}
                      value={String(currentValue ?? '')}
                      onValueChange={(value) => handleSettingDraftChange(plugin.name, entry.settingKey, value)}
                      isInvalid={Boolean(validationIssue)}
                      errorMessage={validationMessage || undefined}
                      classNames={{
                        input: 'text-xs',
                        inputWrapper: 'min-h-8 h-8 rounded-md px-2 shadow-none',
                        errorMessage: 'text-[11px]',
                      }}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {panels.length > 0 && (
            <div className="space-y-1.5">
              {panels.map((panel) => (
                <PluginPanelRenderer
                  key={`${plugin.name}:${panel.id}`}
                  pluginName={plugin.name}
                  operatorId={operatorId}
                  panelId={panel.id}
                  title={resolvePluginLabel(panel.title, plugin.name)}
                  component={panel.component}
                  pageId={panel.pageId}
                  variant="inline"
                />
              ))}
            </div>
          )}

          {actions.length > 0 && (
            <div className="space-y-1">
              {actions.map((action) => {
                const actionKey = `${plugin.name}:${action.id}`;
                return (
                  <Button
                    key={actionKey}
                    size="sm"
                    variant="flat"
                    className="h-8 w-full min-w-0 justify-start rounded-md px-2.5 text-xs"
                    isLoading={visibleRunningButtonKey === actionKey}
                    spinner={QUICK_ACTION_SPINNER}
                    spinnerPlacement="end"
                    onPress={() => void handleButtonAction(plugin, action)}
                  >
                    {resolvePluginLabel(action.label, plugin.name)}
                  </Button>
                );
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  );
};
