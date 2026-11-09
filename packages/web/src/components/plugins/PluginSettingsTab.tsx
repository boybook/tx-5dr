import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Divider, Tab, Tabs, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck,
  faChevronDown,
  faChevronUp,
  faCopy,
  faFolderOpen,
  faRotate,
  faShieldHalved,
} from '@fortawesome/free-solid-svg-icons';
import { PluginList, type PluginListRef } from './PluginList';
import { PluginLogPanel } from './PluginLogPanel';
import { PluginMarketplace } from './PluginMarketplace';
import { api } from '@tx5dr/core';
import { createLogger } from '../../utils/logger';
import type { PluginRuntimeInfo } from '@tx5dr/contracts';
import { pluginApi } from '../../utils/pluginApi';

const logger = createLogger('PluginSettingsTab');

/**
 * 全局插件设置 Tab（在 SettingsModal 的 Plugins Tab 中展示）
 *
 * 这里只展示全局维度的插件管理：
 * - 插件启用/禁用
 * - 插件全局级别的设置
 *
 * 操作员维度的插件设置在 OperatorSettings 中的对应操作员 Card 里展示。
 */
export interface PluginSettingsTabRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface PluginSettingsTabProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
  onUsesModalFooterSaveChange?: (usesFooter: boolean) => void;
}

type PluginSettingsView = 'installed' | 'marketplace';

interface InstalledPluginNavigationRequest {
  name: string;
  nonce: number;
}

