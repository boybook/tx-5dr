import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Listbox, ListboxItem, Select, SelectItem } from "@heroui/react";
import { useOperators, useCurrentOperatorId } from '../store/radioStore';
import { api } from '@tx5dr/core';
import type { Selection } from "@heroui/react";

interface AutomationSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AutomationSettingsPanel: React.FC<AutomationSettingsPanelProps> = ({ isOpen, onClose: _onClose }) => {
  const { t } = useTranslation('settings');
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string>('');
  const [selectedKeys, setSelectedKeys] = React.useState<Selection>(new Set());

  const currentOperator = operators.find(op => op.id === currentOperatorId);
  const targetPriorityOptions = [
    {
      key: 'dxcc_first',
      label: t('automation.priorityModeDxccFirst'),
      description: t('automation.priorityModeDxccFirstDesc'),
    },
    {
      key: 'balanced',
      label: t('automation.priorityModeBalanced'),
      description: t('automation.priorityModeBalancedDesc'),
    },
    {
      key: 'new_callsign_first',
      label: t('automation.priorityModeNewCallsignFirst'),
      description: t('automation.priorityModeNewCallsignFirstDesc'),
    },
  ] as const;

  // 初始化选中的选项
  React.useEffect(() => {
    if (currentOperator) {
      const keys = new Set<string>();
      if (currentOperator.context.autoReplyToCQ) keys.add('autoReplyToCQ');
      if (currentOperator.context.autoResumeCQAfterFail) keys.add('autoResumeCQAfterFail');
      if (currentOperator.context.autoResumeCQAfterSuccess) keys.add('autoResumeCQAfterSuccess');
      if (currentOperator.context.replyToWorkedStations) keys.add('replyToWorkedStations');
      setSelectedKeys(keys);
    }
  }, [currentOperator]);

  if (!isOpen) return null;

  if (!currentOperatorId || !currentOperator) {
    return (
      <div className="text-center text-gray-500">
        {t('automation.noOperator')}
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
      };
      
      // 使用与OperatorSettings相同的API调用方式
      await api.updateOperator(currentOperatorId, updates);
      setSelectedKeys(keys);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : t('automation.updateFailed'));
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
        aria-label={t('automation.ariaLabel')}
        selectedKeys={selectedKeys}
        selectionMode="multiple"
        variant="flat"
        onSelectionChange={handleSelectionChange}
        className="max-h-[300px] overflow-y-auto"
      >
        <ListboxItem key="autoReplyToCQ">
          {t('automation.autoReplyToCQ')}
        </ListboxItem>
        <ListboxItem key="autoResumeCQAfterFail">
          {t('automation.autoResumeCQAfterFail')}
        </ListboxItem>
        <ListboxItem key="autoResumeCQAfterSuccess">
          {t('automation.autoResumeCQAfterSuccess')}
        </ListboxItem>
        <ListboxItem key="replyToWorkedStations">
          {t('automation.replyToWorkedStations')}
        </ListboxItem>
      </Listbox>

      <div className="mt-4">
        <Select
          label={t('automation.targetSelectionPriorityMode')}
          description={t('automation.targetSelectionPriorityModeDesc')}
          selectedKeys={[
            currentOperator.context.targetSelectionPriorityMode
            || (currentOperator.context.prioritizeNewCalls === false ? 'balanced' : 'dxcc_first')
          ]}
          onSelectionChange={async (keys) => {
            const selected = Array.from(keys as Set<string>)[0];
            if (!selected) {
              return;
            }

            try {
              setLoading(true);
              setError('');
              await api.updateOperator(currentOperatorId, {
                targetSelectionPriorityMode: selected as 'balanced' | 'dxcc_first' | 'new_callsign_first',
                prioritizeNewCalls: selected !== 'balanced',
              });
            } catch (err) {
              setError(err instanceof Error ? err.message : t('automation.updateFailed'));
            } finally {
              setLoading(false);
            }
          }}
        >
          {targetPriorityOptions.map((option) => (
            <SelectItem key={option.key} description={option.description}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
      </div>
    </div>
  );
};
