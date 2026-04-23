import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Divider, Tab, Tabs, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate, faCopy, faCheck, faFolderOpen } from '@fortawesome/free-solid-svg-icons';
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
}

type PluginSettingsView = 'installed' | 'marketplace';

interface InstalledPluginNavigationRequest {
  name: string;
  nonce: number;
}

export const PluginSettingsTab = forwardRef<PluginSettingsTabRef, PluginSettingsTabProps>(({ onUnsavedChanges }, ref) => {
  const { t } = useTranslation('settings');
  const pluginListRef = useRef<PluginListRef | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [runtimeInfo, setRuntimeInfo] = useState<PluginRuntimeInfo | null>(null);
  const [copiedKey, setCopiedKey] = useState<'pluginDir' | 'pluginDataDir' | null>(null);
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold">{t('plugins.title', 'Plugin Management')}</h3>
            {runtimeLabel && (
              <span className="inline-flex items-center rounded-full bg-default-100 px-2 py-0.5 text-[11px] font-medium text-default-600">
                {runtimeLabel}
              </span>
            )}
          </div>
          <p className="text-sm text-default-400">
            {t('plugins.description', 'Manage installed automation plugins and browse the plugin marketplace.')}
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
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

      <div className={activeView === 'installed' ? 'flex flex-col gap-4' : 'hidden'}>
        <div className="rounded-medium border border-divider bg-default-50/70 px-3 py-3">
          <div className="flex flex-col gap-3">
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
            <div className="min-w-0">
              <p className="text-xs leading-5 text-default-500">{runtimeHint}</p>
              {runtimeInfo?.hostPluginDirHint && (
                <p className="mt-1 text-xs leading-5 text-default-400">
                  {t('plugins.directoryHostHint', {
                    defaultValue: 'Official docker-compose host mapping: {{path}}',
                    path: runtimeInfo.hostPluginDirHint,
                  })}
                </p>
              )}
              <p className="mt-2 text-xs leading-5 text-default-400">
                {t(
                  'plugins.dataDirectoryHint',
                  'Plugin source files stay in the plugin directory, while runtime state and store files are written into the plugin data directory.',
                )}
              </p>
            </div>
          </div>
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

      <div className={activeView === 'marketplace' ? 'block' : 'hidden'}>
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
  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
    <div className="min-w-0 flex-1">
      <p className="text-[11px] font-medium uppercase tracking-wider text-default-400">
        {label}
      </p>
      <code className="mt-1 block overflow-x-auto rounded bg-content1 px-2 py-1.5 text-xs text-default-700">
        {value ?? loadingLabel}
      </code>
    </div>
    <div className="flex shrink-0 items-center gap-2 self-start">
      <Tooltip content={copied ? copiedLabel : copyLabel}>
        <Button
          size="sm"
          variant="flat"
          isIconOnly
          onPress={onCopy}
          isDisabled={!value}
          aria-label={copyLabel}
        >
          <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
        </Button>
      </Tooltip>
      {canOpen && (
        <Tooltip content={openLabel}>
          <Button
            size="sm"
            variant="flat"
            isIconOnly
            onPress={onOpen}
            isDisabled={!value}
            aria-label={openLabel}
          >
            <FontAwesomeIcon icon={faFolderOpen} />
          </Button>
        </Tooltip>
      )}
    </div>
  </div>
);