export const PluginSettingsTab = forwardRef<PluginSettingsTabRef, PluginSettingsTabProps>(({
  onUnsavedChanges,
  onUsesModalFooterSaveChange,
}, ref) => {
  const { t } = useTranslation('settings');
  const pluginListRef = useRef<PluginListRef | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [runtimeInfo, setRuntimeInfo] = useState<PluginRuntimeInfo | null>(null);
  const [copiedKey, setCopiedKey] = useState<'pluginDir' | 'pluginDataDir' | null>(null);
  const [directoryDetailsOpen, setDirectoryDetailsOpen] = useState(false);
  const [activeView, setActiveView] = useState<PluginSettingsView>('installed');
  const [selectedInstalledPluginName, setSelectedInstalledPluginName] = useState<string | null>(null);
  const [installedPluginNavigationRequest, setInstalledPluginNavigationRequest] = useState<InstalledPluginNavigationRequest | null>(null);

  useEffect(() => {
    let cancelled = false;

    pluginApi.getRuntimeInfo()
      .then((nextRuntimeInfo) => {
        if (!cancelled) {
          setRuntimeInfo(nextRuntimeInfo);
        }
      })
      .catch((err: unknown) => logger.error('Failed to load plugin runtime info', err));

    return () => {
      cancelled = true;
    };
  }, []);

  const handleUnsavedChanges = useCallback((hasChanges: boolean) => {
    setHasUnsavedChanges(hasChanges);
    onUnsavedChanges?.(hasChanges);
  }, [onUnsavedChanges]);

  useEffect(() => {
    onUsesModalFooterSaveChange?.(activeView === 'installed' || hasUnsavedChanges);
  }, [activeView, hasUnsavedChanges, onUsesModalFooterSaveChange]);

  const handleReload = useCallback(async () => {
    setReloading(true);
    try {
      await api.reloadPlugins();
    } catch (err: unknown) {
      logger.error('Failed to reload plugins', err);
    } finally {
      setTimeout(() => setReloading(false), 2000);
    }
  }, []);

  const handleCopyPath = useCallback(async (pathValue: string | undefined, key: 'pluginDir' | 'pluginDataDir') => {
    if (!pathValue) {
      return;
    }

    try {
      await navigator.clipboard.writeText(pathValue);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((current) => current === key ? null : current), 1500);
    } catch (err: unknown) {
      logger.error('Failed to copy plugin path', err);
    }
  }, []);

  const handleOpenPath = useCallback(async (pathValue: string | undefined) => {
    if (!pathValue || !window.electronAPI?.shell?.openPath) {
      return;
    }

    try {
      await window.electronAPI.shell.openPath(pathValue);
    } catch (err: unknown) {
      logger.error('Failed to open plugin path', err);
    }
  }, []);

  const runtimeLabel = useMemo(() => {
    switch (runtimeInfo?.distribution) {
      case 'electron':
        return t('plugins.runtime.electron', 'Electron');
      case 'docker':
        return t('plugins.runtime.docker', 'Docker');
      case 'android-bridge':
        return t('plugins.runtime.androidBridge', 'Android Bridge');
      case 'linux-service':
        return t('plugins.runtime.linuxService', 'Linux Server');
      case 'web-dev':
        return t('plugins.runtime.dev', 'Dev');
      case 'generic-server':
        return t('plugins.runtime.generic', 'Server');
      default:
        return null;
    }
  }, [runtimeInfo?.distribution, t]);

  const runtimeHint = useMemo(() => {
    if (!runtimeInfo) {
      return t('plugins.directoryHintLoading', 'Loading the real plugin directory...');
    }

    switch (runtimeInfo.distribution) {
      case 'electron':
        return t('plugins.directoryHintElectron', 'Put plugin folders here, then return and reload plugins.');
      case 'docker':
        return t(
          'plugins.directoryHintDocker',
          'This is the container path. Mount it to a host folder, then place plugin folders there and reload plugins.',
        );
      case 'android-bridge':
        return t(
          'plugins.directoryHintAndroidBridge',
          'This is the plugin directory inside the Android bridge runtime. Install marketplace plugins here and reload plugins from the web UI.',
        );
      case 'linux-service':
        return t(
          'plugins.directoryHintLinux',
          'Administrators can place plugin folders here directly on the server, then reload plugins from the web UI.',
        );
      case 'web-dev':
        return t(
          'plugins.directoryHintDev',
          'This is the real external plugin directory used by the current development runtime on this machine.',
        );
      default:
        return t(
          'plugins.directoryHintGeneric',
          'Place plugin folders here and reload plugins after the files are in place.',
        );
    }
  }, [runtimeInfo, t]);

  const emptyMessage = useMemo(() => {
    if (!runtimeInfo?.pluginDir) {
      return t('plugins.emptyLoading', 'No plugins installed yet. Loading plugin directory...');
    }

    return t('plugins.emptyWithPath', {
      defaultValue: 'No plugins installed yet. Place plugin folders under {{path}} and reload.',
      path: runtimeInfo.pluginDir,
    });
  }, [runtimeInfo?.pluginDir, t]);

  const canOpenPath = typeof window !== 'undefined'
    && Boolean(window.electronAPI?.shell?.openPath);

  const handleOpenInstalledPlugin = useCallback((pluginName: string) => {
    setSelectedInstalledPluginName(pluginName);
    setInstalledPluginNavigationRequest((prev) => ({
      name: pluginName,
      nonce: (prev?.nonce ?? 0) + 1,
    }));
    setActiveView('installed');
  }, []);

  const handleInstalledPluginNavigationHandled = useCallback((requestKey: number) => {
    setInstalledPluginNavigationRequest((prev) => (
      prev?.nonce === requestKey ? null : prev
    ));
  }, []);

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => pluginListRef.current?.hasUnsavedChanges() || false,
    save: async () => {
      await pluginListRef.current?.save();
    },
  }), []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <Tabs
          aria-label={t('plugins.tabTitle', 'Plugins')}
          selectedKey={activeView}
          onSelectionChange={(key) => setActiveView(key as PluginSettingsView)}
          size="sm"
          radius="full"
          variant="solid"
          classNames={{
            tabList: 'w-fit',
          }}
        >
          <Tab key="installed" title={t('plugins.viewInstalled', 'Installed')} />
          <Tab key="marketplace" title={t('plugins.viewMarketplace', 'Marketplace')} />
        </Tabs>
        <div className="flex min-w-0 items-center gap-2">
          {runtimeLabel && (
            <span className="truncate rounded-full bg-default-100 px-2 py-0.5 text-[11px] font-medium text-default-600">
              {runtimeLabel}
            </span>
          )}
          {activeView === 'installed' && (
            <Tooltip content={t('plugins.reload', 'Reload plugins')}>
              <Button
                size="sm"
                variant="flat"
                isIconOnly
                isLoading={reloading}
                isDisabled={hasUnsavedChanges}
                onPress={handleReload}
                aria-label={t('plugins.reload', 'Reload plugins')}
              >
                <FontAwesomeIcon icon={faRotate} />
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className={activeView === 'installed' ? '-mx-3 -mt-2 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-4 pt-2 [&>*]:shrink-0' : 'hidden'}>
        <div className="rounded-medium border border-divider bg-default-50/70 px-3 py-2">
          <div className="grid grid-cols-[max-content_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1.5">
            <DirectoryField
              label={t('plugins.directoryLabel', 'Plugin directory')}
              value={runtimeInfo?.pluginDir}
              loadingLabel={t('plugins.directoryLoading', 'Loading...')}
              copied={copiedKey === 'pluginDir'}
              canOpen={canOpenPath}
              onCopy={() => { void handleCopyPath(runtimeInfo?.pluginDir, 'pluginDir'); }}
              onOpen={() => { void handleOpenPath(runtimeInfo?.pluginDir); }}
              copyLabel={t('plugins.copyPath', 'Copy path')}
              copiedLabel={t('plugins.pathCopied', 'Copied')}
              openLabel={t('plugins.openDirectory', 'Open folder')}
            />
            <div className="flex items-center">
              {!directoryDetailsOpen && (
                <Tooltip
                  className="max-w-xs"
                  content={t(
                    'plugins.manualInstallRiskDescription',
                    'A plugin placed in this directory can execute code with the TX-5DR host process. Only reload after you trust the source or have reviewed the code.',
                  )}
                >
                  <span
                    className="flex h-7 w-7 items-center justify-center text-warning"
                    aria-label={t('plugins.manualInstallRiskTitle', 'Manual plugins run locally')}
                  >
                    <FontAwesomeIcon icon={faShieldHalved} className="text-xs" />
                  </span>
                </Tooltip>
              )}
              <Button
                size="sm"
                variant="light"
                isIconOnly
                className="h-7 w-7 min-w-7"
                aria-expanded={directoryDetailsOpen}
                aria-label={directoryDetailsOpen
                  ? t('plugins.marketCollapse', 'Collapse')
                  : t('plugins.marketExpand', 'Expand')}
                onPress={() => setDirectoryDetailsOpen((value) => !value)}
              >
                <FontAwesomeIcon icon={directoryDetailsOpen ? faChevronUp : faChevronDown} className="text-xs text-default-500" />
              </Button>
            </div>
            {directoryDetailsOpen && (
              <>
                <DirectoryField
                  label={t('plugins.dataDirectoryLabel', 'Plugin data directory')}
                  value={runtimeInfo?.pluginDataDir}
                  loadingLabel={t('plugins.directoryLoading', 'Loading...')}
                  copied={copiedKey === 'pluginDataDir'}
                  canOpen={canOpenPath}
                  onCopy={() => { void handleCopyPath(runtimeInfo?.pluginDataDir, 'pluginDataDir'); }}
                  onOpen={() => { void handleOpenPath(runtimeInfo?.pluginDataDir); }}
                  copyLabel={t('plugins.copyPath', 'Copy path')}
                  copiedLabel={t('plugins.pathCopied', 'Copied')}
                  openLabel={t('plugins.openDirectory', 'Open folder')}
                />
                <span />
              </>
            )}
          </div>
          {directoryDetailsOpen && (
            <div className="mt-2 flex flex-col gap-1 border-t border-divider pt-2 text-xs leading-5 text-default-500">
              <p>{runtimeHint}</p>
              {runtimeInfo?.hostPluginDirHint && (
                <p className="text-default-400">
                  {t('plugins.directoryHostHint', {
                    defaultValue: 'Official docker-compose host mapping: {{path}}',
                    path: runtimeInfo.hostPluginDirHint,
                  })}
                </p>
              )}
              <p className="text-default-400">
                {t(
                  'plugins.dataDirectoryHint',
                  'Plugin source files stay in the plugin directory, while runtime state and store files are written into the plugin data directory.',
                )}
              </p>
              <p className="flex gap-1.5 text-warning-700">
                <FontAwesomeIcon icon={faShieldHalved} className="mt-1 shrink-0" />
                <span>
                  <span className="font-semibold">{t('plugins.manualInstallRiskTitle', 'Manual plugins run locally')}</span>
                  {' '}
                  {t(
                    'plugins.manualInstallRiskDescription',
                    'A plugin placed in this directory can execute code with the TX-5DR host process. Only reload after you trust the source or have reviewed the code.',
                  )}
                </span>
              </p>
            </div>
          )}
        </div>
        <PluginList
          ref={pluginListRef}
          onUnsavedChanges={handleUnsavedChanges}
          emptyMessage={emptyMessage}
          selectedPluginName={selectedInstalledPluginName}
          selectedPluginRequestKey={installedPluginNavigationRequest?.nonce}
          isVisible={activeView === 'installed'}
          onSelectedPluginRequestHandled={handleInstalledPluginNavigationHandled}
        />
        <Divider className="my-1" />
        <PluginLogPanel />
      </div>

      <div className={activeView === 'marketplace' ? 'flex min-h-0 flex-1 flex-col pb-3 sm:pb-4' : 'hidden'}>
        <PluginMarketplace
          isActive={activeView === 'marketplace'}
          onOpenInstalledPlugin={handleOpenInstalledPlugin}
        />
      </div>
    </div>
  );
});

