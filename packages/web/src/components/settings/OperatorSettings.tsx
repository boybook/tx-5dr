import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Input,
  Switch,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Chip,
  Tooltip,
  ButtonGroup,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Tabs,
  Tab
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faEdit, faTrash, faSave, faTimes, faUsers, faToggleOn, faToggleOff, faCog } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type {
  RadioOperatorConfig,
  CreateRadioOperatorRequest,
  UpdateRadioOperatorRequest
} from '@tx5dr/contracts';
import { SyncConfigModal } from '../logbook/SyncConfigModal';
import { MODES, getFourCharacterGrid, sanitizeGridInput } from '@tx5dr/contracts';
import { useConnection, useStationInfo } from '../../store/radioStore';
import {
  setOperatorEnabled,
  isOperatorEnabled,
  getHiddenOperatorIds
} from '../../utils/operatorPreferences';
import { createLogger } from '../../utils/logger';
import { OperatorPluginSettings } from './OperatorPluginSettings';
import { getAuthHeaders } from '../../utils/authHeaders';

const logger = createLogger('OperatorSettings');
type EditableOperatorField = 'myCallsign' | 'myGrid';

export interface OperatorSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface OperatorSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const OperatorSettings = forwardRef<OperatorSettingsRef, OperatorSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const { t } = useTranslation('radio');
    const [operators, setOperators] = useState<RadioOperatorConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');
    const [hasChanges, setHasChanges] = useState(false);
    const [activeTab, setActiveTab] = useState<'manage' | 'preferences'>('manage');
    
    // 操作员偏好设置状态
    const connection = useConnection();
    const stationInfo = useStationInfo();
    const stationGrid = stationInfo?.qth?.grid ?? '';
    const defaultOperatorGrid = getFourCharacterGrid(stationGrid) ?? '';
    const [localEnabledStates, setLocalEnabledStates] = useState<Record<string, boolean>>({});
    const [preferencesHasChanges, setPreferencesHasChanges] = useState(false);

    // 字段级编辑状态
    const [editingFields, setEditingFields] = useState<Record<string, boolean>>({});
    const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
    const [savingFields, setSavingFields] = useState<Record<string, boolean>>({});

    // 新建操作员状态
    const [isCreating, setIsCreating] = useState(false);
    const [newOperatorData, setNewOperatorData] = useState<Partial<CreateRadioOperatorRequest>>({
      myCallsign: '',
      myGrid: defaultOperatorGrid,
      frequency: undefined, // 频率可选，用于无电台模式设置完整的无线电频率（Hz）
      transmitCycles: [0],
      mode: MODES.FT8,
    });

    // 台站网格加载后（异步），若用户未手动填写则自动同步
    useEffect(() => {
      if (defaultOperatorGrid && !newOperatorData.myGrid) {
        setNewOperatorData(prev => ({ ...prev, myGrid: defaultOperatorGrid }));
      }
    }, [defaultOperatorGrid, newOperatorData.myGrid]);

    // 删除确认对话框状态
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [operatorToDelete, setOperatorToDelete] = useState<RadioOperatorConfig | null>(null);

    // 同步配置
    const [syncProviderNames, setSyncProviderNames] = useState<string[]>([]);
    const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
    const [syncModalCallsign, setSyncModalCallsign] = useState('');

    useEffect(() => {
      fetch('/api/plugins/sync-providers', { headers: getAuthHeaders() })
        .then(r => r.json())
        .then((data: { displayName: string }[]) => setSyncProviderNames(data.map(p => p.displayName)))
        .catch(() => {});
    }, []);

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => hasChanges || preferencesHasChanges,
      save: async () => {
        // 保存偏好设置
        if (preferencesHasChanges) {
          await handleApplyPreferences();
        }
        // 操作员设置通常是即时保存的，不需要批量保存
        setHasChanges(false);
        onUnsavedChanges?.(false);
      }
    }));

    // 加载操作员列表
    const loadOperators = async () => {
      try {
        setLoading(true);
        const response = await api.getOperators();
        setOperators(response.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.loadFailed'));
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      loadOperators();
    }, []);

    // 当没有操作员且不在加载状态时，自动进入创建模式
    useEffect(() => {
      if (!loading && operators.length === 0 && !isCreating) {
        setIsCreating(true);
      }
    }, [loading, operators.length, isCreating]);

    const openSyncModal = (callsign: string) => {
      setSyncModalCallsign(callsign);
      setIsSyncModalOpen(true);
    };

    // 初始化操作员偏好设置
    useEffect(() => {
      const initialStates: Record<string, boolean> = {};
      operators.forEach(operator => {
        initialStates[operator.id] = isOperatorEnabled(operator.id);
      });
      setLocalEnabledStates(initialStates);
      setPreferencesHasChanges(false);
    }, [operators]);

    // 处理未保存更改状态
    const updateUnsavedChanges = (hasChanges: boolean) => {
      setHasChanges(hasChanges);
      onUnsavedChanges?.(hasChanges || preferencesHasChanges);
    };

    // 检查偏好设置是否有未保存的更改
    const checkPreferencesChanges = (newStates: Record<string, boolean>) => {
      const hasAnyChanges = operators.some(operator => {
        const currentEnabled = isOperatorEnabled(operator.id);
        const newEnabled = newStates[operator.id] ?? currentEnabled;
        return currentEnabled !== newEnabled;
      });

      setPreferencesHasChanges(hasAnyChanges);
      onUnsavedChanges?.(hasChanges || hasAnyChanges);
    };

    // 处理单个操作员启用状态变化
    const handleOperatorToggle = (operatorId: string, enabled: boolean) => {
      const newStates = {
        ...localEnabledStates,
        [operatorId]: enabled
      };
      setLocalEnabledStates(newStates);
      checkPreferencesChanges(newStates);
    };

    // 处理全部启用/禁用
    const handleToggleAll = (enabled: boolean) => {
      const newStates: Record<string, boolean> = {};
      operators.forEach(operator => {
        newStates[operator.id] = enabled;
      });
      setLocalEnabledStates(newStates);
      checkPreferencesChanges(newStates);
    };

    // 应用偏好设置更改
    const handleApplyPreferences = async () => {
      if (!preferencesHasChanges) return;
      
      try {
        // 保存到localStorage
        operators.forEach(operator => {
          const enabled = localEnabledStates[operator.id] ?? true;
          setOperatorEnabled(operator.id, enabled);
        });

        // 发送到服务器
        if (connection.state.isConnected && connection.state.radioService) {
          const enabledIds = operators
            .filter(op => localEnabledStates[op.id] ?? true)
            .map(op => op.id);
          
          logger.debug('Applying operator preferences:', enabledIds);
          connection.state.radioService.setClientEnabledOperators(enabledIds);
        }

        setPreferencesHasChanges(false);
        onUnsavedChanges?.(hasChanges);
        
        logger.info('Operator preferences applied');
      } catch (error) {
        logger.error('Failed to apply operator preferences:', error);
      }
    };

    const getFieldEditKey = (operatorId: string, field: EditableOperatorField) => `${operatorId}:${field}`;

    const startFieldEditing = (operator: RadioOperatorConfig, field: EditableOperatorField) => {
      const key = getFieldEditKey(operator.id, field);
      const initialValue = field === 'myGrid'
        ? operator.myGrid || ''
        : operator.myCallsign || '';

      setEditingFields(prev => ({ ...prev, [key]: true }));
      setFieldDrafts(prev => ({ ...prev, [key]: initialValue }));
      setError('');
    };

    const cancelFieldEditing = (operatorId: string, field: EditableOperatorField) => {
      const key = getFieldEditKey(operatorId, field);
      setEditingFields(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setFieldDrafts(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSavingFields(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };

    const updateFieldDraft = (operatorId: string, field: EditableOperatorField, value: string) => {
      const key = getFieldEditKey(operatorId, field);
      setFieldDrafts(prev => ({
        ...prev,
        [key]: value
      }));
    };

    const saveFieldEditing = async (operator: RadioOperatorConfig, field: EditableOperatorField) => {
      const key = getFieldEditKey(operator.id, field);
      const rawValue = fieldDrafts[key] ?? '';
      const normalizedValue = field === 'myGrid' ? sanitizeGridInput(rawValue) : rawValue.trim();
      const currentValue = field === 'myGrid' ? (operator.myGrid || '') : (operator.myCallsign || '');

      if (normalizedValue === currentValue) {
        cancelFieldEditing(operator.id, field);
        return;
      }

      try {
        setSavingFields(prev => ({ ...prev, [key]: true }));
        setError('');

        await api.updateOperator(operator.id, {
          [field]: normalizedValue
        } as UpdateRadioOperatorRequest);
        await loadOperators();

        cancelFieldEditing(operator.id, field);
        updateUnsavedChanges(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.saveFailed'));
      } finally {
        setSavingFields(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    };

    // 创建新操作员
    const createNewOperator = async () => {
      try {
        const response = await api.createOperator(newOperatorData as CreateRadioOperatorRequest);
        await loadOperators();

        // 新创建的操作员默认显示（不在黑名单中），同步到服务器
        if (response.data) {
          logger.info('New operator auto-enabled', { id: response.data.id, callsign: response.data.myCallsign });

          if (connection.state.isConnected && connection.state.radioService) {
            // 重新加载后的 operators 列表 + 新操作员，减去黑名单
            const hiddenSet = new Set(getHiddenOperatorIds());
            const allIds = [...operators.map(op => op.id), response.data.id];
            const enabledIds = allIds.filter(id => !hiddenSet.has(id));
            connection.state.radioService.setClientEnabledOperators(enabledIds);
            logger.debug('New operator synced to server');
          }
        }

        // 重置新建状态
        setIsCreating(false);
        setNewOperatorData({
          myCallsign: '',
          myGrid: defaultOperatorGrid,
          frequency: undefined, // 频率可选，用于无电台模式设置完整的无线电频率（Hz）
          transmitCycles: [0],
          mode: MODES.FT8,
        });
        updateUnsavedChanges(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.createFailed'));
      }
    };

    // 删除操作员
    const handleDelete = async (id: string) => {
      try {
        await api.deleteOperator(id);
        await loadOperators();
        updateUnsavedChanges(false);
        // 关闭确认对话框并重置状态
        setDeleteConfirmOpen(false);
        setOperatorToDelete(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.deleteFailed'));
        // 即使删除失败，也关闭对话框让用户看到错误信息
        setDeleteConfirmOpen(false);
        setOperatorToDelete(null);
      }
    };

    // 渲染展示模式的内容
    const renderDisplayMode = (operator: RadioOperatorConfig) => {
      const renderEditableField = (
        field: EditableOperatorField,
        label: string,
        value: string,
        options?: {
          placeholder?: string;
          description?: string;
          maxLength?: number;
        }
      ) => {
        const key = getFieldEditKey(operator.id, field);
        const isEditing = Boolean(editingFields[key]);
        const isSaving = Boolean(savingFields[key]);
        const draftValue = fieldDrafts[key] ?? value;

        return (
          <div className="rounded-lg border border-default-200 bg-default-50/60 px-3 pt-1.5 pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <span className="text-xs text-default-500 uppercase tracking-wide">{label}</span>
                {isEditing ? (
                  <div className="mt-2 flex items-start gap-2">
                    <Input
                      aria-label={label}
                      size="sm"
                      placeholder={options?.placeholder}
                      value={draftValue}
                      description={options?.description}
                      onValueChange={(nextValue) => {
                        const normalizedValue = field === 'myGrid'
                          ? sanitizeGridInput(nextValue)
                          : nextValue;
                        updateFieldDraft(operator.id, field, normalizedValue);
                      }}
                      maxLength={options?.maxLength}
                    />
                    <Button
                      size="sm"
                      color="primary"
                      onPress={() => saveFieldEditing(operator, field)}
                      isLoading={isSaving}
                    >
                      {t('common:button.save')}
                    </Button>
                    <Button
                      size="sm"
                      variant="flat"
                      onPress={() => cancelFieldEditing(operator.id, field)}
                      isDisabled={isSaving}
                    >
                      {t('common:button.cancel')}
                    </Button>
                  </div>
                ) : (
                  <p className="mt-1 text-sm font-medium">{value || t('settings.notSet')}</p>
                )}
              </div>
              {!isEditing && (
                <Tooltip content={t('common:button.edit')}>
                  <Button
                    isIconOnly
                    size="sm"
                    variant="light"
                    onPress={() => startFieldEditing(operator, field)}
                  >
                    <FontAwesomeIcon icon={faEdit} />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
        );
      };

      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {renderEditableField('myCallsign', t('settings.callsign'), operator.myCallsign, {
              placeholder: t('settings.callsignPlaceholder')
            })}
            {renderEditableField('myGrid', t('settings.grid'), operator.myGrid || '', {
              placeholder: t('settings.gridPlaceholder'),
              description: t('settings.gridDesc'),
              maxLength: 8
            })}
          </div>

          {/* 通联日志同步 */}
          {syncProviderNames.length > 0 && (
            <>
              <Divider className="my-3" />
              <div
                className="rounded-lg border border-default-200 bg-default-50/60 px-3 py-2.5 flex items-center justify-between cursor-pointer hover:bg-default-100/80 transition-colors"
                onClick={() => openSyncModal(operator.myCallsign)}
              >
                <div>
                  <p className="text-sm font-medium">{t('settings.logSync')}</p>
                  <p className="text-xs text-default-400 mt-0.5">{syncProviderNames.join(' / ')}</p>
                </div>
                <Button
                  size="sm"
                  variant="light"
                  onPress={() => openSyncModal(operator.myCallsign)}
                >
                  {t('settings.configure')}
                </Button>
              </div>
            </>
          )}

          <Divider />
          <OperatorPluginSettings operatorId={operator.id} />
        </div>
      );
    };

    // 渲染编辑模式的内容
    const renderEditMode = (formData: Partial<RadioOperatorConfig>) => {
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label={t('settings.callsign')}
              placeholder={t('settings.callsignPlaceholder')}
              value={formData.myCallsign || ''}
              onChange={(e) => {
                setNewOperatorData({ ...newOperatorData, myCallsign: e.target.value });
              }}
              isRequired
            />

            <Input
              label={t('settings.grid')}
              placeholder={t('settings.gridPlaceholder')}
              value={formData.myGrid || ''}
              description={t('settings.gridDesc')}
              onValueChange={(value) => {
                const normalizedGrid = sanitizeGridInput(value);
                setNewOperatorData({ ...newOperatorData, myGrid: normalizedGrid });
              }}
              maxLength={8}
            />
          </div>

        </div>
      );
    };

    // 渲染操作员卡片
    const renderOperatorCard = (operator: RadioOperatorConfig) => {
      return (
        <Card 
          key={operator.id} 
          className="w-full"
          shadow="none"
          classNames={{
            base: "border border-default-200 bg-default-50/50"
          }}
        >
          <CardHeader className="flex justify-between items-start p-4 pb-2">
            <div className="flex items-center gap-3">
              <div>
                <h4 className="text-lg font-semibold">{operator.myCallsign}</h4>
              </div>
            </div>
            
            <div className="flex gap-2">
              <Tooltip content={t('settings.deleteOperator')}>
                <Button
                  variant="flat"
                  color="danger"
                  onPress={() => {
                    setOperatorToDelete(operator);
                    setDeleteConfirmOpen(true);
                  }}
                  startContent={<FontAwesomeIcon icon={faTrash} />}
                >
                  {t('common:button.delete')}
                </Button>
              </Tooltip>
            </div>
          </CardHeader>
          
          <CardBody className='pt-0 p-4 pt-0'>
            {renderDisplayMode(operator)}
          </CardBody>
        </Card>
      );
    };

    // 渲染操作员偏好设置选项卡
    const renderPreferencesTab = () => {
      const enabledCount = Object.values(localEnabledStates).filter(Boolean).length;
      const totalCount = operators.length;

      return (
        <div className="space-y-6">
          <div>
            <h4 className="text-md font-semibold text-default-700 mb-2">{t('settings.displayPrefs')}</h4>
            <p className="text-sm text-default-500 mb-4">
              {t('settings.displayPrefsDesc')}
            </p>
          </div>

          {/* 统计信息和批量操作 */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex justify-between items-center w-full">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faUsers} className="text-primary" />
                  <span className="font-medium">{t('settings.operatorList')}</span>
                  <Chip size="sm" variant="flat" color="primary">
                    {t('settings.enabledCount', { enabled: enabledCount, total: totalCount })}
                  </Chip>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => handleToggleAll(true)}
                    isDisabled={enabledCount === totalCount}
                  >
                    <FontAwesomeIcon icon={faToggleOn} className="mr-1" />
                    {t('settings.enableAll')}
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    color="danger"
                    onPress={() => handleToggleAll(false)}
                    isDisabled={enabledCount === 0}
                  >
                    <FontAwesomeIcon icon={faToggleOff} className="mr-1" />
                    {t('settings.disableAll')}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <Divider />
            <CardBody>
              {operators.length === 0 ? (
                <div className="text-center py-8 text-default-500">
                  <FontAwesomeIcon icon={faUsers} className="text-4xl mb-3 opacity-50" />
                  <p>{t('settings.noOperators')}</p>
                  <p className="text-sm mt-1">{t('settings.noOperatorsHint')}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {operators.map((operator) => {
                    const enabled = localEnabledStates[operator.id] ?? true;
                    return (
                      <div
                        key={operator.id}
                        className="flex items-center justify-between p-3 bg-default-50 rounded-lg"
                      >
                        <div className="flex-1">
                          <div className="flex items-center gap-3">
                            <div className="font-medium text-default-700">
                              {operator.myCallsign || operator.id}
                            </div>
                            <div className="text-sm text-default-500">
                              {operator.myGrid && t('settings.gridValue', { grid: operator.myGrid })}
                            </div>
                            {operator.frequency && (
                              <Chip size="sm" variant="flat" color="secondary">
                                {operator.frequency} Hz
                              </Chip>
                            )}
                          </div>
                          <div className="text-xs text-default-400 mt-1">
                            ID: {operator.id}
                          </div>
                        </div>
                        <Switch
                          isSelected={enabled}
                          onValueChange={(checked) => handleOperatorToggle(operator.id, checked)}
                          size="sm"
                          color="primary"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </CardBody>
          </Card>

          {/* 说明信息 */}
          <div className="p-4 bg-default-50 rounded-lg">
            <h5 className="text-sm font-medium text-default-700 mb-2">{t('settings.hint')}</h5>
            <ul className="text-xs text-default-600 space-y-1">
              <li>• {t('settings.hintDisabledHide')}</li>
              <li>• {t('settings.hintDisabledEvents')}</li>
              <li>• {t('settings.hintLocalOnly')}</li>
              <li>• {t('settings.hintPersisted')}</li>
            </ul>
          </div>
        </div>
      );
    };

    // 渲染新建操作员卡片
    const renderNewOperatorCard = () => {
      if (!isCreating) return null;

      // 当没有操作员时，不显示取消按钮（必须创建至少一个操作员）
      const showCancelButton = operators.length > 0;

      return (
        <Card className="w-full border-2 border-dashed border-primary-300">
          <CardHeader className="flex justify-between items-center">
            <h4 className="text-lg font-semibold text-primary">{t('settings.newOperator')}</h4>
            <ButtonGroup size="sm">
              <Button
                color="primary"
                onPress={createNewOperator}
                isDisabled={!newOperatorData.myCallsign}
                startContent={<FontAwesomeIcon icon={faSave} />}
              >
                {t('common:button.create')}
              </Button>
              {showCancelButton && (
                <Button
                  variant="flat"
                  onPress={() => setIsCreating(false)}
                  startContent={<FontAwesomeIcon icon={faTimes} />}
                >
                  {t('common:button.cancel')}
                </Button>
              )}
            </ButtonGroup>
          </CardHeader>
          
          <CardBody>
            {renderEditMode(newOperatorData)}
          </CardBody>
        </Card>
      );
    };

    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-lg font-semibold">{t('settings.title')}</h3>
          <p className="text-sm text-default-500 mt-1">
            {t('settings.subtitle')}
          </p>
        </div>

        {error && (
          <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg">
            <p className="text-danger-700 text-sm">{error}</p>
          </div>
        )}

        {operators.length === 0 ? (
          // 当没有操作员时，只显示管理界面（创建入口），不显示选项卡
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h4 className="text-md font-semibold">{t('settings.operatorConfig')}</h4>
                <p className="text-sm text-default-500 mt-1">
                  {t('settings.operatorConfigDesc')}
                </p>
              </div>
              {!isCreating && (
                <Button
                  color="primary"
                  variant="flat"
                  onPress={() => setIsCreating(true)}
                  startContent={<FontAwesomeIcon icon={faPlus} />}
                  isDisabled={isCreating}
                >
                  {t('settings.newOperator')}
                </Button>
              )}
            </div>

            {loading ? (
              <div className="flex justify-center py-8">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
                  <p className="text-sm text-default-500 mt-2">{t('common:status.loading')}</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {renderNewOperatorCard()}
              </div>
            )}
          </div>
        ) : (
          // 有操作员时，始终显示带选项卡的界面（包含偏好 tab）
          <Tabs
            selectedKey={activeTab}
            onSelectionChange={(key) => setActiveTab(key as 'manage' | 'preferences')}
            size="md"
            className="w-full"
          >
            <Tab
              key="manage"
              title={
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faCog} />
                  <span>{t('settings.tabManage')}</span>
                </div>
              }
            >
            <div className="space-y-6 pt-4">
              <div className="flex justify-between items-center">
                <div>
                  <h4 className="text-md font-semibold">{t('settings.operatorConfig')}</h4>
                  <p className="text-sm text-default-500 mt-1">
                    {t('settings.operatorConfigDesc')}
                  </p>
                </div>
                {/* 当没有操作员且已在创建模式时，隐藏新建按钮 */}
                {!(operators.length === 0 && isCreating) && (
                  <Button
                    color="primary"
                    variant="flat"
                    onPress={() => setIsCreating(true)}
                    startContent={<FontAwesomeIcon icon={faPlus} />}
                    isDisabled={isCreating}
                  >
                    {t('settings.newOperator')}
                  </Button>
                )}
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
                    <p className="text-sm text-default-500 mt-2">{t('common:status.loading')}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* 新建操作员卡片 */}
                  {renderNewOperatorCard()}

                  {/* 现有操作员卡片 */}
                  {operators.length > 0 && operators.map(renderOperatorCard)}
                </div>
              )}
            </div>
          </Tab>
          
          <Tab
            key="preferences"
            title={
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faUsers} />
                <span>{t('settings.tabPreferences')}</span>
                {preferencesHasChanges && (
                  <Chip size="sm" color="warning" variant="flat">
                    {t('settings.hasChanges')}
                  </Chip>
                )}
              </div>
            }
          >
            <div className="pt-4">
              {renderPreferencesTab()}
            </div>
          </Tab>
        </Tabs>
        )}

        {/* 删除确认对话框 */}
        <Modal 
          isOpen={deleteConfirmOpen} 
          onClose={() => {
            setDeleteConfirmOpen(false);
            setOperatorToDelete(null);
          }}
          size="sm"
          placement="center"
        >
          <ModalContent>
            <ModalHeader className="flex flex-col gap-1">
              <h3 className="text-lg font-semibold text-danger">{t('settings.deleteOperator')}</h3>
            </ModalHeader>
            <ModalBody>
              {operatorToDelete && (
                <div className="space-y-3">
                  <p className="text-default-600">
                    {t('settings.deleteConfirm', { callsign: operatorToDelete.myCallsign })}
                  </p>
                  <div className="p-3 bg-warning-50 border border-warning-200 rounded-lg">
                    <p className="text-warning-700 text-sm">
                      {t('settings.deleteWarning')}
                    </p>
                  </div>
                </div>
              )}
            </ModalBody>
            <ModalFooter>
              <Button
                variant="flat"
                onPress={() => {
                  setDeleteConfirmOpen(false);
                  setOperatorToDelete(null);
                }}
              >
                {t('common:button.cancel')}
              </Button>
              <Button
                color="danger"
                onPress={() => {
                  if (operatorToDelete) {
                    handleDelete(operatorToDelete.id);
                  }
                  setDeleteConfirmOpen(false);
                }}
              >
                {t('settings.confirmDelete')}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* 同步配置弹窗 */}
        <SyncConfigModal
          isOpen={isSyncModalOpen}
          onClose={() => setIsSyncModalOpen(false)}
          callsign={syncModalCallsign}
        />
      </div>
    );
  }
);

OperatorSettings.displayName = 'OperatorSettings'; 
