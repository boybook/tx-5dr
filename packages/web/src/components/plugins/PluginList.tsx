import React, {
  useState,
  useCallback,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardBody,
  Chip,
  Divider,
  Switch,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@heroui/react';
import type { ChipProps } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPuzzlePiece, faCircleQuestion } from '@fortawesome/free-solid-svg-icons';
import type { PluginStatus } from '@tx5dr/contracts';
import { PluginSettingsPanel } from './PluginSettingsPanel';
import { api } from '@tx5dr/core';
import { createLogger } from '../../utils/logger';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { resolvePluginDescription, resolvePluginName } from '../../utils/pluginLocales';
import { arePluginSettingValuesEqual, normalizePluginSettingsForSave } from '../../utils/pluginSettings';

const logger = createLogger('PluginList');

interface PluginListProps {
  onSelect?: (plugin: PluginStatus | null) => void;
  onUnsavedChanges?: (hasChanges: boolean) => void;
  emptyMessage?: string;
}

export interface PluginListRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

export const PluginList = forwardRef<PluginListRef, PluginListProps>(({
  onSelect,
  onUnsavedChanges,
  emptyMessage,
}, ref) => {
  const { t } = useTranslation('settings');
  const [selectedPlugin, setSelectedPlugin] = useState<PluginStatus | null>(null);
  const [_saving, setSaving] = useState(false);
  const pluginSnapshot = usePluginSnapshot();
  const plugins = pluginSnapshot.plugins;
  const [enabledDrafts, setEnabledDrafts] = useState<Record<string, boolean>>({});
  const [originalEnabledMap, setOriginalEnabledMap] = useState<Record<string, boolean>>({});
  const [globalSettingsMap, setGlobalSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
  const [originalGlobalSettingsMap, setOriginalGlobalSettingsMap] = useState<Record<string, Record<string, unknown>>>({});
  const [loadingSettingsMap, setLoadingSettingsMap] = useState<Record<string, boolean>>({});

  const getDefaultGlobalSettings = useCallback((plugin: PluginStatus) => {
    const defaults: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(plugin.settings ?? {})) {
      if ((!descriptor.scope || descriptor.scope === 'global') && descriptor.type !== 'info') {
        defaults[key] = descriptor.default;
      }
    }
    return defaults;
  }, []);

  useEffect(() => {
    setSelectedPlugin((prev) => {
      if (!prev) return null;
      return plugins.find((plugin) => plugin.name === prev.name) ?? null;
    });
  }, [plugins]);

  useEffect(() => {
    setOriginalEnabledMap((prevOriginal) => {
      const nextOriginal: Record<string, boolean> = {};
      const nextDrafts: Record<string, boolean> = {};

      for (const plugin of plugins) {
        if (plugin.type !== 'utility') continue;
        nextOriginal[plugin.name] = plugin.enabled;
      }

      setEnabledDrafts((prevDrafts) => {
        for (const [name, enabled] of Object.entries(nextOriginal)) {
          const previousOriginal = prevOriginal[name];
          const previousDraft = prevDrafts[name];
          nextDrafts[name] = previousDraft === undefined || previousDraft === previousOriginal
            ? enabled
            : previousDraft;
        }
        return nextDrafts;
      });

      return nextOriginal;
    });
  }, [plugins]);

  const ensureGlobalSettingsLoaded = useCallback(async (plugin: PluginStatus) => {
    const globalEntries = Object.entries(plugin.settings ?? {}).filter(
      ([, descriptor]) => (!descriptor.scope || descriptor.scope === 'global') && descriptor.type !== 'info'
    );
    if (globalEntries.length === 0) return;
    if (plugin.name in globalSettingsMap || loadingSettingsMap[plugin.name]) return;

    const defaults = getDefaultGlobalSettings(plugin);
    setLoadingSettingsMap((prev) => ({ ...prev, [plugin.name]: true }));
    setGlobalSettingsMap((prev) => ({ ...prev, [plugin.name]: defaults }));
    setOriginalGlobalSettingsMap((prev) => ({ ...prev, [plugin.name]: defaults }));

    try {
      const res = await api.getPluginGlobalSettings(plugin.name);
      const merged = { ...defaults, ...(res?.settings ?? {}) };
      setGlobalSettingsMap((prev) => {
        const current = prev[plugin.name];
        const original = originalGlobalSettingsMap[plugin.name];
        const shouldReplace = !current || JSON.stringify(current) === JSON.stringify(original ?? defaults);
        return shouldReplace ? { ...prev, [plugin.name]: merged } : prev;
      });
      setOriginalGlobalSettingsMap((prev) => ({ ...prev, [plugin.name]: merged }));
    } catch (err: unknown) {
      logger.error('Failed to load plugin settings', err);
    } finally {
      setLoadingSettingsMap((prev) => {
        const next = { ...prev };
        delete next[plugin.name];
        return next;
      });
    }
  }, [getDefaultGlobalSettings, globalSettingsMap, loadingSettingsMap, originalGlobalSettingsMap]);

  useEffect(() => {
    if (!selectedPlugin) return;
    void ensureGlobalSettingsLoaded(selectedPlugin);
  }, [selectedPlugin, ensureGlobalSettingsLoaded]);

  const dirty = useMemo(() => {
    const toggleChanged = Object.entries(enabledDrafts).some(
      ([name, enabled]) => enabled !== originalEnabledMap[name]
    );
    if (toggleChanged) return true;

    return Object.keys(globalSettingsMap).some((pluginName) => {
      const plugin = plugins.find((entry) => entry.name === pluginName);
      const current = globalSettingsMap[pluginName] ?? {};
      const original = originalGlobalSettingsMap[pluginName] ?? {};
      return Object.keys(current).some((key) => {
        const descriptor = plugin?.settings?.[key];
        return descriptor
          ? !arePluginSettingValuesEqual(descriptor, current[key], original[key])
          : current[key] !== original[key];
      });
    });
  }, [enabledDrafts, globalSettingsMap, originalEnabledMap, originalGlobalSettingsMap, plugins]);

  const hasUnsavedChanges = useCallback(() => dirty, [dirty]);

  useEffect(() => {
    onUnsavedChanges?.(dirty);
  }, [dirty, onUnsavedChanges]);

  const save = useCallback(async () => {
    const toggleChanges = Object.entries(enabledDrafts).filter(
      ([name, enabled]) => enabled !== originalEnabledMap[name]
    );
    const settingChanges = Object.keys(globalSettingsMap).filter((pluginName) => {
      const plugin = plugins.find((entry) => entry.name === pluginName);
      const current = globalSettingsMap[pluginName] ?? {};
      const original = originalGlobalSettingsMap[pluginName] ?? {};
      return Object.keys(current).some((key) => {
        const descriptor = plugin?.settings?.[key];
        return descriptor
          ? !arePluginSettingValuesEqual(descriptor, current[key], original[key])
          : current[key] !== original[key];
      });
    });

    if (toggleChanges.length === 0 && settingChanges.length === 0) return;

    setSaving(true);
    try {
      for (const [name, enabled] of toggleChanges) {
        if (enabled) {
          await api.enablePlugin(name);
        } else {
          await api.disablePlugin(name);
        }
      }

      for (const pluginName of settingChanges) {
        const plugin = plugins.find((entry) => entry.name === pluginName);
        if (!plugin) {
          continue;
        }

        const normalizedSettings = normalizePluginSettingsForSave(
          plugin,
          globalSettingsMap[pluginName] ?? {},
          'global',
        );
        await api.updatePluginGlobalSettings(pluginName, normalizedSettings);
        setGlobalSettingsMap((prev) => ({
          ...prev,
          [pluginName]: normalizedSettings,
        }));
      }

      setOriginalEnabledMap((prev) => {
        const next = { ...prev };
        for (const [name, enabled] of toggleChanges) {
          next[name] = enabled;
        }
        return next;
      });
      setOriginalGlobalSettingsMap((prev) => {
        const next = { ...prev };
        for (const pluginName of settingChanges) {
          const plugin = plugins.find((entry) => entry.name === pluginName);
          next[pluginName] = plugin
            ? normalizePluginSettingsForSave(plugin, globalSettingsMap[pluginName] ?? {}, 'global')
            : { ...(globalSettingsMap[pluginName] ?? {}) };
        }
        return next;
      });
    } finally {
      setSaving(false);
    }
  }, [enabledDrafts, globalSettingsMap, originalEnabledMap, originalGlobalSettingsMap, plugins]);

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save,
  }), [hasUnsavedChanges, save]);

  const handleToggle = useCallback((plugin: PluginStatus, enabled: boolean) => {
    setEnabledDrafts((prev) => ({ ...prev, [plugin.name]: enabled }));
  }, []);

  const handleSelect = useCallback((plugin: PluginStatus) => {
    const next = selectedPlugin?.name === plugin.name ? null : plugin;
    setSelectedPlugin(next);
    onSelect?.(next);
  }, [selectedPlugin, onSelect]);

  const displayPlugins = useMemo(() => plugins.map((plugin) => {
    if (plugin.type !== 'utility') return plugin;
    const draftEnabled = enabledDrafts[plugin.name];
    return {
      ...plugin,
      enabled: draftEnabled ?? plugin.enabled,
    };
  }), [enabledDrafts, plugins]);

  const strategyPlugins = displayPlugins.filter(p => p.type === 'strategy');
  const utilityPlugins = displayPlugins.filter(p => p.type === 'utility');
  return (
    <div className="flex flex-col gap-3">
      {strategyPlugins.length > 0 && (
        <>
          <PluginSectionTitle
            label={t('plugins.strategyPlugins', 'Strategy Plugins')}
            helpTitle={t('plugins.strategyPluginsHelpTitle', 'What is a strategy plugin?')}
            helpDescription={t(
              'plugins.strategyPluginsHelpDescription',
              'Strategy plugins define one operator\'s core automation behavior. Each operator can use only one strategy plugin at a time.'
            )}
          />
          {strategyPlugins.map((plugin) => {
            const isSelected = selectedPlugin?.name === plugin.name;
            return (
              <React.Fragment key={plugin.name}>
                <PluginCard
                  plugin={plugin}
                  selected={isSelected}
                  onSelect={handleSelect}
                  onToggle={handleToggle}
                />
                {isSelected && (
                  <div className="-mt-1">
                    <PluginSettingsPanel
                      plugin={plugin}
                      settings={globalSettingsMap[plugin.name] ?? {}}
                      isLoading={Boolean(loadingSettingsMap[plugin.name])}
                      embedded
                      onChange={(key, value) => {
                        setGlobalSettingsMap((prev) => ({
                          ...prev,
                          [plugin.name]: {
                            ...(prev[plugin.name] ?? getDefaultGlobalSettings(plugin)),
                            [key]: value,
                          },
                        }));
                      }}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </>
      )}

      {utilityPlugins.length > 0 && (
        <>
          <Divider className="my-1" />
          <PluginSectionTitle
            label={t('plugins.utilityPlugins', 'Utility Plugins')}
            helpTitle={t('plugins.utilityPluginsHelpTitle', 'What is a utility plugin?')}
            helpDescription={t(
              'plugins.utilityPluginsHelpDescription',
              'Utility plugins provide extra capabilities, filters, or integrations. They can usually be enabled together without replacing the main strategy.'
            )}
          />
          {utilityPlugins.map((plugin) => {
            const isSelected = selectedPlugin?.name === plugin.name;
            return (
              <React.Fragment key={plugin.name}>
                <PluginCard
                  plugin={plugin}
                  selected={isSelected}
                  onSelect={handleSelect}
                  onToggle={handleToggle}
                />
                {isSelected && (
                  <div className="-mt-1">
                    <PluginSettingsPanel
                      plugin={plugin}
                      settings={globalSettingsMap[plugin.name] ?? {}}
                      isLoading={Boolean(loadingSettingsMap[plugin.name])}
                      embedded
                      onChange={(key, value) => {
                        setGlobalSettingsMap((prev) => ({
                          ...prev,
                          [plugin.name]: {
                            ...(prev[plugin.name] ?? getDefaultGlobalSettings(plugin)),
                            [key]: value,
                          },
                        }));
                      }}
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </>
      )}

      {plugins.length === 0 && (
        <div className="text-sm text-default-400 text-center py-4">
          {emptyMessage ?? t('plugins.empty', 'No plugins installed yet.')}
        </div>
      )}
    </div>
  );
});

PluginList.displayName = 'PluginList';

interface PluginSectionTitleProps {
  label: string;
  helpTitle: string;
  helpDescription: string;
}

const PluginSectionTitle: React.FC<PluginSectionTitleProps> = ({
  label,
  helpTitle,
  helpDescription,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-1.5 text-xs text-default-400 uppercase tracking-wider">
      <span>{label}</span>
      <Popover
        placement="right"
        isOpen={open}
        onOpenChange={setOpen}
        showArrow
      >
        <PopoverTrigger>
          <button
            type="button"
            aria-label={helpTitle}
            className="flex h-4 w-4 items-center justify-center rounded-full text-default-400 transition-colors hover:text-default-600"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
          >
            <FontAwesomeIcon icon={faCircleQuestion} className="text-[11px]" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="max-w-64 p-3">
          <div className="space-y-1">
            <div className="text-xs font-semibold text-default-700 normal-case tracking-normal">
              {helpTitle}
            </div>
            <div className="text-xs text-default-500 normal-case tracking-normal">
              {helpDescription}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

interface PluginCardProps {
  plugin: PluginStatus;
  selected: boolean;
  onSelect: (plugin: PluginStatus) => void;
  onToggle: (plugin: PluginStatus, enabled: boolean) => void;
}

const PluginCard: React.FC<PluginCardProps> = ({ plugin, selected, onSelect, onToggle }) => {
  const { t } = useTranslation('settings');
  const canToggle = plugin.type === 'utility';
  const pluginTitle = resolvePluginName(plugin.name, plugin.name);
  const pluginDescription = resolvePluginDescription(plugin.name, plugin.description);

  const statusColor: ChipProps['color'] = plugin.autoDisabled
    ? 'danger'
    : (plugin.type === 'strategy'
      ? (plugin.assignedOperatorIds?.length ?? 0) > 0
      : plugin.enabled)
      ? 'success'
      : 'default';

  const statusLabel = plugin.autoDisabled
    ? t('plugins.statusAutoDisabled', 'Auto-disabled')
    : plugin.type === 'strategy'
      ? ((plugin.assignedOperatorIds?.length ?? 0) > 0
        ? t('plugins.statusAssigned', 'Assigned')
        : t('plugins.statusAvailable', 'Available'))
      : plugin.enabled
      ? t('plugins.statusEnabled', 'Enabled')
      : t('plugins.statusDisabled', 'Disabled');

  return (
    <Card
      isPressable
      className={`cursor-pointer transition-all ${selected ? 'ring-2 ring-primary' : ''}`}
      onPress={() => onSelect(plugin)}
    >
      <CardBody className="py-2 px-3">
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faPuzzlePiece} className="text-default-400 text-xs" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{pluginTitle}</span>
              <span className="text-xs text-default-400">v{plugin.version}</span>
              {plugin.isBuiltIn && (
                <Chip size="sm" variant="flat" color="primary" className="text-xs h-4">
                  {t('plugins.builtin', 'Built-in')}
                </Chip>
              )}
            </div>
            {pluginDescription && (
              <div className="text-xs text-default-400 truncate">{pluginDescription}</div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Chip
              size="sm"
              variant="dot"
              color={statusColor}
              className="text-xs"
            >
              {statusLabel}
            </Chip>
            {canToggle && (
              <Switch
                size="sm"
                isSelected={plugin.enabled}
                onValueChange={(val) => onToggle(plugin, val)}
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>
        </div>
        {plugin.errorCount > 0 && plugin.lastError && (
          <div className="mt-1 text-xs text-danger truncate">
            {t('plugins.errorCount', '{{count}} errors', { count: plugin.errorCount })}: {plugin.lastError}
          </div>
        )}
      </CardBody>
    </Card>
  );
};