PluginSettingsTab.displayName = 'PluginSettingsTab';

interface DirectoryFieldProps {
  label: string;
  value?: string;
  loadingLabel: string;
  copied: boolean;
  canOpen: boolean;
  onCopy: () => void;
  onOpen: () => void;
  copyLabel: string;
  copiedLabel: string;
  openLabel: string;
}

const DirectoryField: React.FC<DirectoryFieldProps> = ({
  label,
  value,
  loadingLabel,
  copied,
  canOpen,
  onCopy,
  onOpen,
  copyLabel,
  copiedLabel,
  openLabel,
}) => (
  <>
    <span className="whitespace-nowrap text-xs text-default-500">{label}</span>
    <code
      className="min-w-0 truncate rounded bg-content1 px-2 py-1 text-xs text-default-700"
      title={value}
    >
      {value ?? loadingLabel}
    </code>
    <div className="flex items-center">
      <Tooltip content={copied ? copiedLabel : copyLabel}>
        <Button
          size="sm"
          variant="light"
          isIconOnly
          className="h-7 w-7 min-w-7"
          onPress={onCopy}
          isDisabled={!value}
          aria-label={copyLabel}
        >
          <FontAwesomeIcon icon={copied ? faCheck : faCopy} className="text-xs text-default-500" />
        </Button>
      </Tooltip>
      {canOpen && (
        <Tooltip content={openLabel}>
          <Button
            size="sm"
            variant="light"
            isIconOnly
            className="h-7 w-7 min-w-7"
            onPress={onOpen}
            isDisabled={!value}
            aria-label={openLabel}
          >
            <FontAwesomeIcon icon={faFolderOpen} className="text-xs text-default-500" />
          </Button>
        </Tooltip>
      )}
    </div>
  </>
);
