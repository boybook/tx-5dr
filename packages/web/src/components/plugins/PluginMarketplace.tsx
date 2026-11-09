import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Input,
  Listbox,
  ListboxItem,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
  Switch,
  Tooltip,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faChevronDown,
  faChevronUp,
  faCircleInfo,
  faMagnifyingGlass,
  faRotate,
  faShieldHalved,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
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
  getMarketItemStatus,
  isPrimaryMarketItem,
  type MarketItemState,
  type MarketItemStatus,
} from './marketplaceItems';

const logger = createLogger('PluginMarketplace');

interface PluginMarketplaceProps {
  isActive: boolean;
  onOpenInstalledPlugin?: (pluginName: string) => void;
}

type PluginAction = 'install' | 'update' | 'uninstall';
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

  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    detailScrollRef.current?.scrollTo({ top: 0 });
  }, [visibleSelectedName]);

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
      classNames={{ base: 'w-full min-w-0 p-0', list: 'min-w-0 gap-0' }}
      itemClasses={{
        base: 'w-full min-w-0 rounded-none px-3 py-2 data-[hover=true]:bg-default-100 data-[selectable=true]:focus:bg-default-100 data-[selected=true]:bg-primary-50 data-[selected=true]:text-foreground',
        wrapper: 'w-full min-w-0',
        title: 'w-full min-w-0 whitespace-normal',
        selectedIcon: 'hidden',
      }}
    >
      {items.map((item) => {
        const pendingAction = pendingActionByPlugin[item.listing.name];
        const itemTitle = getMarketplaceEntryTitle(item.listing);
        return (
          <ListboxItem key={item.listing.name} textValue={`${itemTitle} ${item.listing.name}`}>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-default-800">{itemTitle}</span>
                {pendingAction
                  ? <Spinner size="sm" className="shrink-0" />
                  : <MarketplaceStatusChip item={item} compact />}
              </div>
              <p className="line-clamp-2 break-words text-xs leading-[18px] text-default-500">
                {getMarketplaceEntryDescription(item.listing)}
              </p>
            </div>
          </ListboxItem>
        );
      })}
    </Listbox>
  );

  const renderDetail = (item: MarketItemState) => {
    const { listing } = item;
    const repositoryUrl = resolveMarketplaceMarkdownUrl(listing.repository);
    const homepageUrl = resolveMarketplaceMarkdownUrl(listing.homepage);
    const canInstall = !item.isInstalled && !item.isBuiltIn && Boolean(item.target);
    return (
      <div className="flex flex-col gap-5 px-5 py-4">
        <header className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h4 className="text-lg font-semibold leading-7 text-default-900">{selectedTitle}</h4>
                <span className="text-sm text-default-400">{item.displayVersion.version}</span>
                <MarketplaceStatusChip item={item} />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-default-400">
                <span>{listing.name}</span>
                {listing.author && <span>{listing.author}</span>}
                {repositoryUrl && (
                  <MarketplaceExternalLink href={repositoryUrl}>
                    {t('plugins.marketRepository', 'Repository')}
                  </MarketplaceExternalLink>
                )}
                {homepageUrl && (
                  <MarketplaceExternalLink href={homepageUrl}>
                    {t('plugins.marketHomepage', 'Homepage')}
                  </MarketplaceExternalLink>
                )}
              </div>
            </div>

            {isAdmin && (
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {canInstall && item.target && (
                  <Button
                    size="sm"
                    color="primary"
                    onPress={() => { void runPluginAction('install', item); }}
                    isLoading={selectedPendingAction === 'install'}
                  >
                    {t('plugins.marketActionInstallVersion', 'Install {{version}}', { version: item.target.version })}
                  </Button>
                )}
                {item.hasUpdate && item.target && (
                  <Button
                    size="sm"
                    color="primary"
                    onPress={() => { void runPluginAction('update', item); }}
                    isLoading={selectedPendingAction === 'update'}
                  >
                    {t('plugins.marketActionUpdateVersion', 'Update to {{version}}', { version: item.target.version })}
                  </Button>
                )}
                {item.needsCompatibleReplacement && item.target && (
                  <Button
                    size="sm"
                    color="primary"
                    onPress={() => requestReplacement(item)}
                    isLoading={selectedPendingAction === 'update'}
                  >
                    {t('plugins.marketActionInstallCompatible', 'Install compatible {{version}}', {
                      version: item.target.version,
                    })}
                  </Button>
                )}
                {item.isMarketplaceManaged && (
                  <Button
                    size="sm"
                    color="danger"
                    variant="light"
                    onPress={() => setUninstallCandidate(listing)}
                    isDisabled={Boolean(selectedPendingAction)}
                  >
                    {t('plugins.marketActionUninstall', 'Uninstall')}
                  </Button>
                )}
              </div>
            )}
          </div>

          <p className="text-sm leading-6 text-default-600">{selectedDescription}</p>

          {item.installedPlugin && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              {selectedCanToggle && (
                <Switch
                  size="sm"
                  isSelected={item.installedPlugin.enabled}
                  isDisabled={!isAdmin || selectedTogglePending}
                  onValueChange={(value) => { void handleToggleEnabled(item.installedPlugin!, value); }}
                >
                  <span className="text-sm text-default-700">
                    {t('plugins.marketEnableInlineTitle', 'Enable this plugin')}
                  </span>
                </Switch>
              )}
              <Button
                size="sm"
                variant="light"
                color="primary"
                className="px-2"
                onPress={() => onOpenInstalledPlugin?.(listing.name)}
              >
                {t('plugins.marketActionOpenInstalled', 'Go to Installed')}
              </Button>
            </div>
          )}

          {selectedMarketActionNeedsWarning && (
            <p className="flex gap-2 text-xs leading-5 text-default-500">
              <FontAwesomeIcon icon={faShieldHalved} className="mt-1 shrink-0 text-warning" />
              <span>
                {t(
                  'plugins.marketInstallRiskDescription',
                  'Marketplace plugins run as local TX-5DR plugin code. Official listings are reviewed and open to community inspection, but you should still inspect the source before installing or updating.',
                )}
                {repositoryUrl && (
                  <>
                    {' '}
                    <a href={repositoryUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {t('plugins.marketReviewSourceLink', 'Review source')}
                    </a>
                  </>
                )}
              </span>
            </p>
          )}
        </header>

        <MarketplaceNotices item={item} pluginApiVersion={pluginApiVersion} isAdmin={isAdmin} />

        {item.displayVersion.permissions.length > 0 && (
          <MarketplacePermissionSection permissions={item.displayVersion.permissions} />
        )}

        {listing.readmeMarkdown && (
          <MarketplaceReadmeSection markdown={listing.readmeMarkdown} sourceUrl={listing.readmeSourceUrl} />
        )}

        <MarketplaceDetailsSection item={item} />
        <MarketplaceVersionHistory item={item} />
      </div>
    );
  };

  const ready = !isLoading && !loadError && allItems.length > 0;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {isLoading && (
          <div className="flex flex-1 items-center justify-center py-12">
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
          <div className="rounded-large border border-dashed border-divider px-4 py-10 text-center text-sm text-default-400">
            {t('plugins.marketEmpty', 'No marketplace plugins are available.')}
          </div>
        )}

        {ready && (
          <div className="grid min-h-0 flex-1 overflow-hidden rounded-large border border-divider bg-content1 max-lg:grid-rows-[minmax(0,40%)_minmax(0,1fr)] lg:grid-cols-[272px_minmax(0,1fr)]">
            <aside className="flex min-h-0 flex-col border-divider max-lg:border-b lg:border-r">
              <div className="flex shrink-0 items-center gap-1 p-2">
                <Input
                  size="sm"
                  variant="flat"
                  isClearable
                  value={search}
                  onValueChange={setSearch}
                  onClear={() => setSearch('')}
                  aria-label={t('plugins.marketSearchPlaceholder', 'Search by title, description, category, or keyword')}
                  placeholder={t('plugins.marketSearchShort', 'Search plugins')}
                  startContent={<FontAwesomeIcon icon={faMagnifyingGlass} className="text-xs text-default-400" />}
                />
                <Tooltip content={t('plugins.marketRefresh', 'Refresh')}>
                  <Button
                    size="sm"
                    variant="light"
                    isIconOnly
                    aria-label={t('plugins.marketRefresh', 'Refresh')}
                    onPress={() => { void loadCatalog(true); }}
                    isLoading={catalogLoading && Boolean(catalog)}
                  >
                    <FontAwesomeIcon icon={faRotate} className="text-default-500" />
                  </Button>
                </Tooltip>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {listedCount === 0 ? (
                  <div className="px-4 py-10 text-center text-xs text-default-400">
                    {t('plugins.marketNoResults', 'No marketplace plugins match the current search.')}
                  </div>
                ) : (
                  <>
                    {primaryItems.length > 0 && renderListbox(primaryItems, t('plugins.viewMarketplace', 'Marketplace'))}
                    {unsupportedItems.length > 0 && (
                      <>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-2 border-t border-divider px-3 py-2 text-left text-xs text-default-500 hover:bg-default-100"
                          aria-expanded={showUnsupported}
                          title={t('plugins.marketUnsupportedGroupHint', 'No version supports Plugin API {{version}}.', {
                            version: pluginApiVersion,
                          })}
                          onClick={() => setShowUnsupported((value) => !value)}
                        >
                          <span className="min-w-0 truncate">
                            {t('plugins.marketUnsupportedGroup', 'Incompatible with this TX-5DR ({{count}})', {
                              count: unsupportedItems.length,
                            })}
                          </span>
                          <FontAwesomeIcon icon={showUnsupported ? faChevronUp : faChevronDown} className="shrink-0 text-[10px]" />
                        </button>
                        {showUnsupported && renderListbox(
                          unsupportedItems,
                          t('plugins.marketUnsupportedGroup', 'Incompatible with this TX-5DR ({{count}})', {
                            count: unsupportedItems.length,
                          }),
                        )}
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-divider px-3 py-1.5 text-[11px] text-default-400">
                <span>{t('plugins.marketCount', '{{count}} listed', { count: listedCount })}</span>
                {pluginApiVersion && (
                  <span className="truncate">Plugin API {pluginApiVersion}</span>
                )}
              </div>
            </aside>

            <section ref={detailScrollRef} className="min-h-0 overflow-y-auto">
              {selectedItem ? renderDetail(selectedItem) : (
                <div className="px-5 py-12 text-center text-sm text-default-400">
                  {t('plugins.marketNoResults', 'No marketplace plugins match the current search.')}
                </div>
              )}
            </section>
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

const MarketplaceSectionTitle: React.FC<{ children: React.ReactNode; end?: React.ReactNode }> = ({ children, end }) => (
  <div className="mb-2 flex items-center justify-between gap-2">
    <h5 className="text-xs font-semibold text-default-500">{children}</h5>
    {end}
  </div>
);

const MarketplaceExternalLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
    {children}
    <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="text-[9px]" />
  </a>
);

const STATUS_CHIP: Record<NonNullable<MarketItemStatus>, {
  color: 'default' | 'success' | 'warning' | 'danger';
  labelKey: string;
  fallback: string;
}> = {
  incompatible: { color: 'danger', labelKey: 'plugins.marketUnsupportedChip', fallback: 'Incompatible' },
  update: { color: 'warning', labelKey: 'plugins.marketUpdateAvailable', fallback: 'Update available' },
  legacy: { color: 'warning', labelKey: 'plugins.legacyPluginApi', fallback: 'Older Plugin API' },
  installed: { color: 'success', labelKey: 'plugins.marketInstalled', fallback: 'Installed' },
  manual: { color: 'default', labelKey: 'plugins.marketInstalledManual', fallback: 'Installed manually' },
  unsupported: { color: 'default', labelKey: 'plugins.marketUnsupportedChip', fallback: 'Incompatible' },
};

/** One status per plugin; the list shows the version instead when there is nothing to report. */
const MarketplaceStatusChip: React.FC<{ item: MarketItemState; compact?: boolean }> = ({ item, compact }) => {
  const { t } = useTranslation('settings');
  const status = getMarketItemStatus(item);
  if (!status) {
    return compact
      ? <span className="shrink-0 text-[11px] text-default-400">{item.displayVersion.version}</span>
      : null;
  }
  const style = STATUS_CHIP[status];
  return (
    <Chip
      size="sm"
      variant="flat"
      color={style.color}
      className={compact ? 'h-5 shrink-0 text-[10px]' : 'h-6 text-xs'}
    >
      {t(style.labelKey, style.fallback)}
    </Chip>
  );
};

const NOTICE_STYLE = {
  danger: { className: 'bg-danger-50 text-danger-700', icon: faTriangleExclamation },
  warning: { className: 'bg-warning-50 text-warning-700', icon: faTriangleExclamation },
  primary: { className: 'bg-primary-50 text-primary-700', icon: faCircleInfo },
  default: { className: 'bg-default-100 text-default-600', icon: faCircleInfo },
} as const;

const MarketplaceNotice: React.FC<{
  color: keyof typeof NOTICE_STYLE;
  title: string;
  children: React.ReactNode;
}> = ({ color, title, children }) => {
  const style = NOTICE_STYLE[color];
  return (
    <div className={`flex gap-2 rounded-medium px-3 py-2 text-xs leading-5 ${style.className}`}>
      <FontAwesomeIcon icon={style.icon} className="mt-1 shrink-0" />
      <p>
        <span className="font-semibold">{title}</span>
        {' '}
        {children}
      </p>
    </div>
  );
};

/** Only states that change what the user can or should do here. */
const MarketplaceNotices: React.FC<{
  item: MarketItemState;
  pluginApiVersion: string;
  isAdmin: boolean;
}> = ({ item, pluginApiVersion, isAdmin }) => {
  const { t } = useTranslation('settings');
  const notices: React.ReactNode[] = [];

  if (item.installedIncompatible) {
    notices.push(
      <MarketplaceNotice key="incompatible" color="danger" title={t('plugins.marketInstalledIncompatibleTitle', 'Installed version is incompatible')}>
        {[
          t('plugins.marketInstalledIncompatibleDescription', {
            defaultValue: 'The installed {{installed}} does not support Plugin API {{current}}, so TX-5DR did not load it.',
            installed: item.installedVersion,
            current: pluginApiVersion,
          }),
          item.target
            ? t('plugins.marketInstalledIncompatibleReplaceHint', {
              defaultValue: 'A compatible version {{version}} is available.',
              version: item.target.version,
            })
            : '',
        ].filter(Boolean).join(' ')}
      </MarketplaceNotice>,
    );
  }
  if (item.installedLegacy) {
    notices.push(
      <MarketplaceNotice key="legacy" color="warning" title={t('plugins.legacyPluginApi', 'Older Plugin API')}>
        {[
          t('plugins.marketInstalledLegacyDescription', {
            defaultValue: 'The installed {{installed}} was built for an older Plugin API. It still runs on this TX-5DR, but may misbehave.',
            installed: item.installedVersion,
          }),
          item.hasUpdate && item.target
            ? t('plugins.marketInstalledLegacyUpdateHint', {
              defaultValue: 'Update to {{version}}, which targets this Plugin API.',
              version: item.target.version,
            })
            : t('plugins.marketInstalledLegacyNoUpdateHint', 'No updated version is available yet; ask the plugin author for one.'),
        ].join(' ')}
      </MarketplaceNotice>,
    );
  }
  if (!item.target && item.listing.availability === 'host-upgrade-required') {
    notices.push(
      <MarketplaceNotice key="host-upgrade" color="warning" title={t('plugins.marketHostUpgradeRequiredTitle', 'TX-5DR update required')}>
        {t('plugins.marketHostUpgradeRequiredDescription', {
          defaultValue: 'This plugin requires Plugin API ^{{required}}. This TX-5DR bundles {{current}}. Update TX-5DR to install it.',
          required: item.listing.latest.minPluginApiVersion,
          current: pluginApiVersion,
        })}
      </MarketplaceNotice>,
    );
  }
  if (!item.target && item.listing.availability === 'plugin-outdated') {
    notices.push(
      <MarketplaceNotice key="outdated" color="default" title={t('plugins.marketPluginOutdatedTitle', 'Not yet updated for this TX-5DR')}>
        {t('plugins.marketPluginOutdatedDescription', {
          defaultValue: 'This plugin only provides versions for Plugin API ^{{required}}. This TX-5DR bundles {{current}}. Updating TX-5DR will not help; wait for the plugin author to publish a compatible version.',
          required: item.listing.latest.minPluginApiVersion,
          current: pluginApiVersion,
        })}
      </MarketplaceNotice>,
    );
  }
  if (item.newerNeedsHostUpgrade) {
    notices.push(
      <MarketplaceNotice key="newer" color="primary" title={t('plugins.marketNewerVersionTitle', 'A newer version is available')}>
        {t('plugins.marketNewerNeedsHostUpgrade', {
          defaultValue: 'Version {{version}} requires Plugin API ^{{required}}. It becomes available after updating TX-5DR.',
          version: item.listing.latest.version,
          required: item.listing.latest.minPluginApiVersion,
        })}
      </MarketplaceNotice>,
    );
  }
  if (item.isManualInstall) {
    notices.push(
      <MarketplaceNotice key="manual" color="default" title={t('plugins.marketInstalledManual', 'Installed manually')}>
        {t(
          'plugins.marketManualInstallHint',
          'This plugin is installed on disk but is not tracked by the official marketplace. Update and uninstall actions stay disabled here to avoid overwriting manual files.',
        )}
      </MarketplaceNotice>,
    );
  }
  if (!isAdmin) {
    notices.push(
      <MarketplaceNotice key="browse-only" color="default" title={t('plugins.marketBrowseOnlyBadge', 'Browse only')}>
        {t(
          'plugins.marketAdminRequired',
          'Browsing is available here, but installing, updating, and uninstalling requires an admin session.',
        )}
      </MarketplaceNotice>,
    );
  }

  return notices.length > 0 ? <div className="flex flex-col gap-2">{notices}</div> : null;
};

function getPermissionI18nKey(permission: PluginPermission): string {
  return permission.replace(':', '.');
}

const MarketplacePermissionSection: React.FC<{ permissions: PluginPermission[] }> = ({ permissions }) => {
  const { t } = useTranslation('settings');
  return (
    <section>
      <MarketplaceSectionTitle
        end={(
          <Chip size="sm" variant="flat" color="warning" className="h-5 text-[10px]">
            {t('plugins.marketPermissionCount', '{{count}} permissions', { count: permissions.length })}
          </Chip>
        )}
      >
        {t('plugins.marketPermissions', 'Requested permissions')}
      </MarketplaceSectionTitle>
      <ul className="flex flex-col gap-2 rounded-medium border border-warning-200 px-3 py-2">
        {permissions.map((permission) => {
          const key = getPermissionI18nKey(permission);
          return (
            <li key={permission} className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium text-default-800">
                  {t(`plugins.permission.${key}.name`, permission)}
                </span>
                <code className="text-[11px] text-default-400">{permission}</code>
              </div>
              <p className="text-xs leading-5 text-default-500">
                {t(`plugins.permission.${key}.description`, permission)}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const MarketplaceMeta: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="min-w-0">
    <dt className="text-[11px] text-default-400">{label}</dt>
    <dd className="truncate text-sm text-default-700">{children}</dd>
  </div>
);

const MarketplaceDetailsSection: React.FC<{ item: MarketItemState }> = ({ item }) => {
  const { t } = useTranslation('settings');
  const { listing, displayVersion } = item;
  const artifactUrl = resolveMarketplaceMarkdownUrl(displayVersion.artifactUrl);
  return (
    <section>
      <MarketplaceSectionTitle>{t('plugins.marketDetails', 'Details')}</MarketplaceSectionTitle>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {item.installedVersion && (
          <MarketplaceMeta label={t('plugins.marketInstalledVersion', 'Installed version')}>
            {item.installedVersion}
          </MarketplaceMeta>
        )}
        {item.installRecord && (
          <MarketplaceMeta label={t('plugins.marketInstalledAtLabel', 'Installed at')}>
            {formatDateTime(item.installRecord.installedAt)}
          </MarketplaceMeta>
        )}
        <MarketplaceMeta label={t('plugins.marketMinPluginApiVersion', 'Plugin API requirement')}>
          ^{displayVersion.minPluginApiVersion}
        </MarketplaceMeta>
        <MarketplaceMeta label={t('plugins.marketPublishedAt', 'Published at')}>
          {formatDateTime(displayVersion.publishedAt)}
        </MarketplaceMeta>
        {listing.license && (
          <MarketplaceMeta label={t('plugins.marketLicense', 'License')}>{listing.license}</MarketplaceMeta>
        )}
        <MarketplaceMeta label={t('plugins.marketPackageSize', 'Package size')}>
          {artifactUrl ? (
            <MarketplaceExternalLink href={artifactUrl}>
              {t('plugins.marketPackageSizeValue', '{{value}} KB', {
                value: (displayVersion.size / 1024).toFixed(displayVersion.size >= 1024 * 100 ? 0 : 1),
              })}
            </MarketplaceExternalLink>
          ) : t('plugins.marketPackageSizeValue', '{{value}} KB', {
            value: (displayVersion.size / 1024).toFixed(displayVersion.size >= 1024 * 100 ? 0 : 1),
          })}
        </MarketplaceMeta>
        {displayVersion.permissions.length === 0 && (
          <MarketplaceMeta label={t('plugins.marketPermissions', 'Requested permissions')}>
            {t('plugins.marketNoSensitivePermissionsTitle', 'No sensitive permissions requested')}
          </MarketplaceMeta>
        )}
        {listing.categories.length > 0 && (
          <MarketplaceMeta label={t('plugins.marketCategories', 'Categories')}>
            {listing.categories.join(' · ')}
          </MarketplaceMeta>
        )}
      </dl>
    </section>
  );
};

const VERSION_HISTORY_PREVIEW = 3;

const MarketplaceVersionHistory: React.FC<{ item: MarketItemState }> = ({ item }) => {
  const { t } = useTranslation('settings');
  const [expanded, setExpanded] = useState(false);
  const versions = [...item.listing.versions].sort((left, right) => compareSemverLike(right.version, left.version));
  const shown = expanded ? versions : versions.slice(0, VERSION_HISTORY_PREVIEW);
  return (
    <section>
      <MarketplaceSectionTitle
        end={versions.length > VERSION_HISTORY_PREVIEW && (
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setExpanded((value) => !value)}>
            {expanded
              ? t('plugins.marketCollapse', 'Collapse')
              : t('plugins.marketVersionHistoryShowAll', 'Show all {{count}} versions', { count: versions.length })}
          </button>
        )}
      >
        {t('plugins.marketVersionHistory', 'Version history')}
      </MarketplaceSectionTitle>
      <ul className="flex flex-col divide-y divide-divider">
        {shown.map((entry) => (
          <li key={entry.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-xs">
            <span className={`w-14 font-medium ${entry.yanked ? 'text-default-400 line-through' : 'text-default-700'}`}>
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
          </li>
        ))}
      </ul>
    </section>
  );
};

const MarketplaceReadmeSection: React.FC<{ markdown: string; sourceUrl?: string }> = ({ markdown, sourceUrl }) => {
  const { t } = useTranslation('settings');
  const safeSourceUrl = resolveMarketplaceMarkdownUrl(sourceUrl);

  return (
    <section className="border-t border-divider pt-4">
      <MarketplaceSectionTitle
        end={safeSourceUrl && (
          <MarketplaceExternalLink href={safeSourceUrl}>
            <span className="text-xs">{t('plugins.marketReadmeSource', 'View README source')}</span>
          </MarketplaceExternalLink>
        )}
      >
        {t('plugins.marketReadme', 'README')}
      </MarketplaceSectionTitle>
      <div className="prose prose-sm dark:prose-invert max-w-none text-default-700
                      prose-headings:scroll-mt-20 prose-headings:text-default-800 prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
                      prose-p:leading-6 prose-a:text-primary prose-code:text-default-800
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
