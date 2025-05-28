import React, { useState, useEffect } from 'react';
import { Button } from '@heroui/react';
import { FT8Table, FT8Group, FT8Message } from '../components/FT8Table';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useRadio } from '../store/radioStore';
import type { SlotPack, FT8Frame } from '@tx5dr/contracts';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTrashCan } from '@fortawesome/free-solid-svg-icons';

export const LeftLayout: React.FC = () => {
  const { state, dispatch } = useRadio();
  const [ft8Groups, setFt8Groups] = useState<FT8Group[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());

  // 更新当前时间
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // 处理SlotPack数据转换为FT8Group格式
  useEffect(() => {
    const groupsMap = new Map<string, { messages: FT8Message[], cycle: 'even' | 'odd' }>();
    
    state.slotPacks.forEach(slotPack => {
      slotPack.frames.forEach((frame: FT8Frame) => {
        const slotStartTime = new Date(slotPack.startMs);
        const utcSeconds = slotStartTime.toISOString().slice(11, 19);
        
        // 计算FT8周期：每15秒一个周期
        const seconds = slotStartTime.getSeconds();
        const cycleNumber = Math.floor(seconds / 15);
        const isEvenCycle = cycleNumber % 2 === 0;
        
        // 生成组键：按15秒周期对齐
        const alignedSeconds = Math.floor(seconds / 15) * 15;
        const groupTime = new Date(slotStartTime);
        groupTime.setSeconds(alignedSeconds, 0);
        const groupKey = groupTime.toISOString().slice(11, 19).replace(/:/g, '');
        
        if (!groupsMap.has(groupKey)) {
          groupsMap.set(groupKey, {
            messages: [],
            cycle: isEvenCycle ? 'even' : 'odd'
          });
        }
        
        // 使用统一位置解析函数
        const locationInfo = parseFT8LocationInfo(frame.message);
        
        const message: FT8Message = {
          utc: utcSeconds,
          db: frame.snr,
          dt: frame.dt,
          freq: Math.round(frame.freq),
          message: frame.message,
          ...(locationInfo.country && { country: locationInfo.country }),
          ...(locationInfo.countryZh && { countryZh: locationInfo.countryZh }),
          ...(locationInfo.flag && { flag: locationInfo.flag })
        };
        
        groupsMap.get(groupKey)!.messages.push(message);
      });
    });

    // 转换为FT8Group数组并按时间排序
    const groups: FT8Group[] = Array.from(groupsMap.entries())
      .map(([time, { messages, cycle }]) => ({
        time,
        messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
        type: 'receive' as const,
        cycle
      }))
      .sort((a, b) => a.time.localeCompare(b.time));

    setFt8Groups(groups);
  }, [state.slotPacks]);

  // 清空数据
  const handleClearData = () => {
    dispatch({ type: 'CLEAR_DATA' });
  };

  // 格式化UTC时间
  const formatUTCTime = (date: Date) => {
    return date.toISOString().slice(11, 19); // HH:MM:SS格式
  };

  return (
    <div className="h-screen flex flex-col">
      {/* 顶部空隙和UTC时间/清空按钮 */}
      <div 
        className="flex-shrink-0 flex justify-between items-center p-2 px-3"
        style={{ 
          WebkitAppRegion: 'drag',
        } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        <div></div> {/* 左侧空白 */}
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <Button
            onPress={handleClearData}
            isIconOnly
            variant="light"
            size="sm"
            title="清空数据"
            aria-label="清空FT8数据"
          >
            <FontAwesomeIcon icon={faTrashCan} className="text-default-400" />
          </Button>
          {/* UTC时间显示 */}
          <div className="bg-white rounded-md px-3 py-1">
            <div className="text-xs font-mono text-default-400">
              UTC {formatUTCTime(currentTime)}
            </div>
          </div>
        </div>
      </div>

      {/* FT8解码消息表格 */}
      <div className="flex-1 px-5 pb-5 min-h-0">
        {ft8Groups.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-default-400 mb-2 text-4xl">📡</div>
            <p className="text-default-500 mb-1">暂无FT8解码消息</p>
            <p className="text-default-400 text-sm">
              {!state.isConnected 
                ? '请先连接到TX5DR服务器' 
                : !state.isDecoding 
                  ? '请启动解码引擎' 
                  : '等待FT8信号...'}
            </p>
          </div>
        ) : (
          <FT8Table groups={ft8Groups} className="h-full" />
        )}
      </div>
    </div>
  );
};