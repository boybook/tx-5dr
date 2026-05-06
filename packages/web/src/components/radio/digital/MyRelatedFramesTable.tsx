import React, { useState, useEffect, useRef } from 'react';
import { createLogger } from '../../../utils/logger';

const logger = createLogger('MyRelatedFramesTable');
import { FramesTable, FrameGroup, FrameDisplayMessage } from './FramesTable';
import { useSlotPacks, useOperators, useRadioModeState, useConnection, useCurrentOperatorId, useRadioState } from '../../../store/radioStore';
import type { SlotPackFrequencyContext, WSSelectedFrame } from '@tx5dr/contracts';
import { CycleUtils, getBandFromFrequency } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import {
  buildMyRelatedFrameGroups,
  type TransmissionLog,
  upsertTransmissionLog,
} from './MyRelatedFramesTableModel';
import { CLEAR_MY_RELATED_FRAMES_EVENT } from '../../../utils/frameClearEvents';

interface MyRelatedFT8TableProps {
  className?: string;
}

function mergeFrameGroups(groups: FrameGroup[]): FrameGroup[] {
  const byKey = new Map<string, FrameGroup>();
  for (const group of groups) {
    const context = group.frequencyContext;
    const key = [
      group.startMs,
      context?.frequency ?? '',
      context?.mode ?? '',
      context?.band ?? '',
    ].join(':');
    byKey.set(key, group);
  }

  return Array.from(byKey.values())
    .sort((a, b) => a.startMs - b.startMs)
    .slice(-100);
}

function getFrequencySegmentKey(group: FrameGroup): string {
  const context = group.frequencyContext;
  return [
    context?.band || context?.frequency || '',
    context?.mode || '',
    context?.radioMode || '',
  ].join(':');
}

function shouldShowFrequencySegmentHeader(group: FrameGroup, index: number, groups: FrameGroup[]): boolean {
  if (index <= 0) return true;
  return getFrequencySegmentKey(group) !== getFrequencySegmentKey(groups[index - 1]!);
}

