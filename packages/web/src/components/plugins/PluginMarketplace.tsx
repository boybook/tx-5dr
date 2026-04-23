import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Divider,
  Input,
  Listbox,
  ListboxItem,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ScrollShadow,
  Spinner,
  Switch,
  Tab,
  Tabs,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import type {
  PluginMarketCatalogEntry,
  PluginMarketCatalogResponse,
  PluginMarketChannel,
  PluginSource,
  PluginStatus,
} from '@tx5dr/contracts';
import { UserRole } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { useHasMinRole } from '../../store/authStore';
import { formatDateTime } from '../../utils/dateFormatting';
import { localizeError, showErrorToast } from '../../utils/errorToast';
import { createLogger } from '../../utils/logger';
import {
  registerPluginLocales,
  resolvePluginDescription,
  resolvePluginName,
} from '../../utils/pluginLocales';

const logger = createLogger('PluginMarketplace');

interface PluginMarketplaceProps {
  isActive: boolean;
  onOpenInstalledPlugin?: (pluginName: string) => void;
}

type CatalogMap = Partial<Record<PluginMarketChannel, PluginMarketCatalogResponse>>;
type StringMap = Partial<Record<PluginMarketChannel, string>>;
type BooleanMap = Partial<Record<PluginMarketChannel, boolean>>;
type PluginAction = 'install' | 'update' | 'uninstall';
type MarketplaceSource = Extract<PluginSource, { kind: 'marketplace' }>;

interface MarketItemState {
  entry: PluginMarketCatalogEntry;
  installedPlugin?: PluginStatus;
  installRecord?: MarketplaceSource;
  isInstalled: boolean;
  isBuiltIn: boolean;
  isMarketplaceManaged: boolean;
  isManualInstall: boolean;
  installedVersion?: string;
  versionComparison: number;
  hasUpdate: boolean;
  hasChannelSwitch: boolean;
  selectedChannelIsOlder: boolean;
}

function parseSemverLike(value: string): { main: number[]; prerelease: string[] } {
  const normalized = value.trim();
  const [mainPart, prereleasePart = ''] = normalized.split('-', 2);
  const main = mainPart
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((segment) => (Number.isFinite(segment) ? segment : 0));
  const prerelease = prereleasePart
    ? prereleasePart.split('.').filter(Boolean)
    : [];
  return { main, prerelease };
}

