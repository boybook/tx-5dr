import * as React from 'react';
import { Listbox, ListboxItem } from "@heroui/react";
import { useOperators, useCurrentOperatorId } from '../store/radioStore';
import { api } from '@tx5dr/core';
import type { Selection } from "@heroui/react";

interface AutomationSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AutomationSettingsPanel: React.FC<AutomationSettingsPanelProps> = ({ isOpen, _onClose }) => {
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>('');
  const [selectedKeys, setSelectedKeys] = React.useState<Selection>(new Set());

  const currentOperator = operators.find(op => op.id === currentOperatorId);

  // 初始化选中的选项
  React.useEffect(() => {
    if (currentOperator) {
      const keys = new Set<string>();
      if (currentOperator.context.autoReplyToCQ) keys.add('autoReplyToCQ');
      if (currentOperator.context.autoResumeCQAfterFail) keys.add('autoResumeCQAfterFail');
      if (currentOperator.context.autoResumeCQAfterSuccess) keys.add('autoResumeCQAfterSuccess');
      if (currentOperator.context.replyToWorkedStations) keys.add('replyToWorkedStations');
      if (currentOperator.context.prioritizeNewCalls) keys.add('prioritizeNewCalls');
      setSelectedKeys(keys);
    }
  }, [currentOperator]);

  if (!isOpen) return null;

  if (!currentOperatorId || !currentOperator) {
    return (
      <div className="text-center text-gray-500">
        请先选择一个操作员
      </div>
    );
  }

  const handleSelectionChange = async (keys: Selection) => {
    if (loading) return; // 如果正在加载，不处理选择变化
    
    try {
      setLoading(true);
      setError('');
      
      // 将Selection转换为Set<string>
      const selectedSet = new Set<string>();
      if (typeof keys === 'string') {
        selectedSet.add(keys);
      } else if (keys instanceof Set) {
        keys.forEach(key => selectedSet.add(key.toString()));
      }
      
      // 计算需要更新的值
      const updates = {
        autoReplyToCQ: selectedSet.has('autoReplyToCQ'),
        autoResumeCQAfterFail: selectedSet.has('autoResumeCQAfterFail'),
        autoResumeCQAfterSuccess: selectedSet.has('autoResumeCQAfterSuccess'),
        replyToWorkedStations: selectedSet.has('replyToWorkedStations'),
        prioritizeNewCalls: selectedSet.has('prioritizeNewCalls')
      };
      
      // 使用与OperatorSettings相同的API调用方式
      await api.updateOperator(currentOperatorId, updates);
      setSelectedKeys(keys);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新设置失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      {error && (
        <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg mb-4">
          <p className="text-danger-700 text-sm">{error}</p>
        </div>
      )}
      
      <Listbox
        disallowEmptySelection
        aria-label="自动化设置"
        selectedKeys={selectedKeys}
        selectionMode="multiple"
        variant="flat"
        onSelectionChange={handleSelectionChange}
        className="max-h-[300px] overflow-y-auto"
      >
        <ListboxItem key="autoReplyToCQ">
          自动回复CQ
        </ListboxItem>
        <ListboxItem key="autoResumeCQAfterFail">
          失败后自动恢复CQ
        </ListboxItem>
        <ListboxItem key="autoResumeCQAfterSuccess">
          成功后自动恢复CQ
        </ListboxItem>
        <ListboxItem key="replyToWorkedStations">
          回复已通联电台
        </ListboxItem>
        <ListboxItem key="prioritizeNewCalls">
          优先选择新呼号
        </ListboxItem>
      </Listbox>
    </div>
  );
}; 