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
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import type {
  PluginMarketCatalogResponse,
  PluginMarketListing,
  PluginPermission,
  PluginStatus,
} from '@tx5dr/contracts';
import { UserRole } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import ReactMarkdown from 'react-markdown';
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

import {
  buildMarketItemState,
  compareSemverLike,
  getActionPriority,
  isPrimaryMarketItem,
  type MarketItemState,
} from './marketplaceItems';

const logger = createLogger('PluginMarketplace');

interface PluginMarketplaceProps {
  isActive: boolean;
  onOpenInstalledPlugin?: (pluginName: string) => void;
}

type PluginAction = 'install' | 'update' | 'uninstall';
function hasGlobalSettings(plugin?: PluginStatus): boolean {
  return Object.values(plugin?.settings ?? {}).some(
    (descriptor) => descriptor.type !== 'info' && (!descriptor.scope || descriptor.scope === 'global'),
  );
}

function getMarketplaceEntryTitle(entry: PluginMarketListing): string {
  return resolvePluginName(entry.name, entry.title);
}

function getMarketplaceEntryDescription(entry: PluginMarketListing): string {
  return resolvePluginDescription(entry.name, entry.description) ?? entry.description;
}

function registerMarketplaceCatalogLocales(entries: PluginMarketListing[]): void {
  for (const entry of entries) {
    registerPluginLocales(entry.name, entry.locales);
  }
}

function resolveMarketplaceMarkdownUrl(
  value: unknown,
  baseUrl?: string,
  options: { allowMailto?: boolean } = {},
): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const parsed = baseUrl
      ? new URL(value, baseUrl)
      : new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    if (options.allowMailto && parsed.protocol === 'mailto:') {
      return parsed.href;
    }
  } catch {
    return null;
  }

  return null;
}

function matchesSearch(item: MarketItemState, query: string): boolean {
  if (!query) return true;
  return [
    item.listing.name,
    getMarketplaceEntryTitle(item.listing),
    getMarketplaceEntryDescription(item.listing),
    ...item.listing.categories,
    ...item.listing.keywords,
  ].some((value) => value.toLowerCase().includes(query));
}

