import React, { useState, useEffect } from 'react';
import { FramesTable, FrameGroup, FrameDisplayMessage } from './FramesTable';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useConnection, useCurrentOperatorId, useRadioState, useSlotPacks } from '../store/radioStore';
import type { FrameMessage } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';
import { useSplitLayoutActions } from './SplitLayout';
import { useTranslation } from 'react-i18next';

interface SlotPacksMessageDisplayProps {
  className?: string;
  onMessageHover?: (freq: number | null) => void;
}

export const SlotPacksMessageDisplay: React.FC<SlotPacksMessageDisplayProps> = ({ className = '', onMessageHover }) => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const radio = useRadioState();
  const slotPacks = useSlotPacks();
  const [frameGroups, setFrameGroups] = useState<FrameGroup[]>([]);
  const {currentOperatorId} = useCurrentOperatorId();
  const splitLayoutActions = useSplitLayoutActions();

  // 获取所有启用操作员的呼号列表
  const getMyCallsigns = (): string[] => {
    return radio.state.operators
      .filter(op => op.isActive) // 只获取启用的操作员
      .map(op => op.context?.myCall || '') // 提取每个操作员的呼号
      .filter(call => call.trim() !== ''); // 过滤掉空呼号
  };

  // 获取当前操作员的目标呼号
  const getTargetCallsign = (): string => {
    if (!currentOperatorId) return '';
    const currentOperator = radio.state.operators.find(op => op.id === currentOperatorId);
    return currentOperator?.context?.targetCall || '';
  };

  // 处理SlotPack数据转换为FT8Group格式
  useEffect(() => {
    const groupsMap = new Map<string, { messages: FrameDisplayMessage[], cycle: 'even' | 'odd', hasTransmission: boolean }>();
    const currentMode = radio.state.currentMode;
    
    if (!currentMode) {
      return;
    }
    
    slotPacks.state.slotPacks.forEach(slotPack => {
      slotPack.frames.forEach((frame: FrameMessage) => {
        // 跳过自己发射的TX信号
        if (frame.snr === -999) {
          return;
        }

        const slotStartTime = new Date(slotPack.startMs);
        const utcSeconds = slotStartTime.toISOString().slice(11, 19);
        
        // 使用统一的周期计算方法
        const utcSecondsNumber = Math.floor(slotPack.startMs / 1000);
        const cycleNumber = CycleUtils.calculateCycleNumber(utcSecondsNumber, currentMode.slotMs);
        const isEvenCycle = CycleUtils.isEvenCycle(cycleNumber);
        
        // 生成组键：使用统一的组键生成方法
        const groupKey = CycleUtils.generateSlotGroupKey(slotPack.startMs, currentMode.slotMs);
        
        if (!groupsMap.has(groupKey)) {
          groupsMap.set(groupKey, {
            messages: [],
            cycle: isEvenCycle ? 'even' : 'odd',
            hasTransmission: false
          });
        }
        
        // 使用统一位置解析函数
        const locationInfo = parseFT8LocationInfo(frame.message);
        
        const message: FrameDisplayMessage = {
          utc: utcSeconds,
          db: frame.snr === -999 ? 'TX' : frame.snr, // 将发射帧的SNR=-999转换为TX标记
          dt: frame.snr === -999 ? '-' : frame.dt, // 发射帧的dt显示为'-'
          freq: Math.round(frame.freq),
          message: frame.message,
          ...(locationInfo.country && { country: locationInfo.country }),
          ...(locationInfo.countryZh && { countryZh: locationInfo.countryZh }),
          ...(locationInfo.countryEn && { countryEn: locationInfo.countryEn }),
          ...(locationInfo.countryCode && { countryCode: locationInfo.countryCode }),
          ...(locationInfo.flag && { flag: locationInfo.flag }),
          ...(frame.logbookAnalysis && { logbookAnalysis: frame.logbookAnalysis })
        };
        
        const group = groupsMap.get(groupKey)!;
        group.messages.push(message);
        
        // 如果是发射帧，标记这个组有发射
        if (frame.snr === -999) {
          group.hasTransmission = true;
        }
      });
    });

    // 转换为FT8Group数组并按时间排序
    const groups: FrameGroup[] = Array.from(groupsMap.entries())
      .map(([time, { messages, cycle, hasTransmission: _hasTransmission }]) => ({
        time,
        messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
        type: 'receive' as const, // 如果有发射帧，组类型为transmit
        cycle
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    setFrameGroups(groups);
  }, [slotPacks.state.slotPacks, radio.state.currentMode]);


  const handleRowDoubleClick = (message: FrameDisplayMessage, _group: FrameGroup) => {
    const callsign = message.logbookAnalysis?.callsign;
    if (currentOperatorId && callsign && !getMyCallsigns().includes(callsign)) {
      if (connection.state.radioService) {
        connection.state.radioService.sendRequestCall(currentOperatorId, callsign);
        // 在移动端双击后自动切换到"呼叫"tab
        splitLayoutActions?.switchToRight();
      }
    }
  };

  if (frameGroups.length === 0) {
    return (
      <div className="text-center py-12 cursor-default select-none">
        <div className="text-default-400 mb-2 text-4xl">📡</div>
        <p className="text-default-500 mb-1">{t('slotPacks.noMessages')}</p>
        <p className="text-default-400 text-sm">
          {!connection.state.isConnected
            ? t('slotPacks.connectFirst')
            : !radio.state.isDecoding
              ? t('slotPacks.startEngine')
              : t('slotPacks.waitingSignal')}
        </p>
      </div>
    );
  }

  return (
    <FramesTable
      groups={frameGroups}
      className={className}
      myCallsigns={getMyCallsigns()}
      targetCallsign={getTargetCallsign()}
      onRowDoubleClick={handleRowDoubleClick}
      onMessageHover={onMessageHover}
    />
  );
}; 