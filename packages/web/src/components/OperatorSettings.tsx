import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
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
import { SyncConfigModal } from './SyncConfigModal';
import { MODES } from '@tx5dr/contracts';
import { useConnection } from '../store/radioStore';
import {
  setOperatorEnabled,
  isOperatorEnabled,
  getEnabledOperatorIds
} from '../utils/operatorPreferences';

export interface OperatorSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface OperatorSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

export const OperatorSettings = forwardRef<OperatorSettingsRef, OperatorSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const [operators, setOperators] = useState<RadioOperatorConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>('');
    const [hasChanges, setHasChanges] = useState(false);
    const [activeTab, setActiveTab] = useState<'manage' | 'preferences'>('manage');
    
    // 操作员偏好设置状态
    const connection = useConnection();
    const [localEnabledStates, setLocalEnabledStates] = useState<Record<string, boolean>>({});
    const [preferencesHasChanges, setPreferencesHasChanges] = useState(false);
    
    // 编辑状态 - 记录哪些操作员正在编辑中
    const [editingOperators, setEditingOperators] = useState<Set<string>>(new Set());
    const [editFormData, setEditFormData] = useState<Record<string, Partial<RadioOperatorConfig>>>({});
    
    // 新建操作员状态
    const [isCreating, setIsCreating] = useState(false);
    const [newOperatorData, setNewOperatorData] = useState<Partial<CreateRadioOperatorRequest>>({
      myCallsign: '',
      myGrid: '',
      frequency: undefined, // 频率可选，用于无电台模式设置完整的无线电频率（Hz）
      transmitCycles: [0],
      maxQSOTimeoutCycles: 10,
      maxCallAttempts: 3,
      autoReplyToCQ: false,
      autoResumeCQAfterFail: false,
      autoResumeCQAfterSuccess: false,
      mode: MODES.FT8,
    });

    // 删除确认对话框状态
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [operatorToDelete, setOperatorToDelete] = useState<RadioOperatorConfig | null>(null);

    // 同步配置状态
    const [syncSummaries, setSyncSummaries] = useState<Record<string, { wavelog: boolean; qrz: boolean; lotw: boolean }>>({});
    const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
    const [syncModalCallsign, setSyncModalCallsign] = useState('');
    const [syncModalInitialTab, setSyncModalInitialTab] = useState<'wavelog' | 'qrz' | 'lotw'>('wavelog');

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
        setError(err instanceof Error ? err.message : '加载操作员列表失败');
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

    // 加载操作员同步配置摘要
    useEffect(() => {
      const loadSyncSummaries = async () => {
        const summaries: Record<string, { wavelog: boolean; qrz: boolean; lotw: boolean }> = {};
        for (const operator of operators) {
          try {
            const res = await api.getCallsignSyncSummary(operator.myCallsign) as { success?: boolean; summary?: { wavelog: boolean; qrz: boolean; lotw: boolean } };
            if (res.success && res.summary) {
              summaries[operator.myCallsign] = res.summary;
            }
          } catch {
            // 忽略加载失败
          }
        }
        setSyncSummaries(summaries);
      };
      if (operators.length > 0) {
        loadSyncSummaries();
      }
    }, [operators]);

    // 打开同步配置弹窗
    const openSyncModal = (callsign: string, tab: 'wavelog' | 'qrz' | 'lotw') => {
      setSyncModalCallsign(callsign);
      setSyncModalInitialTab(tab);
      setIsSyncModalOpen(true);
    };

    // 刷新某个呼号的同步摘要
    const refreshSyncSummary = async (callsign: string) => {
      try {
        const res = await api.getCallsignSyncSummary(callsign) as { success?: boolean; summary?: { wavelog: boolean; qrz: boolean; lotw: boolean } };
        if (res.success && res.summary) {
          setSyncSummaries(prev => ({ ...prev, [callsign]: res.summary! }));
        }
      } catch {
        // 忽略刷新失败
      }
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
          
          console.log('📤 [OperatorSettings] 应用操作员偏好设置:', enabledIds);
          connection.state.radioService.setClientEnabledOperators(enabledIds);
        }

        setPreferencesHasChanges(false);
        onUnsavedChanges?.(hasChanges);
        
        console.log('✅ 操作员偏好设置已应用');
      } catch (error) {
        console.error('❌ 应用操作员偏好设置失败:', error);
      }
    };

    // 开始编辑操作员
    const startEditing = (operator: RadioOperatorConfig) => {
      setEditingOperators(prev => new Set([...prev, operator.id]));
      setEditFormData(prev => ({
        ...prev,
        [operator.id]: { ...operator }
      }));
    };

    // 取消编辑
    const cancelEditing = (operatorId: string) => {
      setEditingOperators(prev => {
        const newSet = new Set(prev);
        newSet.delete(operatorId);
        return newSet;
      });
      setEditFormData(prev => {
        const newData = { ...prev };
        delete newData[operatorId];
        return newData;
      });
    };

    // 保存编辑
    const saveEditing = async (operatorId: string) => {
      try {
        const updates = editFormData[operatorId];
        if (!updates) return;

        await api.updateOperator(operatorId, updates as UpdateRadioOperatorRequest);
        await loadOperators();
        
        // 清除编辑状态
        cancelEditing(operatorId);
        updateUnsavedChanges(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存失败');
      }
    };

    // 更新编辑表单数据
    const updateEditFormData = (operatorId: string, field: string, value: string | number | boolean) => {
      setEditFormData(prev => ({
        ...prev,
        [operatorId]: {
          ...prev[operatorId],
          [field]: value
        }
      }));
    };

    // 创建新操作员
    const createNewOperator = async () => {
      try {
        const response = await api.createOperator(newOperatorData as CreateRadioOperatorRequest);
        await loadOperators();

        // 自动启用新创建的操作员
        if (response.data) {
          setOperatorEnabled(response.data.id, true);
          console.log('✅ 新操作员已自动启用:', response.data.id, response.data.myCallsign);

          // 如果已连接，同步到服务器
          if (connection.state.isConnected && connection.state.radioService) {
            const enabledIds = [...getEnabledOperatorIds(), response.data.id];
            connection.state.radioService.setClientEnabledOperators(enabledIds);
            console.log('📤 [OperatorSettings] 已同步新操作员到服务器');
          }
        }

        // 重置新建状态
        setIsCreating(false);
        setNewOperatorData({
          myCallsign: '',
          myGrid: '',
          frequency: undefined, // 频率可选，用于无电台模式设置完整的无线电频率（Hz）
          transmitCycles: [0],
          maxQSOTimeoutCycles: 10,
          maxCallAttempts: 3,
          autoReplyToCQ: false,
          autoResumeCQAfterFail: false,
          autoResumeCQAfterSuccess: false,
          mode: MODES.FT8,
        });
        updateUnsavedChanges(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : '创建失败');
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
        setError(err instanceof Error ? err.message : '删除失败');
        // 即使删除失败，也关闭对话框让用户看到错误信息
        setDeleteConfirmOpen(false);
        setOperatorToDelete(null);
      }
    };

    // SyncServiceCard 内联组件
    const SyncServiceCard = ({ name, enabled, onConfigure }: { name: string; enabled: boolean; onConfigure: () => void }) => (
      <div className={`border rounded-lg p-2 flex-1 min-w-[100px] ${enabled ? 'border-success' : 'border-default-200'}`}>
        <p className="text-xs font-medium">{name}</p>
        <div className="flex items-center justify-between mt-1">
          <Chip size="sm" color={enabled ? 'success' : 'default'} variant="flat">
            {enabled ? '已配置' : '未配置'}
          </Chip>
          <Button size="sm" variant="light" onPress={onConfigure}>
            {enabled ? '修改' : '配置'}
          </Button>
        </div>
      </div>
    );

    // 渲染展示模式的内容
    const renderDisplayMode = (operator: RadioOperatorConfig) => {
      const syncSummary = syncSummaries[operator.myCallsign] || { wavelog: false, qrz: false, lotw: false };
      const hasSyncConfig = syncSummary.wavelog || syncSummary.qrz || syncSummary.lotw;

      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <span className="text-xs text-default-500 uppercase tracking-wide">呼号</span>
              <p className="text-sm font-medium">{operator.myCallsign}</p>
            </div>

            <div>
              <span className="text-xs text-default-500 uppercase tracking-wide">网格坐标</span>
              <p className="text-sm font-medium">{operator.myGrid || '未设置'}</p>
            </div>
          </div>

          {/* 通联日志同步 */}
          <Divider className="my-3" />
          <p className="text-sm font-medium mb-2">通联日志同步</p>
          {!hasSyncConfig && (
            <p className="text-xs text-default-400 mb-2">
              配置同步服务后，通联记录可自动上传到 WaveLog、QRZ.com 或 LoTW
            </p>
          )}
          <div className="flex gap-2 flex-wrap">
            <SyncServiceCard
              name="WaveLog"
              enabled={syncSummary.wavelog}
              onConfigure={() => openSyncModal(operator.myCallsign, 'wavelog')}
            />
            <SyncServiceCard
              name="QRZ.com"
              enabled={syncSummary.qrz}
              onConfigure={() => openSyncModal(operator.myCallsign, 'qrz')}
            />
            <SyncServiceCard
              name="LoTW"
              enabled={syncSummary.lotw}
              onConfigure={() => openSyncModal(operator.myCallsign, 'lotw')}
            />
          </div>

          {/* 自动化配置展示 */}
          <Divider />
          <div className="space-y-3">
            <h5 className="text-sm font-medium text-default-700">自动化设置</h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">自动回复CQ</span>
                <Chip size="sm" variant="flat" color={operator.autoReplyToCQ ? "success" : "default"}>
                  {operator.autoReplyToCQ ? "启用" : "禁用"}
                </Chip>
              </div>
              
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">失败后自动恢复CQ</span>
                <Chip size="sm" variant="flat" color={operator.autoResumeCQAfterFail ? "success" : "default"}>
                  {operator.autoResumeCQAfterFail ? "启用" : "禁用"}
                </Chip>
              </div>
              
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">成功后自动恢复CQ</span>
                <Chip size="sm" variant="flat" color={operator.autoResumeCQAfterSuccess ? "success" : "default"}>
                  {operator.autoResumeCQAfterSuccess ? "启用" : "禁用"}
                </Chip>
              </div>
              
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">回复已通联过的电台</span>
                <Chip size="sm" variant="flat" color={operator.replyToWorkedStations ? "success" : "default"}>
                  {operator.replyToWorkedStations ? "启用" : "禁用"}
                </Chip>
              </div>
              
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">优先选择新呼号</span>
                <Chip size="sm" variant="flat" color={operator.prioritizeNewCalls ? "success" : "default"}>
                  {operator.prioritizeNewCalls ? "启用" : "禁用"}
                </Chip>
              </div>
            </div>
          </div>

          {/* 高级设置展示 */}
          <Divider />
          <div className="space-y-3">
            <h5 className="text-sm font-medium text-default-700">高级设置</h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">最大QSO超时周期</span>
                <span className="text-sm font-medium text-primary">{operator.maxQSOTimeoutCycles} 周期</span>
              </div>
              
              <div className="flex items-center justify-between bg-default-100/50 rounded-lg px-3 py-2">
                <span className="text-sm">最大呼叫尝试次数</span>
                <span className="text-sm font-medium text-primary">{operator.maxCallAttempts} 次</span>
              </div>
            </div>
          </div>
        </div>
      );
    };

    // 渲染编辑模式的内容
    const renderEditMode = (formData: Partial<RadioOperatorConfig>, operatorId?: string) => {
      const isNewOperator = !operatorId;
      
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="呼号"
              placeholder="例如: BG5DRB"
              value={formData.myCallsign || ''}
              onChange={(e) => {
                if (isNewOperator) {
                  setNewOperatorData({ ...newOperatorData, myCallsign: e.target.value });
                } else {
                  updateEditFormData(operatorId!, 'myCallsign', e.target.value);
                }
              }}
              isRequired
            />
            
            <Input
              label="网格坐标"
              placeholder="例如: PL09"
              value={formData.myGrid || ''}
              onChange={(e) => {
                if (isNewOperator) {
                  setNewOperatorData({ ...newOperatorData, myGrid: e.target.value });
                } else {
                  updateEditFormData(operatorId!, 'myGrid', e.target.value);
                }
              }}
            />
          </div>

          {/* 自动化配置 */}
          <Divider />
          <div className="space-y-3">
            <h5 className="text-sm font-medium text-default-700">自动化设置</h5>
            <div className="grid grid-cols-1 gap-3">
              <Switch
                isSelected={formData.autoReplyToCQ || false}
                onValueChange={(checked) => {
                  if (isNewOperator) {
                    setNewOperatorData({ ...newOperatorData, autoReplyToCQ: checked });
                  } else {
                    updateEditFormData(operatorId!, 'autoReplyToCQ', checked);
                  }
                }}
                size="sm"
              >
                自动回复CQ
              </Switch>
              
              <Switch
                isSelected={formData.autoResumeCQAfterFail || false}
                onValueChange={(checked) => {
                  if (isNewOperator) {
                    setNewOperatorData({ ...newOperatorData, autoResumeCQAfterFail: checked });
                  } else {
                    updateEditFormData(operatorId!, 'autoResumeCQAfterFail', checked);
                  }
                }}
                size="sm"
              >
                失败后自动恢复CQ
              </Switch>
              
              <Switch
                isSelected={formData.autoResumeCQAfterSuccess || false}
                onValueChange={(checked) => {
                  if (isNewOperator) {
                    setNewOperatorData({ ...newOperatorData, autoResumeCQAfterSuccess: checked });
                  } else {
                    updateEditFormData(operatorId!, 'autoResumeCQAfterSuccess', checked);
                  }
                }}
                size="sm"
              >
                成功后自动恢复CQ
              </Switch>
              
              <Switch
                isSelected={formData.replyToWorkedStations || false}
                onValueChange={(checked) => {
                  if (isNewOperator) {
                    setNewOperatorData({ ...newOperatorData, replyToWorkedStations: checked });
                  } else {
                    updateEditFormData(operatorId!, 'replyToWorkedStations', checked);
                  }
                }}
                size="sm"
              >
                回复已通联过的电台
              </Switch>
              
              <Switch
                isSelected={formData.prioritizeNewCalls !== false}
                onValueChange={(checked) => {
                  if (isNewOperator) {
                    setNewOperatorData({ ...newOperatorData, prioritizeNewCalls: checked });
                  } else {
                    updateEditFormData(operatorId!, 'prioritizeNewCalls', checked);
                  }
                }}
                size="sm"
              >
                优先选择新呼号
              </Switch>
            </div>
          </div>

          {/* 高级设置 */}
          <Divider />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              type="number"
              label="最大QSO超时周期"
              description="QSO进行中（已收到对方回复、正在交换信号报告），等待对方响应的最大周期数"
              value={formData.maxQSOTimeoutCycles?.toString() || ''}
              onChange={(e) => {
                const value = parseInt(e.target.value) || 10;
                if (isNewOperator) {
                  setNewOperatorData({ ...newOperatorData, maxQSOTimeoutCycles: value });
                } else {
                  updateEditFormData(operatorId!, 'maxQSOTimeoutCycles', value);
                }
              }}
              min={1}
              max={50}
              size="sm"
            />

            <Input
              type="number"
              label="最大呼叫尝试次数"
              description="主动呼叫他人时，对方未回复的情况下，最多重试的次数"
              value={formData.maxCallAttempts?.toString() || ''}
              onChange={(e) => {
                const value = parseInt(e.target.value) || 3;
                if (isNewOperator) {
                  setNewOperatorData({ ...newOperatorData, maxCallAttempts: value });
                } else {
                  updateEditFormData(operatorId!, 'maxCallAttempts', value);
                }
              }}
              min={1}
              max={1000}
              size="sm"
            />
          </div>
        </div>
      );
    };

    // 渲染操作员卡片
    const renderOperatorCard = (operator: RadioOperatorConfig) => {
      const isEditing = editingOperators.has(operator.id);
      const formData = editFormData[operator.id] || operator;

      return (
        <Card 
          key={operator.id} 
          className="w-full"
          shadow={isEditing ? "md" : "none"}
          classNames={{
            base: isEditing ? "" : "border border-default-200 bg-default-50/50"
          }}
        >
          <CardHeader className="flex justify-between items-start p-4 pb-2">
            <div className="flex items-center gap-3">
              <div>
                <h4 className="text-lg font-semibold">{operator.myCallsign}</h4>
              </div>
            </div>
            
            <div className="flex gap-2">
              {isEditing ? (
                <ButtonGroup size="sm">
                  <Button
                    color="primary"
                    variant="flat"
                    onPress={() => saveEditing(operator.id)}
                    startContent={<FontAwesomeIcon icon={faSave} />}
                  >
                    保存
                  </Button>
                  <Button
                    variant="flat"
                    onPress={() => cancelEditing(operator.id)}
                    startContent={<FontAwesomeIcon icon={faTimes} />}
                  >
                    取消
                  </Button>
                </ButtonGroup>
              ) : (
                <ButtonGroup size="sm">
                  <Tooltip content="编辑">
                    <Button
                      variant="flat"
                      onPress={() => startEditing(operator)}
                      startContent={<FontAwesomeIcon icon={faEdit} />}
                    >
                      编辑
                    </Button>
                  </Tooltip>
                  
                  <Tooltip content="删除操作员">
                    <Button
                      variant="flat"
                      color="danger"
                      onPress={() => {
                        setOperatorToDelete(operator);
                        setDeleteConfirmOpen(true);
                      }}
                      startContent={<FontAwesomeIcon icon={faTrash} />}
                    >
                      删除
                    </Button>
                  </Tooltip>
                </ButtonGroup>
              )}
            </div>
          </CardHeader>
          
          <CardBody className='pt-0 p-4 pt-0'>
            {isEditing ? renderEditMode(formData, operator.id) : renderDisplayMode(operator)}
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
            <h4 className="text-md font-semibold text-default-700 mb-2">操作员显示偏好</h4>
            <p className="text-sm text-default-500 mb-4">
              选择在此客户端中显示哪些操作员。未启用的操作员将不会在界面中显示，也不会接收其相关事件。
            </p>
          </div>

          {/* 统计信息和批量操作 */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex justify-between items-center w-full">
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faUsers} className="text-primary" />
                  <span className="font-medium">操作员列表</span>
                  <Chip size="sm" variant="flat" color="primary">
                    {enabledCount}/{totalCount} 已启用
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
                    全部启用
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    color="danger"
                    onPress={() => handleToggleAll(false)}
                    isDisabled={enabledCount === 0}
                  >
                    <FontAwesomeIcon icon={faToggleOff} className="mr-1" />
                    全部禁用
                  </Button>
                </div>
              </div>
            </CardHeader>
            <Divider />
            <CardBody>
              {operators.length === 0 ? (
                <div className="text-center py-8 text-default-500">
                  <FontAwesomeIcon icon={faUsers} className="text-4xl mb-3 opacity-50" />
                  <p>暂无操作员</p>
                  <p className="text-sm mt-1">请先在"操作员管理"选项卡中创建操作员</p>
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
                              {operator.myGrid && `网格: ${operator.myGrid}`}
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
            <h5 className="text-sm font-medium text-default-700 mb-2">设置说明</h5>
            <ul className="text-xs text-default-600 space-y-1">
              <li>• 禁用的操作员不会在操作员列表中显示</li>
              <li>• 禁用的操作员的状态更新和事件不会发送到此客户端</li>
              <li>• 设置仅影响当前客户端，不影响服务器上的操作员运行</li>
              <li>• 设置会保存在浏览器本地存储中，下次打开时会自动恢复</li>
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
            <h4 className="text-lg font-semibold text-primary">新建操作员</h4>
            <ButtonGroup size="sm">
              <Button
                color="primary"
                onPress={createNewOperator}
                isDisabled={!newOperatorData.myCallsign}
                startContent={<FontAwesomeIcon icon={faSave} />}
              >
                创建
              </Button>
              {showCancelButton && (
                <Button
                  variant="flat"
                  onPress={() => setIsCreating(false)}
                  startContent={<FontAwesomeIcon icon={faTimes} />}
                >
                  取消
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
          <h3 className="text-lg font-semibold">电台操作员设置</h3>
          <p className="text-sm text-default-500 mt-1">
            管理操作员配置和显示偏好
          </p>
        </div>

        {error && (
          <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg">
            <p className="text-danger-700 text-sm">{error}</p>
          </div>
        )}

        {operators.length <= 1 ? (
          // 当操作员数量≤1时，只显示管理界面，不显示选项卡
          <div className="space-y-6">
            <div className="flex justify-between items-center">
              <div>
                <h4 className="text-md font-semibold">操作员配置</h4>
                <p className="text-sm text-default-500 mt-1">
                  创建和管理多个电台操作员配置
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
                  新建操作员
                </Button>
              )}
            </div>

            {loading ? (
              <div className="flex justify-center py-8">
                <div className="text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
                  <p className="text-sm text-default-500 mt-2">加载中...</p>
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
        ) : (
          // 当操作员数量>1时，显示带选项卡的界面
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
                  <span>操作员管理</span>
                </div>
              }
            >
            <div className="space-y-6 pt-4">
              <div className="flex justify-between items-center">
                <div>
                  <h4 className="text-md font-semibold">操作员配置</h4>
                  <p className="text-sm text-default-500 mt-1">
                    创建和管理多个电台操作员配置
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
                    新建操作员
                  </Button>
                )}
              </div>

              {loading ? (
                <div className="flex justify-center py-8">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
                    <p className="text-sm text-default-500 mt-2">加载中...</p>
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
                <span>显示偏好</span>
                {preferencesHasChanges && (
                  <Chip size="sm" color="warning" variant="flat">
                    有更改
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
              <h3 className="text-lg font-semibold text-danger">删除操作员</h3>
            </ModalHeader>
            <ModalBody>
              {operatorToDelete && (
                <div className="space-y-3">
                  <p className="text-default-600">
                    确定要删除操作员 <span className="font-semibold text-danger">"{operatorToDelete.myCallsign}"</span> 吗？
                  </p>
                  <div className="p-3 bg-warning-50 border border-warning-200 rounded-lg">
                    <p className="text-warning-700 text-sm">
                      ⚠️ 此操作无法撤销，删除后该操作员的所有配置将丢失。
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
                取消
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
                确认删除
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>

        {/* 同步配置弹窗 */}
        <SyncConfigModal
          isOpen={isSyncModalOpen}
          onClose={() => setIsSyncModalOpen(false)}
          callsign={syncModalCallsign}
          initialTab={syncModalInitialTab}
          onSaved={() => refreshSyncSummary(syncModalCallsign)}
        />
      </div>
    );
  }
);

OperatorSettings.displayName = 'OperatorSettings'; 