function sortMarketItems(items: MarketItemState[]): MarketItemState[] {
  return [...items].sort((left, right) => {
    const priority = getActionPriority(right) - getActionPriority(left);
    if (priority !== 0) {
      return priority;
    }
    return getMarketplaceEntryTitle(left.listing).localeCompare(getMarketplaceEntryTitle(right.listing));
  });
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

  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const [catalog, setCatalog] = useState<PluginMarketCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | undefined>();
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [pendingActionByPlugin, setPendingActionByPlugin] = useState<Partial<Record<string, PluginAction>>>({});
  const [pendingToggleByPlugin, setPendingToggleByPlugin] = useState<Record<string, boolean>>({});
  const [uninstallCandidate, setUninstallCandidate] = useState<PluginMarketListing | null>(null);
  const [downgradeCandidate, setDowngradeCandidate] = useState<MarketItemState | null>(null);
  const catalogLoadingRef = useRef(false);
  const catalogLoadedRef = useRef(false);

  const loadCatalog = useCallback(async (force = false) => {
    if (catalogLoadingRef.current || (!force && catalogLoadedRef.current)) {
      return;
    }

    catalogLoadingRef.current = true;
    setCatalogLoading(true);
    setCatalogError(null);

    try {
      const response = await api.getPluginMarketCatalog();
      registerMarketplaceCatalogLocales(response.plugins);
      catalogLoadedRef.current = true;
      setCatalog(response);
    } catch (err: unknown) {
      logger.error('Failed to load plugin marketplace catalog', err);
      setCatalogError(localizeError(err) || t('plugins.marketError', 'Failed to load marketplace catalog.'));
    } finally {
      catalogLoadingRef.current = false;
      setCatalogLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    void loadCatalog();
  }, [isActive, loadCatalog]);

  // Installing or removing a plugin changes the on-disk records that the Host
  // folds into the catalog, so refresh it after the plugin snapshot changes.
  const snapshotGeneration = pluginSnapshot.generation;
  useEffect(() => {
    if (!isActive || !catalogLoadedRef.current) {
      return;
    }
    void loadCatalog(true);
  }, [isActive, loadCatalog, snapshotGeneration]);

  const pluginApiVersion = catalog?.pluginApiVersion ?? '';
  const allItems = useMemo(
    () => (catalog?.plugins ?? []).map((listing) => buildMarketItemState(listing, installedPluginsByName)),
    [catalog, installedPluginsByName],
  );

  // Installed plugins always stay in the main list, even when unsupported.
  const { primaryItems, unsupportedItems } = useMemo(() => {
    const matching = allItems.filter((item) => matchesSearch(item, deferredSearch));
    return {
      primaryItems: sortMarketItems(matching.filter(isPrimaryMarketItem)),
      unsupportedItems: sortMarketItems(matching.filter((item) => !isPrimaryMarketItem(item))),
    };
  }, [allItems, currentLanguage, deferredSearch]);

  const visibleItems = showUnsupported ? [...primaryItems, ...unsupportedItems] : primaryItems;
  const visibleSelectedName = visibleItems.some((item) => item.listing.name === selectedName)
    ? selectedName
    : visibleItems[0]?.listing.name;
  const selectedItem = allItems.find((item) => item.listing.name === visibleSelectedName) ?? null;

  const isLoading = catalogLoading && !catalog;
  const loadError = catalogError;
  const listedCount = primaryItems.length + unsupportedItems.length;

  const runPluginAction = useCallback(async (action: PluginAction, item: MarketItemState) => {
    const { listing } = item;
    const entryTitle = getMarketplaceEntryTitle(listing);
    setPendingActionByPlugin((prev) => ({ ...prev, [listing.name]: action }));
    try {
      if (action === 'install' && item.target) {
        await api.installPluginFromMarket(listing.name, item.target.version);
        addToast({
          title: t('plugins.marketInstallSuccessTitle', 'Plugin installed'),
          description: t('plugins.marketInstallSuccessDescription', {
            defaultValue: '{{title}} {{version}} was installed.',
            title: entryTitle,
            version: item.target.version,
          }),
          color: 'success',
          timeout: 3500,
        });
      } else if (action === 'update' && item.target) {
        await api.updatePluginFromMarket(listing.name, item.target.version);
        addToast({
          title: t('plugins.marketUpdateSuccessTitle', 'Plugin updated'),
          description: t('plugins.marketUpdateSuccessDescription', {
            defaultValue: '{{title}} was replaced with {{version}}.',
            title: entryTitle,
            version: item.target.version,
          }),
          color: 'success',
          timeout: 3500,
        });
      } else if (action === 'uninstall') {
        await api.uninstallPluginFromMarket(listing.name);
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
      setDowngradeCandidate(null);
      await loadCatalog(true);
    } catch (err: unknown) {
      logger.error(`Plugin marketplace ${action} failed for ${listing.name}`, err);
      showErrorToast({
        userMessage: localizeError(err),
        severity: 'error',
      });
    } finally {
      setPendingActionByPlugin((prev) => {
        const next = { ...prev };
        delete next[listing.name];
        return next;
      });
    }
  }, [loadCatalog, t]);

  const requestReplacement = useCallback((item: MarketItemState) => {
    if (item.isDowngrade) {
      setDowngradeCandidate(item);
      return;
    }
    void runPluginAction('update', item);
  }, [runPluginAction]);

  const selectedPendingAction = selectedItem ? pendingActionByPlugin[selectedItem.listing.name] : undefined;
  const selectedTogglePending = selectedItem ? Boolean(pendingToggleByPlugin[selectedItem.listing.name]) : false;
  const selectedCanToggle = selectedItem?.installedPlugin?.type === 'utility';
  const selectedHasGlobalSettings = hasGlobalSettings(selectedItem?.installedPlugin);
  const selectedTitle = selectedItem ? getMarketplaceEntryTitle(selectedItem.listing) : '';
  const selectedDescription = selectedItem ? getMarketplaceEntryDescription(selectedItem.listing) : '';
  const selectedMarketActionNeedsWarning = Boolean(
    isAdmin
    && selectedItem
    && selectedItem.target
    && !selectedItem.isBuiltIn
    && (
      !selectedItem.isInstalled
      || (selectedItem.isMarketplaceManaged && (selectedItem.hasUpdate || selectedItem.needsCompatibleReplacement))
    ),
  );

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

  const renderListbox = (items: MarketItemState[], label: string) => (
    <Listbox
      aria-label={label}
      selectionMode="single"
      selectedKeys={visibleSelectedName ? new Set([visibleSelectedName]) : new Set()}
      onSelectionChange={(keys) => {
        if (keys === 'all') {
          return;
        }
        const key = Array.from(keys)[0];
        if (typeof key === 'string') {
          setSelectedName(key);
        }
      }}
      variant="flat"
      className="p-0"
      itemClasses={{
        base: 'rounded-none px-4 py-3 data-[hover=true]:bg-default-100 data-[selectable=true]:focus:bg-default-100 data-[selected=true]:bg-primary-50 data-[selected=true]:text-foreground',
        selectedIcon: 'hidden',
      }}
    >
      {items.map((item) => {
        const pendingAction = pendingActionByPlugin[item.listing.name];
        const itemTitle = getMarketplaceEntryTitle(item.listing);
        const itemDescription = getMarketplaceEntryDescription(item.listing);
        return (
          <ListboxItem
            key={item.listing.name}
            textValue={`${itemTitle} ${item.listing.name}`}
            endContent={(
              <div className="flex flex-col items-end gap-1 pl-3">
                <Chip size="sm" variant="flat" color={item.target ? 'secondary' : 'default'} className="text-[10px]">
                  {item.displayVersion.version}
                </Chip>
                {item.installedIncompatible && (
                  <Chip size="sm" variant="flat" color="danger" className="text-[10px]">
                    {t('plugins.marketUnsupportedChip', 'Incompatible')}
                  </Chip>
                )}
                {item.hasUpdate && (
                  <Chip size="sm" variant="flat" color="warning" className="text-[10px]">
                    {t('plugins.marketActionUpdate', 'Update')}
                  </Chip>
                )}
                {item.installedLegacy && (
                  <Chip size="sm" variant="flat" color="warning" className="text-[10px]">
                    {t('plugins.legacyPluginApi', 'Older Plugin API')}
                  </Chip>
                )}
                {item.isMarketplaceManaged && !item.hasUpdate && !item.installedIncompatible && (
                  <Chip size="sm" variant="flat" color="success" className="text-[10px]">
                    {t('plugins.marketInstalled', 'Installed')}
                  </Chip>
                )}
                {item.isManualInstall && (
                  <Chip size="sm" variant="flat" className="text-[10px]">
                    {t('plugins.marketInstalledManual', 'Installed manually')}
                  </Chip>
                )}
                {!item.isSupported && !item.isInstalled && (
                  <Chip size="sm" variant="flat" className="text-[10px]">
                    {t('plugins.marketUnsupportedChip', 'Incompatible')}
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
                <span>{item.listing.name}</span>
                <span>
                  {t('plugins.marketMinPluginApiVersionShort', 'Plugin API ^{{version}}', {
                    version: item.displayVersion.minPluginApiVersion,
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
              {item.listing.categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {item.listing.categories.slice(0, 2).map((category) => (
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
  );

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
              {pluginApiVersion && (
                <span className="text-xs text-default-400">
                  {t('plugins.marketHostPluginApi', 'This TX-5DR: Plugin API {{version}}', {
                    version: pluginApiVersion,
                  })}
                </span>
              )}
              <Button
                size="sm"
                variant="flat"
                className="lg:self-end"
                onPress={() => { void loadCatalog(true); }}
                isLoading={catalogLoading && Boolean(catalog)}
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
              <Button size="sm" color="danger" variant="flat" onPress={() => { void loadCatalog(true); }}>
                {t('plugins.marketRetry', 'Retry')}
              </Button>
            )}
          />
        )}

        {!isLoading && !loadError && catalog && allItems.length === 0 && (
          <div className="rounded-large border border-dashed border-divider bg-content1 px-4 py-10 text-center text-sm text-default-400">
            {t('plugins.marketEmpty', 'No marketplace plugins are available.')}
          </div>
        )}

        {!isLoading && !loadError && allItems.length > 0 && (
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
              {listedCount === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-default-400">
                  {t('plugins.marketNoResults', 'No marketplace plugins match the current search.')}
                </div>
              ) : (
                <ScrollShadow className="max-h-[58vh] lg:max-h-[72vh]">
                  {primaryItems.length > 0 && renderListbox(primaryItems, t('plugins.viewMarketplace', 'Marketplace'))}
                  {unsupportedItems.length > 0 && (
                    <>
                      <Divider />
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-default-100"
                        aria-expanded={showUnsupported}
                        onClick={() => setShowUnsupported((value) => !value)}
                      >
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-default-600">
                            {t('plugins.marketUnsupportedGroup', 'Incompatible with this TX-5DR ({{count}})', {
                              count: unsupportedItems.length,
                            })}
                          </span>
                          <span className="block text-[11px] text-default-400">
                            {t('plugins.marketUnsupportedGroupHint', 'No version supports Plugin API {{version}}.', {
                              version: pluginApiVersion,
                            })}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-primary">
                          {showUnsupported
                            ? t('plugins.marketCollapse', 'Collapse')
                            : t('plugins.marketExpand', 'Expand')}
                        </span>
                      </button>
                      {showUnsupported && renderListbox(
                        unsupportedItems,
                        t('plugins.marketUnsupportedGroup', 'Incompatible with this TX-5DR ({{count}})', {
                          count: unsupportedItems.length,
                        }),
                      )}
                    </>
                  )}
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
                          <Chip size="sm" variant="flat" color={selectedItem.target ? 'secondary' : 'default'} className="text-xs">
                            {selectedItem.displayVersion.version}
                          </Chip>
                          {selectedItem.isMarketplaceManaged && !selectedItem.hasUpdate && !selectedItem.installedIncompatible && (
                            <Chip size="sm" variant="flat" color="success" className="text-xs">
                              {t('plugins.marketInstalled', 'Installed')}
                            </Chip>
                          )}
                          {selectedItem.hasUpdate && (
                            <Chip size="sm" variant="flat" color="warning" className="text-xs">
                              {t('plugins.marketUpdateAvailable', 'Update available')}
                            </Chip>
                          )}
                          {(selectedItem.installedIncompatible || (!selectedItem.isSupported && !selectedItem.isInstalled)) && (
                            <Chip size="sm" variant="flat" color="danger" className="text-xs">
                              {t('plugins.marketUnsupportedChip', 'Incompatible')}
                            </Chip>
                          )}
                          {selectedItem.isManualInstall && (
                            <Chip size="sm" variant="flat" className="text-xs">
                              {t('plugins.marketInstalledManual', 'Installed manually')}
                            </Chip>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-default-400">{selectedItem.listing.name}</p>
                      </div>
                    </div>

                    <p className="text-sm leading-7 text-default-600">{selectedDescription}</p>

                    <div className="flex flex-wrap items-center gap-2">
                      {selectedItem.isMarketplaceManaged && (
                        <Chip size="sm" variant="flat" color="success" className="text-xs">
                          {t('plugins.marketManagedByMarketplace', 'Managed by marketplace')}
                        </Chip>
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

                    {selectedItem.installedIncompatible && (
                      <Alert
                        color="danger"
                        variant="flat"
                        title={t('plugins.marketInstalledIncompatibleTitle', 'Installed version is incompatible')}
                        description={[
                          t('plugins.marketInstalledIncompatibleDescription', {
                            defaultValue: 'The installed {{installed}} does not support Plugin API {{current}}, so TX-5DR did not load it.',
                            installed: selectedItem.installedVersion,
                            current: pluginApiVersion,
                          }),
                          selectedItem.target
                            ? t('plugins.marketInstalledIncompatibleReplaceHint', {
                              defaultValue: 'A compatible version {{version}} is available.',
                              version: selectedItem.target.version,
                            })
                            : '',
                        ].filter(Boolean).join(' ')}
                      />
                    )}

                    {selectedItem.installedLegacy && (
                      <Alert
                        color="warning"
                        variant="flat"
                        title={t('plugins.legacyPluginApi', 'Older Plugin API')}
                        description={[
                          t('plugins.marketInstalledLegacyDescription', {
                            defaultValue: 'The installed {{installed}} was built for an older Plugin API. It still runs on this TX-5DR, but may misbehave.',
                            installed: selectedItem.installedVersion,
                          }),
                          selectedItem.hasUpdate && selectedItem.target
                            ? t('plugins.marketInstalledLegacyUpdateHint', {
                              defaultValue: 'Update to {{version}}, which targets this Plugin API.',
                              version: selectedItem.target.version,
                            })
                            : t('plugins.marketInstalledLegacyNoUpdateHint', 'No updated version is available yet; ask the plugin author for one.'),
                        ].join(' ')}
                      />
                    )}

                    {!selectedItem.target && selectedItem.listing.availability === 'host-upgrade-required' && (
                      <Alert
                        color="warning"
                        variant="flat"
                        title={t('plugins.marketHostUpgradeRequiredTitle', 'TX-5DR update required')}
                        description={t('plugins.marketHostUpgradeRequiredDescription', {
                          defaultValue: 'This plugin requires Plugin API ^{{required}}. This TX-5DR bundles {{current}}. Update TX-5DR to install it.',
                          required: selectedItem.listing.latest.minPluginApiVersion,
                          current: pluginApiVersion,
                        })}
                      />
                    )}

                    {!selectedItem.target && selectedItem.listing.availability === 'plugin-outdated' && (
                      <Alert
                        color="default"
                        variant="flat"
                        title={t('plugins.marketPluginOutdatedTitle', 'Not yet updated for this TX-5DR')}
                        description={t('plugins.marketPluginOutdatedDescription', {
                          defaultValue: 'This plugin only provides versions for Plugin API ^{{required}}. This TX-5DR bundles {{current}}. Updating TX-5DR will not help; wait for the plugin author to publish a compatible version.',
                          required: selectedItem.listing.latest.minPluginApiVersion,
                          current: pluginApiVersion,
                        })}
                      />
                    )}

                    {selectedItem.newerNeedsHostUpgrade && (
                      <Alert
                        color="primary"
                        variant="flat"
                        title={t('plugins.marketNewerVersionTitle', 'A newer version is available')}
                        description={t('plugins.marketNewerNeedsHostUpgrade', {
                          defaultValue: 'Version {{version}} requires Plugin API ^{{required}}. It becomes available after updating TX-5DR.',
                          version: selectedItem.listing.latest.version,
                          required: selectedItem.listing.latest.minPluginApiVersion,
                        })}
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
                      <div className="flex flex-col gap-3">
                        {selectedMarketActionNeedsWarning && (
                          <MarketplaceInstallRiskNotice repository={selectedItem.listing.repository} />
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          {!selectedItem.isInstalled && !selectedItem.isBuiltIn && selectedItem.target && (
                            <Button
                              color="primary"
                              onPress={() => { void runPluginAction('install', selectedItem); }}
                              isLoading={selectedPendingAction === 'install'}
                            >
                              {t('plugins.marketActionInstallVersion', 'Install {{version}}', {
                                version: selectedItem.target.version,
                              })}
                            </Button>
                          )}

                          {selectedItem.hasUpdate && selectedItem.target && (
                            <Button
                              color="primary"
                              onPress={() => { void runPluginAction('update', selectedItem); }}
                              isLoading={selectedPendingAction === 'update'}
                            >
                              {t('plugins.marketActionUpdateVersion', 'Update to {{version}}', {
                                version: selectedItem.target.version,
                              })}
                            </Button>
                          )}

                          {selectedItem.needsCompatibleReplacement && selectedItem.target && (
                            <Button
                              color="primary"
                              onPress={() => requestReplacement(selectedItem)}
                              isLoading={selectedPendingAction === 'update'}
                            >
                              {t('plugins.marketActionInstallCompatible', 'Install compatible {{version}}', {
                                version: selectedItem.target.version,
                              })}
                            </Button>
                          )}

                          {selectedItem.isMarketplaceManaged && (
                            <Button
                              color="danger"
                              variant="flat"
                              onPress={() => setUninstallCandidate(selectedItem.listing)}
                              isDisabled={Boolean(selectedPendingAction)}
                            >
                              {t('plugins.marketActionUninstall', 'Uninstall')}
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    {selectedItem.installedPlugin && (
                      <Button
                        variant="flat"
                        onPress={() => onOpenInstalledPlugin?.(selectedItem.listing.name)}
                      >
                        {t('plugins.marketActionOpenInstalled', 'Go to Installed')}
                      </Button>
                    )}

                    {selectedItem.installedPlugin && selectedCanToggle && (
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
                        label={t('plugins.marketTargetVersion', 'Version for this TX-5DR')}
                        value={selectedItem.target?.version ?? t('plugins.marketNoCompatibleVersion', 'None')}
                      />
                      <MarketplaceMeta
                        label={t('plugins.marketMinPluginApiVersion', 'Plugin API requirement')}
                        value={`^${selectedItem.displayVersion.minPluginApiVersion}`}
                      />
                      {pluginApiVersion && (
                        <MarketplaceMeta
                          label={t('plugins.marketCurrentPluginApiVersion', 'Bundled Plugin API version')}
                          value={pluginApiVersion}
                        />
                      )}
                      <MarketplaceMeta
                        label={t('plugins.marketPublishedAt', 'Published at')}
                        value={formatDateTime(selectedItem.displayVersion.publishedAt)}
                      />
                      {selectedItem.listing.author && (
                        <MarketplaceMeta
                          label={t('plugins.marketAuthor', 'Author')}
                          value={selectedItem.listing.author}
                        />
                      )}
                      {selectedItem.listing.license && (
                        <MarketplaceMeta
                          label={t('plugins.marketLicense', 'License')}
                          value={selectedItem.listing.license}
                        />
                      )}
                      <MarketplaceMeta
                        label={t('plugins.marketPackageSize', 'Package size')}
                        value={t('plugins.marketPackageSizeValue', '{{value}} KB', {
                          value: (selectedItem.displayVersion.size / 1024)
                            .toFixed(selectedItem.displayVersion.size >= 1024 * 100 ? 0 : 1),
                        })}
                      />
                    </div>

                    {selectedItem.listing.categories.length > 0 && (
                      <>
                        <Divider />
                        <section className="flex flex-col gap-2">
                          <span className="text-xs font-medium uppercase tracking-wider text-default-400">
                            {t('plugins.marketCategories', 'Categories')}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {selectedItem.listing.categories.map((category) => (
                              <Chip key={category} size="sm" variant="flat" className="text-xs">
                                {category}
                              </Chip>
                            ))}
                          </div>
                        </section>
                      </>
                    )}

                    {selectedItem.listing.keywords.length > 0 && (
                      <>
                        <Divider />
                        <section className="flex flex-col gap-2">
                          <span className="text-xs font-medium uppercase tracking-wider text-default-400">
                            {t('plugins.marketKeywords', 'Keywords')}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            {selectedItem.listing.keywords.map((keyword) => (
                              <Chip key={keyword} size="sm" variant="flat" className="text-xs">
                                {keyword}
                              </Chip>
                            ))}
                          </div>
                        </section>
                      </>
                    )}

                    <Divider />
                    <MarketplacePermissionRiskSection permissions={selectedItem.displayVersion.permissions} />

                    <Divider />
                    <MarketplaceVersionHistory item={selectedItem} />

                    {selectedItem.listing.readmeMarkdown && (
                      <>
                        <Divider />
                        <MarketplaceReadmeSection
                          markdown={selectedItem.listing.readmeMarkdown}
                          sourceUrl={selectedItem.listing.readmeSourceUrl}
                        />
                      </>
                    )}

                    <Divider />

                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <a
                        href={selectedItem.displayVersion.artifactUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                      >
                        {t('plugins.marketDownloadArtifact', 'Artifact')}
                      </a>
                      {selectedItem.listing.repository && (
                        <a
                          href={selectedItem.listing.repository}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                        >
                          {t('plugins.marketRepository', 'Repository')}
                        </a>
                      )}
                      {selectedItem.listing.homepage && (
                        <a
                          href={selectedItem.listing.homepage}
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

      <Modal isOpen={Boolean(uninstallCandidate)} onClose={() => setUninstallCandidate(null)} size="sm"
        placement="center"
        scrollBehavior="inside"
      >
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
                const item = buildMarketItemState(uninstallCandidate, installedPluginsByName);
                void runPluginAction('uninstall', item);
              }}
              isLoading={Boolean(uninstallCandidate && pendingActionByPlugin[uninstallCandidate.name] === 'uninstall')}
            >
              {t('plugins.marketActionUninstall', 'Uninstall')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={Boolean(downgradeCandidate)} onClose={() => setDowngradeCandidate(null)} size="sm"
        placement="center"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader>
            {t('plugins.marketDowngradeConfirmTitle', 'Install an older compatible version')}
          </ModalHeader>
          <ModalBody>
            <div className="space-y-3 text-sm text-default-600">
              <p>
                {t('plugins.marketDowngradeConfirmBody', {
                  defaultValue: 'Replace {{title}} {{installed}} with the older version {{version}}?',
                  title: downgradeCandidate ? getMarketplaceEntryTitle(downgradeCandidate.listing) : '',
                  installed: downgradeCandidate?.installedVersion ?? '',
                  version: downgradeCandidate?.target?.version ?? '',
                })}
              </p>
              <p className="text-xs text-default-500">
                {t(
                  'plugins.marketDowngradeConfirmHint',
                  'An older version may not read settings or data written by the newer one. Plugin data is kept, not deleted; back it up first if it matters.',
                )}
              </p>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setDowngradeCandidate(null)}>
              {t('plugins.marketActionCancel', 'Cancel')}
            </Button>
            <Button
              color="warning"
              onPress={() => {
                if (downgradeCandidate) {
                  void runPluginAction('update', downgradeCandidate);
                }
              }}
              isLoading={Boolean(downgradeCandidate && pendingActionByPlugin[downgradeCandidate.listing.name] === 'update')}
            >
              {t('plugins.marketDowngradeConfirmAction', 'Install older version')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}

const MarketplaceVersionHistory: React.FC<{ item: MarketItemState }> = ({ item }) => {
  const { t } = useTranslation('settings');
  const versions = [...item.listing.versions].sort((left, right) => compareSemverLike(right.version, left.version));
  return (
    <section className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wider text-default-400">
        {t('plugins.marketVersionHistory', 'Version history')}
      </span>
      <div className="flex flex-col divide-y divide-divider rounded-medium border border-divider">
        {versions.map((entry) => (
          <div key={entry.version} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
            <span className={`font-medium ${entry.yanked ? 'text-default-400 line-through' : 'text-default-700'}`}>
              {entry.version}
            </span>
            <span className="text-default-500">
              {t('plugins.marketMinPluginApiVersionShort', 'Plugin API ^{{version}}', {
                version: entry.minPluginApiVersion,
              })}
            </span>
            <span className="text-default-400">{formatDateTime(entry.publishedAt)}</span>
            {item.target?.version === entry.version && (
              <Chip size="sm" variant="flat" color="secondary" className="h-5 text-[10px]">
                {t('plugins.marketVersionForThisHost', 'For this TX-5DR')}
              </Chip>
            )}
            {item.installedVersion === entry.version && (
              <Chip size="sm" variant="flat" color="success" className="h-5 text-[10px]">
                {t('plugins.marketInstalled', 'Installed')}
              </Chip>
            )}
            {entry.yanked && (
              <Chip size="sm" variant="flat" color="danger" className="h-5 text-[10px]">
                {t('plugins.marketVersionYanked', 'Withdrawn')}
              </Chip>
            )}
          </div>
        ))}
      </div>
    </section>
  );
};

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

function getPermissionI18nKey(permission: PluginPermission): string {
  return permission.replace(':', '.');
}

const MarketplaceInstallRiskNotice: React.FC<{ repository?: string }> = ({ repository }) => {
  const { t } = useTranslation('settings');
  return (
    <Alert
      color="warning"
      variant="flat"
      title={t('plugins.marketInstallRiskTitle', 'Review before installing')}
      description={(
        <span>
          {t(
            'plugins.marketInstallRiskDescription',
            'Marketplace plugins run as local TX-5DR plugin code. Official listings are reviewed and open to community inspection, but you should still inspect the source before installing or updating.',
          )}
          {repository && (
            <>
              {' '}
              <a
                href={repository}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-warning-700 underline underline-offset-2 hover:text-warning-800"
              >
                {t('plugins.marketReviewSourceLink', 'Review source')}
              </a>
            </>
          )}
        </span>
      )}
    />
  );
};

const MarketplacePermissionRiskSection: React.FC<{ permissions: PluginPermission[] }> = ({ permissions }) => {
  const { t } = useTranslation('settings');
  if (permissions.length === 0) {
    return (
      <section className="rounded-large border border-default-200 bg-default-50 px-4 py-3">
        <div className="text-xs font-medium uppercase tracking-wider text-default-400">
          {t('plugins.marketPermissions', 'Requested permissions')}
        </div>
        <div className="mt-2 text-sm font-medium text-default-700">
          {t('plugins.marketNoSensitivePermissionsTitle', 'No sensitive permissions requested')}
        </div>
        <p className="mt-1 text-xs leading-5 text-default-500">
          {t(
            'plugins.marketNoSensitivePermissionsDescription',
            'This plugin does not declare access to network, radio control, host dependencies, or host settings APIs.',
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-large border border-warning-200 bg-warning-50/60 px-4 py-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-medium uppercase tracking-wider text-warning-700">
            {t('plugins.marketPermissions', 'Requested permissions')}
          </div>
          <p className="mt-1 text-sm leading-6 text-warning-800">
            {t(
              'plugins.marketPermissionRiskSummary',
              'These permissions unlock sensitive host APIs. Install only if the capability matches the plugin purpose.',
            )}
          </p>
        </div>
        <Chip size="sm" variant="flat" color="warning" className="shrink-0 text-xs">
          {t('plugins.marketPermissionCount', '{{count}} permissions', { count: permissions.length })}
        </Chip>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {permissions.map((permission) => {
          const key = getPermissionI18nKey(permission);
          return (
            <div
              key={permission}
              className="rounded-medium border border-warning-200/80 bg-content1/80 px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-default-800">
                  {t(`plugins.permission.${key}.name`, permission)}
                </span>
                <code className="rounded bg-warning-100 px-1.5 py-0.5 text-[11px] text-warning-800">
                  {permission}
                </code>
              </div>
              <p className="mt-2 text-xs leading-5 text-default-600">
                {t(`plugins.permission.${key}.description`, permission)}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const MarketplaceReadmeSection: React.FC<{ markdown: string; sourceUrl?: string }> = ({ markdown, sourceUrl }) => {
  const { t } = useTranslation('settings');
  const safeSourceUrl = resolveMarketplaceMarkdownUrl(sourceUrl);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-default-400">
          {t('plugins.marketReadme', 'README')}
        </span>
        {safeSourceUrl && (
          <a
            href={safeSourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline"
          >
            {t('plugins.marketReadmeSource', 'View README source')}
          </a>
        )}
      </div>
      <div className="prose prose-sm dark:prose-invert max-w-none rounded-large border border-divider bg-content2/40 px-4 py-4 text-default-700
                      prose-headings:scroll-mt-20 prose-headings:text-default-800 prose-p:leading-7 prose-a:text-primary prose-code:text-default-800
                      prose-pre:max-w-full prose-pre:overflow-x-auto prose-img:my-3 prose-img:max-h-80 prose-img:rounded-large prose-img:border prose-img:border-divider">
        <ReactMarkdown
          components={{
            a: ({ href, children }) => {
              const safeHref = resolveMarketplaceMarkdownUrl(href, sourceUrl, { allowMailto: true });
              if (!safeHref) {
                return <span>{children}</span>;
              }
              return (
                <a href={safeHref} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
            img: ({ src, alt }) => {
              const safeSrc = resolveMarketplaceMarkdownUrl(src, sourceUrl, { allowMailto: false });
              if (!safeSrc) {
                return null;
              }
              return <img src={safeSrc} alt={alt ?? ''} loading="lazy" />;
            },
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </section>
  );
};
