import React, { useState, useEffect, useRef } from 'react';
import { Badge, Button } from '@heroui/react';
import { FT8Table, FT8Group, FT8Message } from './FT8Table';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useSlotPacks, useRadioState, useConnection } from '../store/radioStore';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import type { FT8Frame } from '@tx5dr/contracts';

interface MyRelatedFT8TableProps {
  className?: string;
}

// 发射日志的本地存储键
const TRANSMISSION_LOGS_STORAGE_KEY = 'tx5dr_transmission_logs';

// 发射日志类型
interface TransmissionLog {
  time: string;
  message: string;
  frequency: number;
  operatorId: string;
  slotStartMs: number;
}

export const MyRelatedFT8Table: React.FC<MyRelatedFT8TableProps> = ({ className = '' }) => {
  const slotPacks = useSlotPacks();
  const radio = useRadioState();
  const connection = useConnection();
  const [myFt8Groups, setMyFt8Groups] = useState<FT8Group[]>([]);
  const [transmissionLogs, setTransmissionLogs] = useState<TransmissionLog[]>([]);

  // 从本地存储加载发射日志
  useEffect(() => {
    const storedLogs = localStorage.getItem(TRANSMISSION_LOGS_STORAGE_KEY);
    if (storedLogs) {
      try {
        const logs = JSON.parse(storedLogs);
        setTransmissionLogs(logs);
      } catch (error) {
        console.error('加载发射日志失败:', error);
      }
    }
  }, []);

  // 保存发射日志到本地存储
  useEffect(() => {
    localStorage.setItem(TRANSMISSION_LOGS_STORAGE_KEY, JSON.stringify(transmissionLogs));
  }, [transmissionLogs]);

  // 监听服务端推送的发射日志
  useEffect(() => {
    const radioService = connection.state.radioService;
    
    if (!radioService) {
      return;
    }
    
    const handleTransmissionLog = (data: {
      operatorId: string;
      time: string;
      message: string;
      frequency: number;
      slotStartMs: number;
    }) => {
      setTransmissionLogs(prev => [...prev, data]);
    };
    
    radioService.on('transmissionLog', handleTransmissionLog);
    
    return () => {
      radioService.off('transmissionLog');
    };
  }, [connection.state.radioService]);

  // 获取当前操作员的呼号和网格
  const getCurrentOperator = () => {
    const firstOperator = radio.state.operators[0];
    return {
      myCallsign: firstOperator?.context?.myCall || '',
      myGrid: firstOperator?.context?.myGrid || ''
    };
  };

  const { myCallsign, myGrid } = getCurrentOperator();

  // 获取当前操作员的目标呼号
  const getCurrentTargetCallsign = (): string => {
    const firstOperator = radio.state.operators[0];
    return firstOperator?.context?.targetCall || '';
  };

  // 处理SlotPack数据，过滤出与我相关的消息
  useEffect(() => {
    const groupsMap = new Map<string, { messages: FT8Message[], cycle: 'even' | 'odd', type: 'receive' | 'transmit' }>();
    const targetCallsign = getCurrentTargetCallsign();
    
    // 获取当前操作员的发射周期配置
    const firstOperator = radio.state.operators[0];
    const myTransmitCycles = firstOperator?.transmitCycles || [0]; // 默认偶数周期发射
    
    // 处理接收到的消息（从SlotPack中过滤）
    slotPacks.state.slotPacks.forEach(slotPack => {
      slotPack.frames.forEach((frame: FT8Frame) => {
        const message = frame.message;
        
        // 检查消息是否与我相关
        const isRelevantToMe = 
          message.includes(myCallsign) ||                    // 消息中包含我的呼号
          (targetCallsign && message.includes(targetCallsign)) || // 消息中包含我的目标呼号
          message.startsWith(`${myCallsign} `) ||            // 以我的呼号开头
          message.includes(` ${myCallsign} `) ||             // 消息中间包含我的呼号
          message.endsWith(` ${myCallsign}`);                // 以我的呼号结尾
        
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
        
        // 计算FT8周期：每15秒一个周期
        const seconds = slotStartTime.getSeconds();
        const cycleNumber = Math.floor(seconds / 15);
        const isEvenCycle = cycleNumber % 2 === 0;
        
        // 判断是否是我的发射周期
        const evenOddCycle = cycleNumber % 2; // 0=偶数周期，1=奇数周期
        const isMyTransmitCycle = myTransmitCycles.includes(evenOddCycle);
        
        // 生成组键：按15秒周期对齐
        const alignedSeconds = Math.floor(seconds / 15) * 15;
        const groupTime = new Date(slotStartTime);
        groupTime.setSeconds(alignedSeconds, 0);
        const groupKey = groupTime.toISOString().slice(11, 19).replace(/:/g, '');
        
        if (!groupsMap.has(groupKey)) {
          groupsMap.set(groupKey, {
            messages: [],
            cycle: isEvenCycle ? 'even' : 'odd',
            type: isMyTransmitCycle ? 'transmit' : 'receive' // 根据是否是我的发射周期设置类型
          });
        }
        
        // 使用统一位置解析函数
        const locationInfo = parseFT8LocationInfo(frame.message);
        
        const ft8Message: FT8Message = {
          utc: utcSeconds,
          db: frame.snr,
          dt: frame.dt,
          freq: Math.round(frame.freq),
          message: frame.message,
          ...(locationInfo.country && { country: locationInfo.country }),
          ...(locationInfo.countryZh && { countryZh: locationInfo.countryZh }),
          ...(locationInfo.flag && { flag: locationInfo.flag })
        };
        
        groupsMap.get(groupKey)!.messages.push(ft8Message);
      });
    });

    // 处理我的发射日志
    transmissionLogs.forEach(log => {
      const groupKey = log.time.slice(0, 6); // HHMMSS
      
      if (!groupsMap.has(groupKey)) {
        // 计算周期类型
        const timeStr = log.time;
        const hours = parseInt(timeStr.slice(0, 2));
        const minutes = parseInt(timeStr.slice(2, 4));
        const seconds = parseInt(timeStr.slice(4, 6));
        const totalSeconds = hours * 3600 + minutes * 60 + seconds;
        const cycleNumber = Math.floor(totalSeconds / 15);
        const isEvenCycle = cycleNumber % 2 === 0;
        
        groupsMap.set(groupKey, {
          messages: [],
          cycle: isEvenCycle ? 'even' : 'odd',
          type: 'transmit' // 我的发射日志始终是transmit类型
        });
      }
      
      const group = groupsMap.get(groupKey)!;
      group.type = 'transmit'; // 如果有我的发射，则标记为发射类型
      
      const ft8Message: FT8Message = {
        utc: log.time,
        db: 'TX',
        dt: '-',
        freq: log.frequency,
        message: log.message
      };
      
      group.messages.push(ft8Message);
    });

    // 转换为FT8Group数组并按时间排序
    const groups: FT8Group[] = Array.from(groupsMap.entries())
      .map(([time, { messages, cycle, type }]) => ({
        time,
        messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
        type,
        cycle
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    setMyFt8Groups(groups);
  }, [slotPacks.state.slotPacks, transmissionLogs, radio.state.operators]);

  // 清空我的通联数据
  const handleClearMyData = () => {
    setMyFt8Groups([]);
    setTransmissionLogs([]);
    localStorage.removeItem(TRANSMISSION_LOGS_STORAGE_KEY);
  };

  return (
    <div className={className}>
      {/* 内容 */}
      {myFt8Groups.length === 0 ? (
        <div className="text-center py-12 cursor-default select-none">
          <div className="text-default-400 mb-2 text-4xl">📞</div>
          <p className="text-default-500 mb-1">暂无相关通联记录</p>
          <p className="text-default-400 text-sm">与我有关的FT8消息将在这里显示</p>
        </div>
      ) : (
        <FT8Table groups={myFt8Groups} className="h-full" />
      )}
    </div>
  );
}; 