import React, { useState, useEffect, forwardRef, useImperativeHandle, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Chip,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
  Tabs,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faTrash, faArrowUp, faArrowDown, faUndo, faEdit } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { PresetFrequency } from '@tx5dr/contracts';
import { showErrorToast } from '../../utils/errorToast';
import { createLogger } from '../../utils/logger';
import { FrequencyPresetAddModal } from './FrequencyPresetAddModal';

const logger = createLogger('FrequencyPresetSettings');

export interface FrequencyPresetSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface FrequencyPresetSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
  initialModeFilter?: string;
}

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
  const [isLoading, setIsLoading] = useState(true);
  const [_isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  // 模式筛选 tab
  const [modeFilter, setModeFilter] = useState<string>(FILTER_ALL);

  // 添加表单状态
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addInitialMode, setAddInitialMode] = useState('FT8');
  const [editingPresetIndex, setEditingPresetIndex] = useState<number | null>(null);

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

  const openAddModal = () => {
    // 如果当前在某个模式 tab 下，默认选中该模式
    const initialMode = modeFilter !== FILTER_ALL ? modeFilter : 'FT8';
    setAddInitialMode(initialMode);
    setEditingPresetIndex(null);
    setIsAddModalOpen(true);
  };

  const openEditModal = (realIndex: number) => {
    setEditingPresetIndex(realIndex);
    setIsAddModalOpen(true);
  };

  const closePresetModal = () => {
    setIsAddModalOpen(false);
    setEditingPresetIndex(null);
  };

  const handlePresetModalSave = (preset: PresetFrequency) => {
    if (editingPresetIndex === null) {
      setPresets([...presets, preset]);
      return;
    }

    const next = [...presets];
    next[editingPresetIndex] = preset;
    setPresets(next);
  };

  const formatFrequency = (hz: number): string => {
    return (hz / 1000000).toFixed(3);
  };
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
    const columns = [
      { key: 'band', label: t('freqPresets.band') },
      ...(modeFilter === FILTER_ALL ? [{ key: 'mode', label: t('freqPresets.mode') }] : []),
      { key: 'frequency', label: t('freqPresets.frequencyMHz') },
      { key: 'description', label: t('freqPresets.descriptionLabel') },
      { key: 'actions', label: '' },
    ];

    const rows = items.map((preset, filteredIdx) => ({
      key: `${preset.mode}-${preset.frequency}-${indices[filteredIdx]}`,
      preset,
      filteredIdx,
      realIndex: indices[filteredIdx],
    }));

    return (
      <Table
        aria-label={t('freqPresets.title')}
        isCompact
        isHeaderSticky
        removeWrapper
        classNames={{
          base: 'overflow-visible',
          table: 'min-w-full',
          thead: 'sticky top-0 z-20 [&>tr:first-child]:shadow-small [&>tr:last-child]:hidden',
          th: 'h-9 bg-default-50 py-1.5 text-default-600',
          td: 'h-10 py-1.5',
        }}
      >
        <TableHeader columns={columns}>
          {(column) => (
            <TableColumn key={column.key} align={column.key === 'actions' ? 'end' : 'start'}>
              {column.label}
            </TableColumn>
          )}
        </TableHeader>
        <TableBody items={rows} emptyContent={t('freqPresets.empty')}>
          {(row) => (
            <TableRow key={row.key}>
              {(columnKey) => {
                const preset = row.preset;
                const realIndex = row.realIndex;
                const isFirst = row.filteredIdx === 0;
                const isLast = row.filteredIdx === items.length - 1;

                switch (columnKey) {
                  case 'band':
                    return (
                      <TableCell>
                        <Chip size="sm" variant="flat" color="default">{preset.band}</Chip>
                      </TableCell>
                    );
                  case 'mode':
                    return (
                      <TableCell>
                        <Chip size="sm" variant="flat" color={preset.mode === 'FT8' ? 'primary' : 'secondary'}>{preset.mode}</Chip>
                      </TableCell>
                    );
                  case 'frequency':
                    return <TableCell className="font-mono">{formatFrequency(preset.frequency)}</TableCell>;
                  case 'description':
                    return <TableCell className="text-default-500">{preset.description || ''}</TableCell>;
                  case 'actions':
                    return (
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            onPress={() => openEditModal(realIndex)}
                            aria-label={t('freqPresets.edit')}
                            className="h-8 min-w-8 w-8"
                          >
                            <FontAwesomeIcon icon={faEdit} className="text-xs" />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            isDisabled={isFirst}
                            onPress={() => handleMoveUp(realIndex, row.filteredIdx)}
                            aria-label={t('freqPresets.moveUp')}
                            className="h-8 min-w-8 w-8"
                          >
                            <FontAwesomeIcon icon={faArrowUp} className="text-xs" />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            isDisabled={isLast}
                            onPress={() => handleMoveDown(realIndex, row.filteredIdx)}
                            aria-label={t('freqPresets.moveDown')}
                            className="h-8 min-w-8 w-8"
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
                            className="h-8 min-w-8 w-8"
                          >
                            <FontAwesomeIcon icon={faTrash} className="text-xs" />
                          </Button>
                        </div>
                      </TableCell>
                    );
                  default:
                    return <TableCell>{null}</TableCell>;
                }
              }}
            </TableRow>
          )}
        </TableBody>
      </Table>
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
      {renderTable(filteredPresets, realIndices)}

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

      <FrequencyPresetAddModal
        isOpen={isAddModalOpen}
        presets={presets}
        initialMode={addInitialMode}
        initialRadioMode="USB"
        editingPreset={editingPresetIndex === null ? null : presets[editingPresetIndex]}
        onClose={closePresetModal}
        onAdd={handlePresetModalSave}
      />

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
