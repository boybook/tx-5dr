import React, { useState, useEffect, useRef } from 'react';
import { Badge, Button } from '@heroui/react';
import { FT8Table, FT8Group, FT8Message } from './FT8Table';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useSlotPacks, useRadioState } from '../store/radioStore';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import type { FT8Frame } from '@tx5dr/contracts';

interface MyRelatedFT8TableProps {
  className?: string;
}

export const MyRelatedFT8Table: React.FC<MyRelatedFT8TableProps> = ({ className = '' }) => {
  const slotPacks = useSlotPacks();
  const radio = useRadioState();
  const [myFt8Groups, setMyFt8Groups] = useState<FT8Group[]>([]);
  const [transmissionLogs, setTransmissionLogs] = useState<Array<{
    time: string;
    message: string;
    frequency: number;
    operatorId: string;
  }>>([]);

  // 记录上一次的发射状态
  const previousTransmittingStatesRef = useRef<Map<string, boolean>>(new Map());

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

  // 监听操作员状态变化，检测发射状态改变
  useEffect(() => {
    radio.state.operators.forEach(operator => {
      const previousState = previousTransmittingStatesRef.current.get(operator.id);
      
      // 检测从发射状态到停止发射的变化（发射完成）
      if (previousState === true && !operator.isTransmitting) {
        // 发射完成，记录发射日志
        if (operator.slots && operator.currentSlot) {
          const transmissionMessage = operator.slots[operator.currentSlot as keyof typeof operator.slots];
          if (transmissionMessage) {
            const now = new Date();
            const timeString = now.toISOString().slice(11, 19).replace(/:/g, '');
            
            setTransmissionLogs(prev => [...prev, {
              time: timeString,
              message: transmissionMessage,
              frequency: operator.context.frequency || 1550,
              operatorId: operator.id
            }]);
          }
        }
      }
      
      // 更新当前状态
      previousTransmittingStatesRef.current.set(operator.id, operator.isTransmitting);
    });
  }, [radio.state.operators]);

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
  };

  return (
    <div className={className}>
      {/* 内容 */}
      {myFt8Groups.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-default-400 mb-2 text-4xl">📞</div>
          <p className="text-default-500 mb-1">暂无相关通联记录</p>
          <p className="text-default-400 text-sm">包含你呼号的FT8消息将在这里显示</p>
        </div>
      ) : (
        <FT8Table groups={myFt8Groups} className="h-full" />
      )}
    </div>
  );
}; 