function compareSemverLike(left: string, right: string): number {
  const leftVersion = parseSemverLike(left);
  const rightVersion = parseSemverLike(right);
  const length = Math.max(leftVersion.main.length, rightVersion.main.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftVersion.main[index] ?? 0;
    const rightValue = rightVersion.main[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
    return 0;
  }
  if (leftVersion.prerelease.length === 0) {
    return 1;
  }
  if (rightVersion.prerelease.length === 0) {
    return -1;
  }

  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftValue = leftVersion.prerelease[index];
    const rightValue = rightVersion.prerelease[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (leftValue === undefined) {
      return -1;
    }
    if (rightValue === undefined) {
      return 1;
    }

    const leftNumeric = Number.parseInt(leftValue, 10);
    const rightNumeric = Number.parseInt(rightValue, 10);
    const bothNumeric = Number.isFinite(leftNumeric) && Number.isFinite(rightNumeric);
    if (bothNumeric && leftNumeric !== rightNumeric) {
      return leftNumeric > rightNumeric ? 1 : -1;
    }

    const lexical = leftValue.localeCompare(rightValue);
    if (lexical !== 0) {
      return lexical > 0 ? 1 : -1;
    }
  }

  return 0;
}

function buildMarketItemState(
  entry: PluginMarketCatalogEntry,
  channel: PluginMarketChannel,
  installedPluginsByName: Map<string, PluginStatus>,
): MarketItemState {
  const installedPlugin = installedPluginsByName.get(entry.name);
  const installRecord = installedPlugin?.source?.kind === 'marketplace'
    ? installedPlugin.source
    : undefined;
  const installedVersion = installedPlugin?.version ?? installRecord?.version;
  const versionComparison = installedVersion
    ? compareSemverLike(entry.latestVersion, installedVersion)
    : 0;
  const isInstalled = Boolean(installedPlugin);
  const isBuiltIn = installedPlugin?.isBuiltIn ?? false;
  const isMarketplaceManaged = isInstalled && !isBuiltIn && Boolean(installRecord);
  const isManualInstall = isInstalled && !isBuiltIn && !installRecord;
  const hasUpdate = isMarketplaceManaged && versionComparison > 0;
  const hasChannelSwitch = isMarketplaceManaged
    && versionComparison === 0
    && installRecord?.channel !== channel;
  const selectedChannelIsOlder = isMarketplaceManaged && versionComparison < 0;

  return {
    entry,
    installedPlugin,
    installRecord,
    isInstalled,
    isBuiltIn,
    isMarketplaceManaged,
    isManualInstall,
    installedVersion,
    versionComparison,
    hasUpdate,
    hasChannelSwitch,
    selectedChannelIsOlder,
  };
}

function getActionPriority(item: MarketItemState): number {
  if (item.hasUpdate) return 4;
  if (item.hasChannelSwitch) return 3;
  if (item.isInstalled) return 2;
  return 1;
}

function hasGlobalSettings(plugin?: PluginStatus): boolean {
  return Object.values(plugin?.settings ?? {}).some(
    (descriptor) => descriptor.type !== 'info' && (!descriptor.scope || descriptor.scope === 'global'),
  );
}

function getMarketplaceEntryTitle(entry: PluginMarketCatalogEntry): string {
  return resolvePluginName(entry.name, entry.title);
}

function getMarketplaceEntryDescription(entry: PluginMarketCatalogEntry): string {
  return resolvePluginDescription(entry.name, entry.description) ?? entry.description;
}

function registerMarketplaceCatalogLocales(entries: PluginMarketCatalogEntry[]): void {
  for (const entry of entries) {
    registerPluginLocales(entry.name, entry.locales);
  }
}

export function PluginMarketplace({ isActive, onOpenInstalledPlugin }: PluginMarketplaceProps) {
  const { t, i18n } = useTranslation('settings');
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const pluginSnapshot = usePluginSnapshot();
  const installedPluginsByName = useMemo(
    () => new Map(pluginSnapshot.plugins.map((plugin) => [plugin.name, plugin])),
    [pluginSnapshot.plugins],
  );
  const currentLanguage = i18n.resolvedLanguage ?? i18n.language;

  const [channel, setChannel] = useState<PluginMarketChannel>('nightly');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [catalogByChannel, setCatalogByChannel] = useState<CatalogMap>({});
  const [catalogLoading, setCatalogLoading] = useState<BooleanMap>({});
  const [catalogError, setCatalogError] = useState<StringMap>({});
  const [selectedNameByChannel, setSelectedNameByChannel] = useState<StringMap>({});
  const [entryByKey, setEntryByKey] = useState<Record<string, PluginMarketCatalogEntry>>({});
  const [entryLoading, setEntryLoading] = useState<Record<string, boolean>>({});
  const [pendingActionByPlugin, setPendingActionByPlugin] = useState<Partial<Record<string, PluginAction>>>({});
  const [pendingToggleByPlugin, setPendingToggleByPlugin] = useState<Record<string, boolean>>({});
  const [uninstallCandidate, setUninstallCandidate] = useState<PluginMarketCatalogEntry | null>(null);
  const catalogByChannelRef = useRef<CatalogMap>({});
  const catalogLoadingRef = useRef<BooleanMap>({});
  const entryByKeyRef = useRef<Record<string, PluginMarketCatalogEntry>>({});
  const entryLoadingRef = useRef<Record<string, boolean>>({});

  const loadCatalog = useCallback(async (targetChannel: PluginMarketChannel, force = false) => {
    if (!force && (catalogByChannelRef.current[targetChannel] || catalogLoadingRef.current[targetChannel])) {
      return;
    }

    catalogLoadingRef.current = { ...catalogLoadingRef.current, [targetChannel]: true };
    setCatalogLoading((prev) => ({ ...prev, [targetChannel]: true }));
    setCatalogError((prev) => {
      const next = { ...prev };
      delete next[targetChannel];
      return next;
    });

    try {
      const response = await api.getPluginMarketCatalog(targetChannel);
      registerMarketplaceCatalogLocales(response.catalog.plugins);
      catalogByChannelRef.current = { ...catalogByChannelRef.current, [targetChannel]: response };
      setCatalogByChannel((prev) => ({ ...prev, [targetChannel]: response }));
    } catch (err: unknown) {
      logger.error(`Failed to load plugin marketplace catalog for ${targetChannel}`, err);
      setCatalogError((prev) => ({
        ...prev,
        [targetChannel]: localizeError(err) || t('plugins.marketError', 'Failed to load marketplace catalog.'),
      }));
    } finally {
      catalogLoadingRef.current = { ...catalogLoadingRef.current, [targetChannel]: false };
      setCatalogLoading((prev) => ({ ...prev, [targetChannel]: false }));
    }
  }, [t]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    void loadCatalog(channel);
  }, [channel, isActive, loadCatalog]);

  const currentCatalog = catalogByChannel[channel]?.catalog.plugins ?? [];
  const currentItems = useMemo(
    () => currentCatalog.map((entry) => buildMarketItemState(entry, channel, installedPluginsByName)),
    [channel, currentCatalog, installedPluginsByName],
  );

  const filteredItems = useMemo(() => {
    const normalizedQuery = deferredSearch.trim();
    const sorted = [...currentItems].sort((left, right) => {
      const priority = getActionPriority(right) - getActionPriority(left);
      if (priority !== 0) {
        return priority;
      }
      return getMarketplaceEntryTitle(left.entry).localeCompare(getMarketplaceEntryTitle(right.entry));
    });

    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter((item) => [
      item.entry.name,
      getMarketplaceEntryTitle(item.entry),
      getMarketplaceEntryDescription(item.entry),
      ...item.entry.categories,
      ...item.entry.keywords,
    ].some((value) => value.toLowerCase().includes(normalizedQuery)));
  }, [currentItems, currentLanguage, deferredSearch]);

  const selectedName = selectedNameByChannel[channel];
  const visibleSelectedName = filteredItems.some((item) => item.entry.name === selectedName)
    ? selectedName
    : filteredItems[0]?.entry.name;

  useEffect(() => {
    if (!filteredItems.length || !visibleSelectedName) {
      return;
    }
    setSelectedNameByChannel((prev) => (
      prev[channel] === visibleSelectedName
        ? prev
        : { ...prev, [channel]: visibleSelectedName }
    ));
  }, [channel, filteredItems, visibleSelectedName]);

  const selectedListItem = filteredItems.find((item) => item.entry.name === visibleSelectedName)
    ?? currentItems.find((item) => item.entry.name === visibleSelectedName)
    ?? null;
  const selectedCatalogEntry = selectedListItem?.entry ?? null;
  const selectedEntryKey = selectedCatalogEntry ? `${channel}:${selectedCatalogEntry.name}` : null;
  const selectedEntry = selectedEntryKey
    ? (entryByKey[selectedEntryKey] ?? selectedCatalogEntry)
    : null;

  useEffect(() => {
    if (
      !isActive
      || !selectedCatalogEntry
      || !selectedEntryKey
      || entryByKeyRef.current[selectedEntryKey]
      || entryLoadingRef.current[selectedEntryKey]
    ) {
      return;
    }

    entryLoadingRef.current = { ...entryLoadingRef.current, [selectedEntryKey]: true };
    setEntryLoading((prev) => ({ ...prev, [selectedEntryKey]: true }));
    void api.getPluginMarketCatalogEntry(selectedCatalogEntry.name, channel)
      .then((response) => {
        registerPluginLocales(response.plugin.name, response.plugin.locales);
        entryByKeyRef.current = { ...entryByKeyRef.current, [selectedEntryKey]: response.plugin };
        setEntryByKey((prev) => ({ ...prev, [selectedEntryKey]: response.plugin }));
      })
      .catch((err: unknown) => {
        logger.error(`Failed to load marketplace plugin detail for ${selectedCatalogEntry.name}`, err);
      })
      .finally(() => {
        entryLoadingRef.current = { ...entryLoadingRef.current, [selectedEntryKey]: false };
        setEntryLoading((prev) => ({ ...prev, [selectedEntryKey]: false }));
      });
  }, [channel, isActive, selectedCatalogEntry, selectedEntryKey]);

  const selectedItem = useMemo(
    () => (selectedEntry ? buildMarketItemState(selectedEntry, channel, installedPluginsByName) : null),
    [channel, installedPluginsByName, selectedEntry],
  );

  const catalogMeta = catalogByChannel[channel];
  const isLoading = Boolean(catalogLoading[channel]) && !catalogMeta;
  const loadError = catalogError[channel];
  const listedCount = filteredItems.length;
  const installedCount = currentItems.filter((item) => item.isInstalled).length;
  const updatesCount = currentItems.filter((item) => item.hasUpdate || item.hasChannelSwitch).length;

  const runPluginAction = useCallback(async (action: PluginAction, item: MarketItemState) => {
    const { entry } = item;
    const entryTitle = getMarketplaceEntryTitle(entry);
    setPendingActionByPlugin((prev) => ({ ...prev, [entry.name]: action }));
    try {
      if (action === 'install') {
        await api.installPluginFromMarket(entry.name, channel);
        addToast({
          title: t('plugins.marketInstallSuccessTitle', 'Plugin installed'),
          description: t('plugins.marketInstallSuccessDescription', {
            defaultValue: '{{title}} was installed from the {{channel}} channel.',
            title: entryTitle,
            channel,
          }),
          color: 'success',
          timeout: 3500,
        });
      } else if (action === 'update') {
        await api.updatePluginFromMarket(entry.name, channel);
        addToast({
          title: t('plugins.marketUpdateSuccessTitle', 'Plugin updated'),
          description: t('plugins.marketUpdateSuccessDescription', {
            defaultValue: '{{title}} is now aligned with the {{channel}} channel.',
            title: entryTitle,
            channel,
          }),
          color: 'success',
          timeout: 3500,
        });
      } else {
        await api.uninstallPluginFromMarket(entry.name);
        setUninstallCandidate(null);
        addToast({
          title: t('plugins.marketUninstallSuccessTitle', 'Plugin uninstalled'),
          description: t('plugins.marketUninstallSuccessDescription', {
            defaultValue: '{{title}} was removed. Existing plugin data was preserved.',
            title: entryTitle,
          }),
          color: 'success',
          timeout: 3500,
        });
      }
    } catch (err: unknown) {
      logger.error(`Plugin marketplace ${action} failed for ${entry.name}`, err);
      showErrorToast({
        userMessage: localizeError(err),
        severity: 'error',
      });
    } finally {
      setPendingActionByPlugin((prev) => {
        const next = { ...prev };
        delete next[entry.name];
        return next;
      });
    }
  }, [channel, t]);

  const selectedPendingAction = selectedItem ? pendingActionByPlugin[selectedItem.entry.name] : undefined;
  const selectedTogglePending = selectedItem ? Boolean(pendingToggleByPlugin[selectedItem.entry.name]) : false;
  const selectedCanToggle = selectedItem?.installedPlugin?.type === 'utility';
  const selectedHasGlobalSettings = hasGlobalSettings(selectedItem?.installedPlugin);
  const selectedTitle = selectedItem ? getMarketplaceEntryTitle(selectedItem.entry) : '';
  const selectedDescription = selectedItem ? getMarketplaceEntryDescription(selectedItem.entry) : '';

  const handleToggleEnabled = useCallback(async (plugin: PluginStatus, enabled: boolean) => {
    setPendingToggleByPlugin((prev) => ({ ...prev, [plugin.name]: true }));
    try {
      if (enabled) {
        await api.enablePlugin(plugin.name);
      } else {
        await api.disablePlugin(plugin.name);
      }
      addToast({
        title: enabled
          ? t('plugins.marketEnableSuccessTitle', 'Plugin enabled')
          : t('plugins.marketDisableSuccessTitle', 'Plugin disabled'),
        description: enabled
          ? t('plugins.marketEnableSuccessDescription', {
            defaultValue: '{{title}} is now enabled.',
            title: plugin.name,
          })
          : t('plugins.marketDisableSuccessDescription', {
            defaultValue: '{{title}} is now disabled.',
            title: plugin.name,
          }),
        color: 'success',
        timeout: 2500,
      });
    } catch (err: unknown) {
      logger.error(`Plugin enable toggle failed for ${plugin.name}`, err);
      showErrorToast({
        userMessage: localizeError(err),
        severity: 'error',
      });
    } finally {
      setPendingToggleByPlugin((prev) => {
        const next = { ...prev };
        delete next[plugin.name];
        return next;
      });
    }
  }, [t]);

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="rounded-large border border-divider bg-content1 px-4 py-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <Input
              size="sm"
              variant="bordered"
              value={search}
              onValueChange={setSearch}
              placeholder={t('plugins.marketSearchPlaceholder', 'Search by title, description, category, or keyword')}
              className="w-full"
            />
            <div className="flex flex-wrap items-center gap-2 lg:justify-end">
              <Tabs
                aria-label={t('plugins.marketplaceTitle', 'Marketplace')}
                selectedKey={channel}
                onSelectionChange={(key) => setChannel(key as PluginMarketChannel)}
                size="sm"
                radius="full"
                variant="solid"
              >
                <Tab key="stable" title={t('plugins.marketChannelStable', 'Stable')} />
                <Tab key="nightly" title={t('plugins.marketChannelNightly', 'Nightly')} />
              </Tabs>
              <Button
                size="sm"
                variant="flat"
                className="lg:self-end"
                onPress={() => { void loadCatalog(channel, true); }}
                isLoading={Boolean(catalogLoading[channel]) && Boolean(catalogMeta)}
              >
                {t('plugins.marketRefresh', 'Refresh')}
              </Button>
            </div>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center rounded-large border border-divider bg-content1 py-12">
            <Spinner size="md" />
          </div>
        )}

        {!isLoading && loadError && (
          <Alert
            color="danger"
            variant="flat"
            title={t('plugins.marketError', 'Failed to load marketplace catalog.')}
            description={loadError}
            endContent={(
              <Button size="sm" color="danger" variant="flat" onPress={() => { void loadCatalog(channel, true); }}>
                {t('plugins.marketRetry', 'Retry')}
              </Button>
            )}
          />
        )}

        {!isLoading && !loadError && currentCatalog.length === 0 && (
          <div className="rounded-large border border-dashed border-divider bg-content1 px-4 py-10 text-center text-sm text-default-400">
            {t('plugins.marketEmpty', 'No marketplace plugins are available for this channel.')}
          </div>
        )}

        {!isLoading && !loadError && currentCatalog.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="min-w-0 rounded-large border border-divider bg-content1">
              <div className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-default-700">
                    {t('plugins.viewMarketplace', 'Marketplace')}
                  </div>
                  <div className="text-xs text-default-400">
                    {t('plugins.marketCount', '{{count}} listed', { count: listedCount })}
                  </div>
                </div>
              </div>
              <Divider />
              {filteredItems.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-default-400">
                  {t('plugins.marketNoResults', 'No marketplace plugins match the current search.')}
                </div>
              ) : (
                <ScrollShadow className="max-h-[58vh] lg:max-h-[72vh]">
                  <Listbox
                    aria-label={t('plugins.viewMarketplace', 'Marketplace')}
                    selectionMode="single"
                    selectedKeys={visibleSelectedName ? new Set([visibleSelectedName]) : new Set()}
                    onSelectionChange={(keys) => {
                      if (keys === 'all') {
                        return;
                      }
                      const key = Array.from(keys)[0];
                      if (typeof key === 'string') {
                        setSelectedNameByChannel((prev) => ({ ...prev, [channel]: key }));
                      }
                    }}
                    variant="flat"
                    className="p-0"
                    itemClasses={{
                      base: 'rounded-none px-4 py-3 data-[hover=true]:bg-default-100 data-[selectable=true]:focus:bg-default-100 data-[selected=true]:bg-primary-50 data-[selected=true]:text-foreground',
                      selectedIcon: 'hidden',
                    }}
                  >
                    {filteredItems.map((item) => {
                      const pendingAction = pendingActionByPlugin[item.entry.name];
                      const itemTitle = getMarketplaceEntryTitle(item.entry);
                      const itemDescription = getMarketplaceEntryDescription(item.entry);
                      return (
                        <ListboxItem
                          key={item.entry.name}
                          textValue={`${itemTitle} ${item.entry.name}`}
                          endContent={(
                            <div className="flex flex-col items-end gap-1 pl-3">
                              <Chip size="sm" variant="flat" color="secondary" className="text-[10px]">
                                {item.entry.latestVersion}
                              </Chip>
                              {item.hasUpdate && (
                                <Chip size="sm" variant="flat" color="warning" className="text-[10px]">
                                  {t('plugins.marketActionUpdate', 'Update')}
                                </Chip>
                              )}
                              {item.hasChannelSwitch && (
                                <Chip size="sm" variant="flat" color="primary" className="text-[10px]">
                                  {t('plugins.marketActionSwitchChannel', 'Switch channel')}
                                </Chip>
                              )}
                              {item.isMarketplaceManaged && !item.hasUpdate && !item.hasChannelSwitch && (
                                <Chip size="sm" variant="flat" color="success" className="text-[10px]">
                                  {t('plugins.marketInstalled', 'Installed')}
                                </Chip>
                              )}
                              {item.isManualInstall && (
                                <Chip size="sm" variant="flat" className="text-[10px]">
                                  {t('plugins.marketInstalledManual', 'Installed manually')}
                                </Chip>
                              )}
                              {pendingAction && (
                                <span className="text-[11px] text-primary">
                                  {t(`plugins.marketPending.${pendingAction}`, pendingAction)}
                                </span>
                              )}
                            </div>
                          )}
                        >
                          <div className="flex min-w-0 flex-col gap-2">
                            <div className="text-sm font-semibold leading-5 text-default-800">
                              {itemTitle}
                            </div>
                            <p className="line-clamp-2 text-xs leading-5 text-default-500">
                              {itemDescription}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-default-400">
                              <span>{item.entry.name}</span>
                              <span>
                                {t('plugins.marketMinHostVersionShort', 'Host >= {{version}}', {
                                  version: item.entry.minHostVersion,
                                })}
                              </span>
                              {item.installedVersion && (
                                <span>
                                  {t('plugins.marketInstalledVersionInline', 'Installed {{version}}', {
                                    version: item.installedVersion,
                                  })}
                                </span>
                              )}
                            </div>
                            {item.entry.categories.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {item.entry.categories.slice(0, 2).map((category) => (
                                  <Chip key={category} size="sm" variant="flat" className="h-5 text-[10px]">
                                    {category}
                                  </Chip>
                                ))}
                              </div>
                            )}
                          </div>
                        </ListboxItem>
                      );
                    })}
                  </Listbox>
                </ScrollShadow>
              )}
            </div>

            <div className="min-w-0 rounded-large border border-divider bg-content1">
              {selectedItem ? (
                <ScrollShadow className="max-h-[72vh]">
                  <div className="flex flex-col gap-5 px-5 py-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="text-lg font-semibold text-default-800">{selectedTitle}</h4>
                          <Chip size="sm" variant="flat" color="secondary" className="text-xs">
                            {t('plugins.marketLatestVersion', 'Latest version {{version}}', {
                              version: selectedItem.entry.latestVersion,
                            })}
                          </Chip>
                          {selectedItem.isMarketplaceManaged && !selectedItem.hasUpdate && !selectedItem.hasChannelSwitch && (
                            <Chip size="sm" variant="flat" color="success" className="text-xs">
                              {t('plugins.marketInstalled', 'Installed')}
                            </Chip>
                          )}
                          {selectedItem.hasUpdate && (
                            <Chip size="sm" variant="flat" color="warning" className="text-xs">
                              {t('plugins.marketUpdateAvailable', 'Update available')}
                            </Chip>
                          )}
                          {selectedItem.isManualInstall && (
                            <Chip size="sm" variant="flat" className="text-xs">
                              {t('plugins.marketInstalledManual', 'Installed manually')}
                            </Chip>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-default-400">{selectedItem.entry.name}</p>
                      </div>
                      {selectedEntryKey && entryLoading[selectedEntryKey] && <Spinner size="sm" />}
                    </div>

                    <p className="text-sm leading-7 text-default-600">{selectedDescription}</p>

                    <div className="flex flex-wrap items-center gap-2">
                      {selectedItem.isMarketplaceManaged && selectedItem.installRecord && (
                        <>
                          <Chip size="sm" variant="flat" color="success" className="text-xs">
                            {t('plugins.marketManagedByMarketplace', 'Managed by marketplace')}
                          </Chip>
                          <Chip size="sm" variant="flat" className="text-xs">
                            {t('plugins.marketInstalledChannel', 'Channel {{channel}}', {
                              channel: selectedItem.installRecord.channel,
                            })}
                          </Chip>
                        </>
                      )}
                      {selectedItem.isManualInstall && (
                        <Chip size="sm" variant="flat" className="text-xs">
                          {t('plugins.marketManagedManually', 'Managed manually')}
                        </Chip>
                      )}
                      {!selectedItem.isInstalled && (
                        <Chip size="sm" variant="flat" className="text-xs">
                          {t('plugins.marketNotInstalled', 'Not installed')}
                        </Chip>
                      )}
                    </div>

                    {selectedItem.installRecord && (
                      <div className="text-xs text-default-500">
                        {t('plugins.marketInstalledAt', 'Installed at {{value}}', {
                          value: formatDateTime(selectedItem.installRecord.installedAt),
                        })}
                      </div>
                    )}

                    {selectedItem.isManualInstall && (
                      <Alert
                        color="warning"
                        variant="flat"
                        title={t('plugins.marketInstalledManual', 'Installed manually')}
                        description={t(
                          'plugins.marketManualInstallHint',
                          'This plugin is installed on disk but is not tracked by the official marketplace. Update and uninstall actions stay disabled here to avoid overwriting manual files.',
                        )}
                      />
                    )}

                    {selectedItem.selectedChannelIsOlder && (
                      <Alert
                        color="warning"
                        variant="flat"
                        title={t('plugins.marketChannelSwitchAvailable', 'Channel switch available')}
                        description={t(
                          'plugins.marketChannelOlderHint',
                          'The installed version is newer than the latest build in the currently selected channel. Switch channels only after you intentionally publish or downgrade.',
                        )}
                      />
                    )}

                    {!isAdmin && (
                      <Alert
                        color="default"
                        variant="flat"
                        title={t('plugins.marketBrowseOnlyBadge', 'Browse only')}
                        description={t(
                          'plugins.marketAdminRequired',
                          'Browsing is available here, but installing, updating, and uninstalling requires an admin session.',
                        )}
                      />
                    )}

                    {isAdmin && (
                      <div className="flex flex-wrap items-center gap-2">
                        {!selectedItem.isInstalled && !selectedItem.isBuiltIn && (
                          <Button
                            color="primary"
                            onPress={() => { void runPluginAction('install', selectedItem); }}
                            isLoading={selectedPendingAction === 'install'}
                          >
                            {t('plugins.marketActionInstall', 'Install')}
                          </Button>
                        )}

                        {selectedItem.isMarketplaceManaged && (selectedItem.hasUpdate || selectedItem.hasChannelSwitch) && (
                          <Button
                            color="primary"
                            variant={selectedItem.hasUpdate ? 'solid' : 'flat'}
                            onPress={() => { void runPluginAction('update', selectedItem); }}
                            isLoading={selectedPendingAction === 'update'}
                          >
                            {selectedItem.hasUpdate
                              ? t('plugins.marketActionUpdate', 'Update')
                              : t('plugins.marketActionSwitchChannel', 'Switch channel')}
                          </Button>
                        )}

                        {selectedItem.isMarketplaceManaged && (
                          <Button
                            color="danger"
                            variant="flat"
                            onPress={() => setUninstallCandidate(selectedItem.entry)}
                            isDisabled={Boolean(selectedPendingAction)}
                          >
                            {t('plugins.marketActionUninstall', 'Uninstall')}
                          </Button>
                        )}
                      </div>
                    )}

                    {selectedItem.isInstalled && (
                      <Button
                        variant="flat"
                        onPress={() => onOpenInstalledPlugin?.(selectedItem.entry.name)}
                      >
                        {t('plugins.marketActionOpenInstalled', 'Go to Installed')}
                      </Button>
                    )}

                    {selectedItem.isInstalled && selectedCanToggle && selectedItem.installedPlugin && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-medium border border-divider px-3 py-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-default-700">
                            {t('plugins.marketEnableInlineTitle', 'Enable this plugin')}
                          </div>
                          <div className="text-xs text-default-500">
                            {selectedHasGlobalSettings
                              ? t(
                                'plugins.marketEnableInlineHintConfigurable',
                                'You can enable it here. If you need configuration, open the Installed tab for full settings.',
                              )
                              : t(
                                'plugins.marketEnableInlineHint',
                                'You can enable or disable this plugin without leaving the marketplace view.',
                              )}
                          </div>
                        </div>
                        <Switch
                          size="sm"
                          isSelected={selectedItem.installedPlugin.enabled}
                          isDisabled={!isAdmin || selectedTogglePending}
                          onValueChange={(value) => { void handleToggleEnabled(selectedItem.installedPlugin!, value); }}
                        />
                      </div>
                    )}

                    <Divider />

                    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
                      <MarketplaceMeta
                        label={t('plugins.marketInstalledVersion', 'Installed version')}
                        value={selectedItem.installedVersion ?? t('plugins.marketNotInstalled', 'Not installed')}
                      />
                      <MarketplaceMeta
                        label={t('plugins.marketMinHostVersion', 'Minimum host version')}
                        value={selectedItem.entry.minHostVersion}
                      />
                      <MarketplaceMeta
                        label={t('plugins.marketPublishedAt', 'Published at')}
                        value={formatDateTime(selectedItem.entry.publishedAt)}
                      />
                      {selectedItem.entry.author && (
                        <MarketplaceMeta
                          label={t('plugins.marketAuthor', 'Author')}
                          value={selectedItem.entry.author}
                        />
                      )}
                      {selectedItem.entry.license && (
                        <MarketplaceMeta
                          label={t('plugins.marketLicense', 'License')}
                          value={selectedItem.entry.license}
                        />
                      )}
                      <MarketplaceMeta
                        label={t('plugins.marketPackageSize', 'Package size')}
                        value={t('plugins.marketPackageSizeValue', '{{value}} KB', {
                          value: (selectedItem.entry.size / 1024).toFixed(selectedItem.entry.size >= 1024 * 100 ? 0 : 1),
                        })}
                      />
                    </div>

                    {selectedItem.entry.categories.length > 0 && (
                      <>
                        <Divider />
                        <section className="flex flex-col gap-2">
                          <span className="text-xs font-medium uppercase tracking-wider text-default-400">
                            {t('plugins.marketCategories', 'Categories')}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {selectedItem.entry.categories.map((category) => (
                              <Chip key={category} size="sm" variant="flat" className="text-xs">
                                {category}
                              </Chip>
                            ))}
                          </div>
                        </section>
                      </>
                    )}

                    {selectedItem.entry.keywords.length > 0 && (
                      <>
                        <Divider />
                        <section className="flex flex-col gap-2">
                          <span className="text-xs font-medium uppercase tracking-wider text-default-400">
                            {t('plugins.marketKeywords', 'Keywords')}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {selectedItem.entry.keywords.map((keyword) => (
                              <Chip key={keyword} size="sm" variant="flat" className="text-xs">
                                {keyword}
                              </Chip>
                            ))}
                          </div>
                        </section>
                      </>
                    )}

                    {selectedItem.entry.permissions.length > 0 && (
                      <>
                        <Divider />
                        <section className="flex flex-col gap-2">
                          <span className="text-xs font-medium uppercase tracking-wider text-default-400">
                            {t('plugins.marketPermissions', 'Requested permissions')}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {selectedItem.entry.permissions.map((permission) => (
                              <Chip key={permission} size="sm" variant="flat" color="warning" className="text-xs">
                                {permission}
                              </Chip>
                            ))}
                          </div>
                        </section>
                      </>
                    )}

                    <Divider />

                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <a
                        href={selectedItem.entry.artifactUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {t('plugins.marketDownloadArtifact', 'Artifact')}
                      </a>
                      {selectedItem.entry.repository && (
                        <a
                          href={selectedItem.entry.repository}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {t('plugins.marketRepository', 'Repository')}
                        </a>
                      )}
                      {selectedItem.entry.homepage && (
                        <a
                          href={selectedItem.entry.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {t('plugins.marketHomepage', 'Homepage')}
                        </a>
                      )}
                    </div>
                  </div>
                </ScrollShadow>
              ) : (
                <div className="px-5 py-12 text-center text-sm text-default-400">
                  {t('plugins.marketNoResults', 'No marketplace plugins match the current search.')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={Boolean(uninstallCandidate)} onClose={() => setUninstallCandidate(null)} size="sm">
        <ModalContent>
          <ModalHeader>
            {t('plugins.marketUninstallConfirmTitle', 'Uninstall plugin')}
          </ModalHeader>
          <ModalBody>
            <div className="space-y-3 text-sm text-default-600">
              <p>
                {t('plugins.marketUninstallConfirmBody', {
                  defaultValue: 'Remove {{title}} from the plugin directory?',
                  title: uninstallCandidate ? getMarketplaceEntryTitle(uninstallCandidate) : '',
                })}
              </p>
              <p className="text-xs text-default-500">
                {t(
                  'plugins.marketUninstallConfirmHint',
                  'This only removes the plugin code directory. Existing plugin data and stored state remain untouched.',
                )}
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setUninstallCandidate(null)}>
              {t('plugins.marketActionCancel', 'Cancel')}
            </Button>
            <Button
              color="danger"
              onPress={() => {
                if (!uninstallCandidate) {
                  return;
                }
                const item = buildMarketItemState(uninstallCandidate, channel, installedPluginsByName);
                void runPluginAction('uninstall', item);
              }}
              isLoading={Boolean(uninstallCandidate && pendingActionByPlugin[uninstallCandidate.name] === 'uninstall')}
            >
              {t('plugins.marketActionUninstall', 'Uninstall')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}

interface MarketplaceMetaProps {
  label: string;
  value: string;
}

const MarketplaceMeta: React.FC<MarketplaceMetaProps> = ({ label, value }) => (
  <div className="min-w-0">
    <div className="text-[11px] font-medium uppercase tracking-wider text-default-400">{label}</div>
    <div className="mt-1 text-sm text-default-700">{value}</div>
  </div>
);
