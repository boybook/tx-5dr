import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Divider, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotate } from '@fortawesome/free-solid-svg-icons';
import { PluginList, type PluginListRef } from './PluginList';
import { PluginLogPanel } from './PluginLogPanel';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { api } from '@tx5dr/core';
import { createLogger } from '../../utils/logger';

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

export const PluginSettingsTab = forwardRef<PluginSettingsTabRef, PluginSettingsTabProps>(({ onUnsavedChanges }, ref) => {
  const { t } = useTranslation('settings');
  const pluginListRef = useRef<PluginListRef | null>(null);
  const pluginSnapshot = usePluginSnapshot();
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [reloading, setReloading] = useState(false);

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

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => pluginListRef.current?.hasUnsavedChanges() || false,
    save: async () => {
      await pluginListRef.current?.save();
    },
  }), []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold mb-1">{t('plugins.title', 'Plugin Management')}</h3>
          <p className="text-sm text-default-400">
            {t('plugins.description', 'Manage plugins. Place plugin folders in the data/plugins/ directory.')}
          </p>
        </div>
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
      </div>
      <PluginList ref={pluginListRef} onUnsavedChanges={handleUnsavedChanges} />
      <Divider className="my-1" />
      <PluginLogPanel pluginNames={pluginSnapshot.plugins.map((plugin) => plugin.name)} />
    </div>
  );
});

PluginSettingsTab.displayName = 'PluginSettingsTab';
