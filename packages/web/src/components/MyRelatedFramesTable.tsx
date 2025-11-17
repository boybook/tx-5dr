import React, { useState, useEffect } from 'react';
import { FramesTable, FrameGroup, FrameDisplayMessage } from './FramesTable';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useSlotPacks, useRadioState, useConnection, useCurrentOperatorId } from '../store/radioStore';
import { FrameMessage } from '@tx5dr/contracts';
import { CycleUtils } from '@tx5dr/core';

interface MyRelatedFT8TableProps {
  className?: string;
}

// 发射日志类型
interface TransmissionLog {
  time: string;
  message: string;
  frequency: number;
  operatorId: string;
  slotStartMs: number;
}

export const MyRelatedFramesTable: React.FC<MyRelatedFT8TableProps> = ({ className = '' }) => {
  const slotPacks = useSlotPacks();
  const radio = useRadioState();
  const connection = useConnection();
  const { currentOperatorId } = useCurrentOperatorId();
  const [myFrameGroups, setMyFrameGroups] = useState<FrameGroup[]>([]);
  const [transmissionLogs, setTransmissionLogs] = useState<TransmissionLog[]>([]);

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
    }) => {
      setTransmissionLogs(prev => {
        // 去重：检查是否已存在完全相同的发射日志
        const isDuplicate = prev.some(log =>
          log.operatorId === data.operatorId &&
          log.slotStartMs === data.slotStartMs &&
          log.message === data.message &&
          log.frequency === data.frequency
        );

        if (isDuplicate) {
          console.warn('⚠️ [MyRelatedFramesTable] 检测到重复的发射日志，已过滤:', data);
          return prev; // 不添加重复的日志
        }

        return [...prev, data];
      });
    };

    wsClient.onWSEvent('transmissionLog', handleTransmissionLog);

    return () => {
      wsClient.offWSEvent('transmissionLog', handleTransmissionLog);
    };
  }, [connection.state.radioService]);

  // 频率变化时清空本地缓存，避免跨频率混杂
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    // 直接订阅 WSClient 事件
    const wsClient = radioService.wsClientInstance;

    const handleFrequencyChanged = () => {
      setMyFrameGroups([]);
      setTransmissionLogs([]);
      setFrozenFrameGroups([]);
      setRecentSlotGroupKeys([]);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged' as any, handleFrequencyChanged);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged' as any, handleFrequencyChanged);
    };
  }, [connection.state.radioService]);

  // 获取所有启用的操作员信息
  const getEnabledOperators = () => {
    return radio.state.operators.filter(op => op.isActive);
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
    const currentOperator = radio.state.operators.find(op => op.id === currentOperatorId);
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
    const currentMode = radio.state.currentMode;
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
      updated.sort((a, b) => a.time.localeCompare(b.time));
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
    const currentMode = radio.state.currentMode;
    
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
          console.log(`🔒 [MyRelatedFramesTable] 固化时隙数据: ${slotToFreeze}`);
          freezeSlotData(slotToFreeze, groupDataToFreeze);
        }
      }
      
      // 更新最近时隙列表
      setRecentSlotGroupKeys(newRecentKeys);
    }
    
    // 只处理当前时隙的数据
    const groupsMap = new Map<string, { messages: FrameDisplayMessage[], cycle: 'even' | 'odd', hasTransmission: boolean }>();
    
    // 处理接收到的消息（只处理最近2个时隙的数据）
    slotPacks.state.slotPacks.forEach(slotPack => {
      const slotGroupKey = CycleUtils.generateSlotGroupKey(slotPack.startMs, currentMode.slotMs);
      
      // 只处理最近2个时隙的数据
      if (!recentSlotGroupKeys.includes(slotGroupKey) && slotGroupKey !== currentGroupKey) {
        return;
      }
      slotPack.frames.forEach((frame: FrameMessage) => {
        const message = frame.message;
        
        // 检查消息是否与任何启用的操作员相关
        const isRelevantToMe = operators.some(({ myCallsign }) => 
          message.includes(myCallsign) ||                    // 消息中包含我的呼号
          message.startsWith(`${myCallsign} `) ||            // 以我的呼号开头
          message.includes(` ${myCallsign} `) ||             // 消息中间包含我的呼号
          message.endsWith(` ${myCallsign}`)                 // 以我的呼号结尾
        ) || targetCallsigns.some(targetCall => 
          targetCall && message.includes(targetCall)         // 消息中包含任何目标呼号
        );
        
        if (!isRelevantToMe) return;
        
        // 检查这条消息是否已经存在于发射日志中
        const isAlreadyInTransmissionLogs = transmissionLogs.some(log => {
          // 检查时间是否匹配（允许1秒的误差）
          const logTime = parseInt(log.time);
          const frameTime = parseInt(new Date(slotPack.startMs).toISOString().slice(11, 19).replace(/:/g, ''));
          const timeDiff = Math.abs(logTime - frameTime);
          
          // 检查消息内容是否匹配
          const messageMatch = log.message === message;
          
          // 检查频率是否匹配（允许1Hz的误差）
          const freqMatch = Math.abs(log.frequency - frame.freq) <= 1;
          
          return timeDiff <= 1 && messageMatch && freqMatch;
        });
        
        // 如果消息已经在发射日志中，跳过
        if (isAlreadyInTransmissionLogs) {
          return;
        }
        
        const slotStartTime = new Date(slotPack.startMs);
        const utcSeconds = slotStartTime.toISOString().slice(11, 19);
        
        // 使用统一的周期计算方法
        const utcSecondsNumber = Math.floor(slotPack.startMs / 1000);
        const cycleNumber = CycleUtils.calculateCycleNumber(utcSecondsNumber, currentMode.slotMs);
        const isEvenCycle = CycleUtils.isEvenCycle(cycleNumber);
        
        // 判断是否是我的发射周期
        const isMyTransmitCycle = myTransmitCycles.includes(cycleNumber);
        
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
        
        const ft8Message: FrameDisplayMessage = {
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
        
        const group = groupsMap.get(groupKey)!;
        group.messages.push(ft8Message);
        
        // 根据是否是我的发射周期设置类型
        if (isMyTransmitCycle) {
          group.hasTransmission = true;
        }
      });
    });

    // 处理我的发射日志（只处理最近2个时隙的数据）
    transmissionLogs.forEach(log => {
      const logTimeMs = log.slotStartMs;
      const logGroupKey = CycleUtils.generateSlotGroupKey(logTimeMs, currentMode.slotMs);
      
      // 只处理最近2个时隙的发射日志
      if (!recentSlotGroupKeys.includes(logGroupKey) && logGroupKey !== currentGroupKey) {
        return;
      }
      
      const groupKey = log.time.slice(0, 6); // HHMMSS
      
      // 使用统一的周期计算方法来计算周期类型
      const utcSecondsNumber = Math.floor(logTimeMs / 1000);
      const cycleNumber = CycleUtils.calculateCycleNumber(utcSecondsNumber, currentMode?.slotMs || 15000);
      const isEvenCycle = CycleUtils.isEvenCycle(cycleNumber);
      
      if (!groupsMap.has(groupKey)) {
        groupsMap.set(groupKey, {
          messages: [],
          cycle: isEvenCycle ? 'even' : 'odd',
          hasTransmission: false
        });
      }
      
      const group = groupsMap.get(groupKey)!;
      group.hasTransmission = true; // 如果有我的发射，则标记为发射类型
      
      const ft8Message: FrameDisplayMessage = {
        utc: log.time.slice(0, 2) + ':' + log.time.slice(2, 4) + ':' + log.time.slice(4, 6),
        db: 'TX',
        dt: '-',
        freq: log.frequency,
        message: log.message
      };
      
      group.messages.push(ft8Message);
    });

    // 转换当前时隙数据为FrameGroup数组
    const currentSlotGroups: FrameGroup[] = Array.from(groupsMap.entries())
      .map(([time, { messages, cycle, hasTransmission }]) => ({
        time,
        messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
        type: hasTransmission ? 'transmit' as const : 'receive' as const,
        cycle
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    // 合并固化数据和当前时隙数据
    const allGroups: FrameGroup[] = [...frozenFrameGroups, ...currentSlotGroups]
      .sort((a, b) => a.time.localeCompare(b.time));

    setMyFrameGroups(allGroups);
  }, [slotPacks.state.slotPacks, transmissionLogs, radio.state.operators, radio.state.currentMode, frozenFrameGroups, recentSlotGroupKeys]);

  // 清空我的通联数据
  const _handleClearMyData = () => {
    setMyFrameGroups([]);
    setTransmissionLogs([]);
    setFrozenFrameGroups([]);
    setRecentSlotGroupKeys([]);
  };

  return (
    <div className={className}>
      {/* 内容 */}
      {myFrameGroups.length === 0 ? (
        <div className="text-center py-12 cursor-default select-none">
          <div className="text-default-400 mb-2 text-4xl">📞</div>
          <p className="text-default-500 mb-1">暂无相关通联记录</p>
          <p className="text-default-400 text-sm">与我有关的消息将在这里显示</p>
        </div>
      ) : (
        <FramesTable
          groups={myFrameGroups}
          className="h-full"
          myCallsigns={getMyCallsigns()}
          targetCallsign={getCurrentOperatorTargetCallsign()}
          showLogbookAnalysisVisuals={false}
        />
      )}
    </div>
  );
}; 
