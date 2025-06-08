import React, { useState, useEffect } from 'react';
import { FramesTable, FrameGroup, FrameDisplayMessage } from './FramesTable';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useConnection, useRadioState, useSlotPacks } from '../store/radioStore';
import type { FrameMessage } from '@tx5dr/contracts';
import { CycleType } from '@tx5dr/contracts';

interface SlotPacksMessageDisplayProps {
  className?: string;
}

export const SlotPacksMessageDisplay: React.FC<SlotPacksMessageDisplayProps> = ({ className = '' }) => {
  const connection = useConnection();
  const radio = useRadioState();
  const slotPacks = useSlotPacks();
  const [frameGroups, setFrameGroups] = useState<FrameGroup[]>([]);

  // 处理SlotPack数据转换为FT8Group格式
  useEffect(() => {
    const groupsMap = new Map<string, { messages: FrameDisplayMessage[], cycle: 'even' | 'odd' }>();
    const currentMode = radio.state.currentMode;
    
    if (!currentMode) {
      return;
    }
    
    slotPacks.state.slotPacks.forEach(slotPack => {
      slotPack.frames.forEach((frame: FrameMessage) => {
        const slotStartTime = new Date(slotPack.startMs);
        const utcSeconds = slotStartTime.toISOString().slice(11, 19);
        
        // 根据模式配置计算周期
        const totalSeconds = slotStartTime.getHours() * 3600 + 
                           slotStartTime.getMinutes() * 60 + 
                           slotStartTime.getSeconds();
        const cycleNumber = Math.floor(totalSeconds / (currentMode.slotMs / 1000));
        
        // 根据周期类型决定是even还是odd
        let isEvenCycle = true;
        if (currentMode.cycleType === CycleType.EVEN_ODD) {
          isEvenCycle = cycleNumber % 2 === 0;
        } else if (currentMode.cycleType === CycleType.CONTINUOUS) {
          // 对于连续周期，我们仍然需要区分显示，这里使用周期号除以2的余数
          // 这样可以保持视觉上的交替效果
          isEvenCycle = Math.floor(cycleNumber / 2) % 2 === 0;
        }
        
        // 生成组键：按时隙对齐
        const alignedSeconds = Math.floor(totalSeconds / (currentMode.slotMs / 1000)) * (currentMode.slotMs / 1000);
        const groupTime = new Date(slotStartTime);
        groupTime.setHours(Math.floor(alignedSeconds / 3600));
        groupTime.setMinutes(Math.floor((alignedSeconds % 3600) / 60));
        groupTime.setSeconds(alignedSeconds % 60);
        const groupKey = groupTime.toISOString().slice(11, 19).replace(/:/g, '');
        
        if (!groupsMap.has(groupKey)) {
          groupsMap.set(groupKey, {
            messages: [],
            cycle: isEvenCycle ? 'even' : 'odd'
          });
        }
        
        // 使用统一位置解析函数
        const locationInfo = parseFT8LocationInfo(frame.message);
        
        const message: FrameDisplayMessage = {
          utc: utcSeconds,
          db: frame.snr,
          dt: frame.dt,
          freq: Math.round(frame.freq),
          message: frame.message,
          ...(locationInfo.country && { country: locationInfo.country }),
          ...(locationInfo.countryZh && { countryZh: locationInfo.countryZh }),
          ...(locationInfo.flag && { flag: locationInfo.flag }),
          ...(frame.logbookAnalysis && { logbookAnalysis: frame.logbookAnalysis })
        };
        
        groupsMap.get(groupKey)!.messages.push(message);
      });
    });

    // 转换为FT8Group数组并按时间排序
    const groups: FrameGroup[] = Array.from(groupsMap.entries())
      .map(([time, { messages, cycle }]) => ({
        time,
        messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
        type: 'receive' as const,
        cycle
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    setFrameGroups(groups);
  }, [slotPacks.state.slotPacks, radio.state.currentMode]);

  if (frameGroups.length === 0) {
    return (
      <div className="text-center py-12 cursor-default select-none">
        <div className="text-default-400 mb-2 text-4xl">📡</div>
        <p className="text-default-500 mb-1">暂无解码消息</p>
        <p className="text-default-400 text-sm">
          {!connection.state.isConnected 
            ? '请先连接到TX5DR服务器' 
            : !radio.state.isDecoding 
              ? '请启动解码引擎' 
              : '等待信号...'}
        </p>
      </div>
    );
  }

  return <FramesTable groups={frameGroups} className={className} />;
}; 