export const MyRelatedFramesTable: React.FC<MyRelatedFT8TableProps> = ({ className = '' }) => {
  const { t } = useTranslation('common');
  const slotPacks = useSlotPacks();
  const { operators } = useOperators();
  const { currentMode } = useRadioModeState();
  const radio = useRadioState();
  const connection = useConnection();
  const { currentOperatorId } = useCurrentOperatorId();
  const [myFrameGroups, setMyFrameGroups] = useState<FrameGroup[]>([]);
  const [transmissionLogs, setTransmissionLogs] = useState<TransmissionLog[]>([]);
  const [currentFrequencyContext, setCurrentFrequencyContext] = useState<SlotPackFrequencyContext | undefined>();
  const myFrameGroupsRef = useRef<FrameGroup[]>([]);

  useEffect(() => {
    myFrameGroupsRef.current = myFrameGroups;
  }, [myFrameGroups]);

  useEffect(() => {
    const handleClear = () => {
      setMyFrameGroups([]);
      setTransmissionLogs([]);
      setFrozenFrameGroups([]);
      setRecentSlotGroupKeys([]);
    };

    window.addEventListener(CLEAR_MY_RELATED_FRAMES_EVENT, handleClear);
    return () => {
      window.removeEventListener(CLEAR_MY_RELATED_FRAMES_EVENT, handleClear);
    };
  }, []);

  // 数据固化相关状态
  const [frozenFrameGroups, setFrozenFrameGroups] = useState<FrameGroup[]>([]);
  const [recentSlotGroupKeys, setRecentSlotGroupKeys] = useState<string[]>([]);

  // 监听服务端推送的发射日志
  useEffect(() => {
    const radioService = connection.state.radioService;

    if (!radioService) {
      return;
    }

    // 直接订阅 WSClient 事件
    const wsClient = radioService.wsClientInstance;

    const handleTransmissionLog = (data: {
      operatorId: string;
      time: string;
      message: string;
      frequency: number;
      slotStartMs: number;
      replaceExisting?: boolean;
      frequencyContext?: SlotPackFrequencyContext;
    }) => {
      setTransmissionLogs(prev => {
        return upsertTransmissionLog(prev, {
          ...data,
          frequencyContext: data.frequencyContext ?? currentFrequencyContext,
        });
      });
    };

    wsClient.onWSEvent('transmissionLog', handleTransmissionLog);

    return () => {
      wsClient.offWSEvent('transmissionLog', handleTransmissionLog);
    };
  }, [connection.state.radioService, currentFrequencyContext]);

  // 频率变化时保留右侧历史，仅更新后续消息使用的频率上下文。
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    // 直接订阅 WSClient 事件
    const wsClient = radioService.wsClientInstance;

    const handleFrequencyChanged = (data: SlotPackFrequencyContext) => {
      setCurrentFrequencyContext(data);
      setFrozenFrameGroups(prev => mergeFrameGroups([...prev, ...myFrameGroupsRef.current]));
      setRecentSlotGroupKeys([]);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged' as any, handleFrequencyChanged);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged' as any, handleFrequencyChanged);
    };
  }, [connection.state.radioService]);

  useEffect(() => {
    if (currentFrequencyContext || !radio.state.currentRadioFrequency || !currentMode) {
      return;
    }

    const frequency = radio.state.currentRadioFrequency;
    const band = getBandFromFrequency(frequency);
    setCurrentFrequencyContext({
      frequency,
      mode: currentMode.name,
      ...(band && band !== 'Unknown' && { band }),
      description: `${(frequency / 1_000_000).toFixed(3)} MHz`,
    });
  }, [currentFrequencyContext, radio.state.currentRadioFrequency, currentMode]);

  // 获取所有启用的操作员信息
  const getEnabledOperators = () => {
    return operators.filter(op => op.isActive);
  };

  // 获取所有启用操作员的呼号列表
  const getMyCallsigns = (): string[] => {
    return getEnabledOperators()
      .map(op => op.context?.myCall || '') // 提取每个操作员的呼号
      .filter(call => call.trim() !== ''); // 过滤掉空呼号
  };

  // 获取所有启用的操作员的呼号和网格
  const getCurrentOperators = () => {
    const enabledOperators = getEnabledOperators();
    return enabledOperators.map(op => ({
      myCallsign: op.context?.myCall || '',
      myGrid: op.context?.myGrid || ''
    })).filter(op => op.myCallsign); // 过滤掉没有呼号的操作员
  };

  // 获取所有启用的操作员的目标呼号
  const getCurrentTargetCallsigns = (): string[] => {
    const enabledOperators = getEnabledOperators();
    return enabledOperators
      .map(op => op.context?.targetCall || '')
      .filter(call => call); // 过滤掉空目标呼号
  };

  // 获取当前操作员的目标呼号
  const getCurrentOperatorTargetCallsign = (): string => {
    if (!currentOperatorId) return '';
    const currentOperator = operators.find(op => op.id === currentOperatorId);
    return currentOperator?.context?.targetCall || '';
  };

  // 获取所有启用的操作员的发射周期
  const getCurrentTransmitCycles = (): number[] => {
    const enabledOperators = getEnabledOperators();
    const allCycles = enabledOperators
      .map(op => op.transmitCycles || [0]) // 默认偶数周期发射
      .flat();
    // 去重
    return [...new Set(allCycles)];
  };

  // 获取当前时隙的组键
  const getCurrentSlotGroupKey = (): string | null => {
    if (!currentMode) return null;
    
    const now = Date.now();
    return CycleUtils.generateSlotGroupKey(now, currentMode.slotMs);
  };

  // 固化指定时隙的数据
  const freezeSlotData = (groupKey: string, groupData: FrameGroup) => {
    setFrozenFrameGroups(prev => {
      // 检查是否已经存在该时隙的固化数据
      const existingIndex = prev.findIndex(group => group.time === groupKey);
      
      let updated: FrameGroup[];
      if (existingIndex >= 0) {
        // 更新现有的固化数据
        updated = [...prev];
        updated[existingIndex] = groupData;
      } else {
        // 添加新的固化数据
        updated = [...prev, groupData];
      }
      
      // 按时间排序并只保留最近的100个时隙（避免内存泄漏）
      updated.sort((a, b) => a.startMs - b.startMs);
      if (updated.length > 100) {
        updated = updated.slice(-100);
      }
      
      return updated;
    });
  };

  // 处理SlotPack数据，过滤出与我相关的消息
  useEffect(() => {
    const targetCallsigns = getCurrentTargetCallsigns();
    const operators = getCurrentOperators();
    const myTransmitCycles = getCurrentTransmitCycles();
    if (!currentMode) {
      return;
    }
    
    // 获取当前时隙组键
    const currentGroupKey = getCurrentSlotGroupKey();
    if (!currentGroupKey) {
      return;
    }
    
    // 检测时隙切换，管理最近2个时隙
    if (!recentSlotGroupKeys.includes(currentGroupKey)) {
      const newRecentKeys = [currentGroupKey, ...recentSlotGroupKeys].slice(0, 2);
      
      // 如果有第3个时隙（即最老的时隙），则固化它
      if (recentSlotGroupKeys.length === 2) {
        const slotToFreeze = recentSlotGroupKeys[1]; // 最老的时隙
        const groupDataToFreeze = myFrameGroups.find(group => group.time === slotToFreeze);
        if (groupDataToFreeze) {
          logger.debug(`Freezing slot data: ${slotToFreeze}`);
          freezeSlotData(slotToFreeze, groupDataToFreeze);
        }
      }
      
      // 更新最近时隙列表
      setRecentSlotGroupKeys(newRecentKeys);
    }
    
    const currentSlotGroups = buildMyRelatedFrameGroups({
      slotPacks: slotPacks.state.slotPacks,
      transmissionLogs,
      operators,
      targetCallsigns,
      myTransmitCycles,
      currentMode,
      currentFrequencyContext,
    });

    // 合并固化数据和当前时隙数据
    const allGroups = mergeFrameGroups([...frozenFrameGroups, ...currentSlotGroups]);

    setMyFrameGroups(allGroups);
  }, [slotPacks.state.slotPacks, transmissionLogs, operators, currentMode, currentFrequencyContext, frozenFrameGroups, recentSlotGroupKeys]);

  const buildSelectedFrame = (message: FrameDisplayMessage, group: FrameGroup): WSSelectedFrame | undefined => {
    if (typeof message.db !== 'number' || typeof message.dt !== 'number') {
      return undefined;
    }
    return {
      message: message.message,
      snr: message.db,
      dt: message.dt,
      freq: message.freq,
      slotStartMs: group.startMs,
    };
  };

  const handleRowDoubleClick = (message: FrameDisplayMessage, group: FrameGroup) => {
    const callsign = message.logbookAnalysis?.callsign;
    if (currentOperatorId && callsign && !getMyCallsigns().includes(callsign)) {
      if (connection.state.radioService) {
        connection.state.radioService.sendRequestCall(currentOperatorId, callsign, buildSelectedFrame(message, group));
      }
    }
  };

  return (
    <div className={className}>
      {/* 内容 */}
      {myFrameGroups.length === 0 ? (
        <div className="text-center py-12 cursor-default select-none">
          <div className="text-default-400 mb-2 text-4xl">📞</div>
          <p className="text-default-500 mb-1">{t('myFrames.noRecords')}</p>
          <p className="text-default-400 text-sm">{t('myFrames.hint')}</p>
        </div>
      ) : (
        <FramesTable
          groups={myFrameGroups}
          className="h-full"
          myCallsigns={getMyCallsigns()}
          targetCallsign={getCurrentOperatorTargetCallsign()}
          showLogbookAnalysisVisuals={false}
          onRowDoubleClick={handleRowDoubleClick}
          showGroupHeader
          shouldShowGroupHeader={shouldShowFrequencySegmentHeader}
        />
      )}
    </div>
  );
}; 
