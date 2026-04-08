import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectItem,
} from '@heroui/react';
import type { PluginStatus } from '@tx5dr/contracts';
import { api } from '@tx5dr/core';
import { createLogger } from '../../utils/logger';
import { usePluginSnapshot } from '../../hooks/usePluginSnapshot';
import { resolvePluginName } from '../../utils/pluginLocales';

const logger = createLogger('PluginStrategySelector');

interface PluginStrategySelectorProps {
  operatorId: string;
  currentStrategy?: string;
  onStrategyChange?: (pluginName: string) => void;
}

export const PluginStrategySelector: React.FC<PluginStrategySelectorProps> = ({
  operatorId,
  currentStrategy = 'standard-qso',
  onStrategyChange,
}) => {
  const { t } = useTranslation('settings');
  const snapshot = usePluginSnapshot();
  const [selected, setSelected] = useState(currentStrategy);
  const [saving, setSaving] = useState(false);
  const strategies = snapshot.plugins.filter((plugin: PluginStatus) => plugin.type === 'strategy');

  useEffect(() => {
    setSelected(currentStrategy);
  }, [operatorId, currentStrategy]);

  const handleChange = async (pluginName: string) => {
    const previous = selected;
    setSelected(pluginName);
    setSaving(true);
    try {
      await api.setOperatorStrategyPlugin(operatorId, pluginName);
      onStrategyChange?.(pluginName);
    } catch (err: unknown) {
      logger.error('Failed to set operator strategy', err);
      setSelected(previous);
    } finally {
      setSaving(false);
    }
  };

  if (strategies.length <= 1) return null;

  return (
    <Select
      size="sm"
      label={t('plugins.automationStrategy', 'Automation Strategy')}
      selectedKeys={[selected]}
      isDisabled={saving}
      onSelectionChange={(keys) => {
        const val = Array.from(keys as Set<string>)[0];
        if (val) handleChange(val);
      }}
      variant="bordered"
      >
        {strategies.map(strategy => (
          <SelectItem key={strategy.name}>
            {resolvePluginName(strategy.name, strategy.description ?? strategy.name)}
          </SelectItem>
        ))}
    </Select>
  );
};
