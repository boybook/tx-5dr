import React, { useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card,
  CardBody,
  Button,
  Input,
  Select,
  SelectItem,
  Chip,
  Tabs,
  Tab,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faTrash, faArrowUp, faArrowDown, faUndo } from '@fortawesome/free-solid-svg-icons';
import { api, getBandFromFrequency } from '@tx5dr/core';
import type { PresetFrequency } from '@tx5dr/contracts';
import { showErrorToast } from '../utils/errorToast';
import { createLogger } from '../utils/logger';

const logger = createLogger('FrequencyPresetSettings');

export interface FrequencyPresetSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface FrequencyPresetSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
  initialModeFilter?: string;
}

const MODE_OPTIONS = ['FT8', 'FT4', 'VOICE'];
const RADIO_MODE_OPTIONS = ['USB', 'LSB', 'FM', 'AM'];
const FILTER_ALL = '__all__';

function notifyFrequencyPresetsUpdated(): void {
  window.dispatchEvent(new CustomEvent('frequencyPresetsUpdated'));
}

export const FrequencyPresetSettings = forwardRef<
  FrequencyPresetSettingsRef,
  FrequencyPresetSettingsProps
>(({ onUnsavedChanges, initialModeFilter }, ref) => {
  const { t } = useTranslation();

  const [presets, setPresets] = useState<PresetFrequency[]>([]);
  const [originalPresets, setOriginalPresets] = useState<PresetFrequency[]>([]);
  const [isCustomized, setIsCustomized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [_isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  // 模式筛选 tab
  const [modeFilter, setModeFilter] = useState<string>(FILTER_ALL);

  // 添加表单状态
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newMode, setNewMode] = useState('FT8');
  const [newRadioMode, setNewRadioMode] = useState('USB');
  const [newFreqMHz, setNewFreqMHz] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [addError, setAddError] = useState('');

  // 恢复默认确认
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  // 从 presets 提取所有可用模式
  const availableModes = useMemo(() => {
    const modes = [...new Set(presets.map(p => p.mode))];
    modes.sort();
    return modes;
  }, [presets]);

  useEffect(() => {
    if (!initialModeFilter) {
      return;
    }
    setModeFilter(initialModeFilter);
  }, [initialModeFilter]);

  useEffect(() => {
    if (modeFilter === FILTER_ALL) {
      return;
    }
    if (availableModes.length === 0) {
      return;
    }
    if (!availableModes.includes(modeFilter)) {
      setModeFilter(FILTER_ALL);
    }
  }, [availableModes, modeFilter]);

  // 按当前 tab 筛选后的预设列表（仅用于显示）
  const filteredPresets = useMemo(() => {
    if (modeFilter === FILTER_ALL) return presets;
    return presets.filter(p => p.mode === modeFilter);
  }, [presets, modeFilter]);

  // 将 filteredPresets 中的 index 映射回 presets 中的真实 index
  const realIndices = useMemo(() => {
    if (modeFilter === FILTER_ALL) return presets.map((_, i) => i);
    const indices: number[] = [];
    presets.forEach((p, i) => {
      if (p.mode === modeFilter) indices.push(i);
    });
    return indices;
  }, [presets, modeFilter]);

  const hasUnsavedChanges = useCallback(() => {
    return JSON.stringify(presets) !== JSON.stringify(originalPresets);
  }, [presets, originalPresets]);

  useEffect(() => {
    onUnsavedChanges?.(hasUnsavedChanges());
  }, [presets, originalPresets, onUnsavedChanges, hasUnsavedChanges]);

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges,
    save: handleSave,
  }), [hasUnsavedChanges, presets]);

  // 加载数据
  useEffect(() => {
    loadPresets();
  }, []);

  const loadPresets = async () => {
    setIsLoading(true);
    try {
      const result = await api.getFrequencyPresets();
      if (result.success) {
        setPresets(result.presets);
        setOriginalPresets(result.presets);
        setIsCustomized(result.isCustomized);
        if (initialModeFilter && result.presets.some((preset) => preset.mode === initialModeFilter)) {
          setModeFilter(initialModeFilter);
        }
      }
    } catch (err) {
      logger.error('Failed to load frequency presets:', err);
      setError(t('freqPresets.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!hasUnsavedChanges()) return;

    setIsSaving(true);
    try {
      const result = await api.updateFrequencyPresets(presets);
      if (result.success) {
        setOriginalPresets([...presets]);
        setIsCustomized(result.isCustomized);
        notifyFrequencyPresetsUpdated();
      }
    } catch (err) {
      logger.error('Failed to save frequency presets:', err);
      showErrorToast({ userMessage: t('freqPresets.saveFailed'), severity: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = async () => {
    setIsResetConfirmOpen(false);
    try {
      const result = await api.resetFrequencyPresets();
      if (result.success) {
        setPresets(result.presets);
        setOriginalPresets(result.presets);
        setIsCustomized(false);
        notifyFrequencyPresetsUpdated();
      }
    } catch (err) {
      logger.error('Failed to reset frequency presets:', err);
      showErrorToast({ userMessage: t('freqPresets.saveFailed'), severity: 'error' });
    }
  };

  // 操作使用真实 index（操作的是完整 presets 数组）
  const handleRemove = (realIndex: number) => {
    if (presets.length <= 1) return;
    const next = [...presets];
    next.splice(realIndex, 1);
    setPresets(next);
  };

  const handleMoveUp = (realIndex: number, filteredIdx: number) => {
    if (modeFilter === FILTER_ALL) {
      // 全量视图：在完整数组中上移
      if (realIndex <= 0) return;
      const next = [...presets];
      [next[realIndex - 1], next[realIndex]] = [next[realIndex], next[realIndex - 1]];
      setPresets(next);
    } else {
      // 筛选视图：在同模式的项之间上移
      if (filteredIdx <= 0) return;
      const prevRealIndex = realIndices[filteredIdx - 1];
      const next = [...presets];
      [next[prevRealIndex], next[realIndex]] = [next[realIndex], next[prevRealIndex]];
      setPresets(next);
    }
  };

  const handleMoveDown = (realIndex: number, filteredIdx: number) => {
    if (modeFilter === FILTER_ALL) {
      if (realIndex >= presets.length - 1) return;
      const next = [...presets];
      [next[realIndex], next[realIndex + 1]] = [next[realIndex + 1], next[realIndex]];
      setPresets(next);
    } else {
      if (filteredIdx >= realIndices.length - 1) return;
      const nextRealIndex = realIndices[filteredIdx + 1];
      const next = [...presets];
      [next[realIndex], next[nextRealIndex]] = [next[nextRealIndex], next[realIndex]];
      setPresets(next);
    }
  };

  const handleAdd = () => {
    setAddError('');
    const freqValue = parseFloat(newFreqMHz);
    if (isNaN(freqValue) || freqValue <= 0) {
      setAddError(t('freqPresets.invalidFrequency'));
      return;
    }
    if (freqValue < 0.1 || freqValue > 1000) {
      setAddError(t('freqPresets.frequencyRange'));
      return;
    }

    const frequencyHz = Math.round(freqValue * 1000000);
    const inferredBand = getBandFromFrequency(frequencyHz);

    if (!inferredBand || inferredBand === 'Unknown') {
      setAddError(t('freqPresets.unknownBand'));
      return;
    }

    // 检查重复
    if (presets.some(p => p.frequency === frequencyHz)) {
      setAddError(t('freqPresets.duplicate'));
      return;
    }

    const description = newDescription.trim() || `${freqValue.toFixed(3)} MHz ${inferredBand}`;

    const newPreset: PresetFrequency = {
      band: inferredBand,
      mode: newMode,
      radioMode: newRadioMode,
      frequency: frequencyHz,
      description,
    };

    setPresets([...presets, newPreset]);
    setIsAddModalOpen(false);
    setNewFreqMHz('');
    setNewDescription('');
    setAddError('');
  };

  const openAddModal = () => {
    // 如果当前在某个模式 tab 下，默认选中该模式
    const initialMode = modeFilter !== FILTER_ALL ? modeFilter : 'FT8';
    setNewMode(initialMode);
    setNewRadioMode(initialMode === 'VOICE' ? 'USB' : 'USB');
    setNewFreqMHz('');
    setNewDescription('');
    setAddError('');
    setIsAddModalOpen(true);
  };

  const formatFrequency = (hz: number): string => {
    return (hz / 1000000).toFixed(3);
  };
  const inferredBand = useMemo(() => {
    const freqValue = parseFloat(newFreqMHz);
    if (!Number.isFinite(freqValue) || freqValue <= 0) {
      return null;
    }
    const frequencyHz = Math.round(freqValue * 1_000_000);
    const band = getBandFromFrequency(frequencyHz);
    return band && band !== 'Unknown' ? band : null;
  }, [newFreqMHz]);

  // 统计每个模式的预设数量
  const modeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of presets) {
      counts[p.mode] = (counts[p.mode] || 0) + 1;
    }
    return counts;
  }, [presets]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center py-12">
        <span className="text-default-400">{t('status.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex justify-center items-center py-12">
        <span className="text-danger">{error}</span>
      </div>
    );
  }

  const renderTable = (items: PresetFrequency[], indices: number[]) => {
    if (items.length === 0) {
      return (
        <div className="py-8 text-center text-default-400">
          {t('freqPresets.empty')}
        </div>
      );
    }

    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-divider bg-default-50">
              <th className="text-left px-3 py-2 font-medium text-default-600">{t('freqPresets.band')}</th>
              {modeFilter === FILTER_ALL && (
                <th className="text-left px-3 py-2 font-medium text-default-600">{t('freqPresets.mode')}</th>
              )}
              <th className="text-left px-3 py-2 font-medium text-default-600">{t('freqPresets.frequencyMHz')}</th>
              <th className="text-left px-3 py-2 font-medium text-default-600">{t('freqPresets.descriptionLabel')}</th>
              <th className="text-right px-3 py-2 font-medium text-default-600 w-[120px]"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((preset, filteredIdx) => {
              const realIndex = indices[filteredIdx];
              const isFirst = filteredIdx === 0;
              const isLast = filteredIdx === items.length - 1;

              return (
                <tr key={`${preset.frequency}-${realIndex}`} className="border-b border-divider last:border-b-0 hover:bg-default-50 transition-colors">
                  <td className="px-3 py-2">
                    <Chip size="sm" variant="flat" color="default">{preset.band}</Chip>
                  </td>
                  {modeFilter === FILTER_ALL && (
                    <td className="px-3 py-2">
                      <Chip size="sm" variant="flat" color={preset.mode === 'FT8' ? 'primary' : 'secondary'}>{preset.mode}</Chip>
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono">{formatFrequency(preset.frequency)}</td>
                  <td className="px-3 py-2 text-default-500">{preset.description || ''}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        isDisabled={isFirst}
                        onPress={() => handleMoveUp(realIndex, filteredIdx)}
                        aria-label={t('freqPresets.moveUp')}
                      >
                        <FontAwesomeIcon icon={faArrowUp} className="text-xs" />
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        isDisabled={isLast}
                        onPress={() => handleMoveDown(realIndex, filteredIdx)}
                        aria-label={t('freqPresets.moveDown')}
                      >
                        <FontAwesomeIcon icon={faArrowDown} className="text-xs" />
                      </Button>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        color="danger"
                        isDisabled={presets.length <= 1}
                        onPress={() => handleRemove(realIndex)}
                        aria-label={t('freqPresets.remove')}
                      >
                        <FontAwesomeIcon icon={faTrash} className="text-xs" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* 标题区域 */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t('freqPresets.title')}</h3>
          <p className="text-sm text-default-500 mt-1">{t('freqPresets.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Chip
            size="sm"
            color={isCustomized || hasUnsavedChanges() ? 'warning' : 'default'}
            variant="flat"
          >
            {isCustomized || hasUnsavedChanges() ? t('freqPresets.customized') : t('freqPresets.default')}
          </Chip>
          <Chip size="sm" variant="flat" color="default">
            {t('freqPresets.presetCount', { count: presets.length })}
          </Chip>
        </div>
      </div>

      {/* 模式筛选 Tabs */}
      <Tabs
        selectedKey={modeFilter}
        onSelectionChange={(key) => setModeFilter(key as string)}
        size="sm"
        variant="underlined"
      >
        <Tab
          key={FILTER_ALL}
          title={
            <div className="flex items-center gap-1.5">
              <span>{t('freqPresets.allModes')}</span>
              <Chip size="sm" variant="flat" color="default">{presets.length}</Chip>
            </div>
          }
        />
        {availableModes.map(mode => (
          <Tab
            key={mode}
            title={
              <div className="flex items-center gap-1.5">
                <span>{mode}</span>
                <Chip size="sm" variant="flat" color={mode === 'FT8' ? 'primary' : 'secondary'}>
                  {modeCounts[mode] || 0}
                </Chip>
              </div>
            }
          />
        ))}
      </Tabs>

      {/* 预设列表 */}
      <Card>
        <CardBody className="p-0">
          {renderTable(filteredPresets, realIndices)}
        </CardBody>
      </Card>

      {/* 操作按钮 */}
      <div className="flex items-center justify-between">
        <Button
          size="sm"
          variant="flat"
          color="primary"
          startContent={<FontAwesomeIcon icon={faPlus} />}
          onPress={openAddModal}
        >
          {t('freqPresets.add')}
        </Button>
        <Button
          size="sm"
          variant="flat"
          color="default"
          startContent={<FontAwesomeIcon icon={faUndo} />}
          onPress={() => setIsResetConfirmOpen(true)}
        >
          {t('freqPresets.resetToDefault')}
        </Button>
      </div>

      {/* 添加预设模态框 */}
      <Modal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} size="md">
        <ModalContent>
          <ModalHeader>{t('freqPresets.addTitle')}</ModalHeader>
          <ModalBody>
            <div className="flex gap-3">
              <Input
                label={t('freqPresets.band')}
                value={inferredBand ?? t('freqPresets.bandAutoPending')}
                isReadOnly
                className="flex-1"
              />
              <Select
                label={t('freqPresets.mode')}
                selectedKeys={[newMode]}
                onSelectionChange={(keys) => {
                  const val = Array.from(keys)[0] as string;
                  if (val) setNewMode(val);
                }}
                className="flex-1"
              >
                {MODE_OPTIONS.map(mode => (
                  <SelectItem key={mode} textValue={mode}>{mode}</SelectItem>
                ))}
              </Select>
              <Select
                label={t('freqPresets.radioMode')}
                selectedKeys={[newRadioMode]}
                onSelectionChange={(keys) => {
                  const val = Array.from(keys)[0] as string;
                  if (val) setNewRadioMode(val);
                }}
                className="flex-1"
              >
                {RADIO_MODE_OPTIONS.map(mode => (
                  <SelectItem key={mode} textValue={mode}>{mode}</SelectItem>
                ))}
              </Select>
            </div>
            <Input
              label={t('freqPresets.frequencyMHz')}
              placeholder={t('freqPresets.freqPlaceholder')}
              value={newFreqMHz}
              onValueChange={setNewFreqMHz}
              type="number"
              step="0.001"
              description={t('freqPresets.frequencyRange')}
              isInvalid={!!addError}
              errorMessage={addError}
            />
            <Input
              label={t('freqPresets.descriptionLabel')}
              placeholder={t('freqPresets.descPlaceholder')}
              value={newDescription}
              onValueChange={setNewDescription}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setIsAddModalOpen(false)}>
              {t('common:button.cancel')}
            </Button>
            <Button color="primary" onPress={handleAdd}>
              {t('freqPresets.add')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {/* 恢复默认确认模态框 */}
      <Modal isOpen={isResetConfirmOpen} onClose={() => setIsResetConfirmOpen(false)} size="sm">
        <ModalContent>
          <ModalHeader>{t('freqPresets.resetToDefault')}</ModalHeader>
          <ModalBody>
            <p className="text-default-600">{t('freqPresets.resetConfirm')}</p>
          </ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setIsResetConfirmOpen(false)}>
              {t('common:button.cancel')}
            </Button>
            <Button color="danger" onPress={handleReset}>
              {t('common:button.confirm')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
});

FrequencyPresetSettings.displayName = 'FrequencyPresetSettings';
