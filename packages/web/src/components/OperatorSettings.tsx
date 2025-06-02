import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  Button,
  Input,
  Select,
  SelectItem,
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
  ModalFooter
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faEdit, faTrash, faPlay, faStop, faSave, faTimes } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { 
  RadioOperatorConfig, 
  CreateRadioOperatorRequest,
  UpdateRadioOperatorRequest
} from '@tx5dr/contracts';
import { MODES } from '@tx5dr/contracts';

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
    
    // 编辑状态 - 记录哪些操作员正在编辑中
    const [editingOperators, setEditingOperators] = useState<Set<string>>(new Set());
    const [editFormData, setEditFormData] = useState<Record<string, Partial<RadioOperatorConfig>>>({});
    
    // 新建操作员状态
    const [isCreating, setIsCreating] = useState(false);
    const [newOperatorData, setNewOperatorData] = useState<Partial<CreateRadioOperatorRequest>>({
      myCallsign: '',
      myGrid: '',
      frequency: 1500,
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

    // 暴露给父组件的方法
    useImperativeHandle(ref, () => ({
      hasUnsavedChanges: () => hasChanges,
      save: async () => {
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

    // 处理未保存更改状态
    const updateUnsavedChanges = (hasChanges: boolean) => {
      setHasChanges(hasChanges);
      onUnsavedChanges?.(hasChanges);
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
    const updateEditFormData = (operatorId: string, field: string, value: any) => {
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
        await api.createOperator(newOperatorData as CreateRadioOperatorRequest);
        await loadOperators();
        
        // 重置新建状态
        setIsCreating(false);
        setNewOperatorData({
          myCallsign: '',
          myGrid: '',
          frequency: 1500,
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

    // 渲染展示模式的内容
    const renderDisplayMode = (operator: RadioOperatorConfig) => {
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
              max={10}
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
          <CardHeader className="flex justify-between items-start">
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
          
          <CardBody className='pt-0'>
            {isEditing ? renderEditMode(formData, operator.id) : renderDisplayMode(operator)}
          </CardBody>
        </Card>
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
        <div className="flex justify-between items-center">
          <div>
            <h3 className="text-lg font-semibold">电台操作员管理</h3>
            <p className="text-sm text-default-500 mt-1">
              管理多个电台操作员配置，支持同时运行多个操作员
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

        {error && (
          <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg">
            <p className="text-danger-700 text-sm">{error}</p>
          </div>
        )}

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
      </div>
    );
  }
);

OperatorSettings.displayName = 'OperatorSettings'; 