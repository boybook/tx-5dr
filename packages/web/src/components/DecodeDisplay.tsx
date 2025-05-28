import React, { useState, useEffect } from 'react';
import { 
  Card, 
  CardBody, 
  CardHeader, 
  Badge,
  Button,
  Chip,
  Divider
} from '@heroui/react';
import { FT8Table, FT8Group, FT8Message } from './FT8Table';
import { parseFT8LocationInfo } from '@tx5dr/core';
import { useRadio } from '../store/radioStore';
import type { SlotPack, FT8Frame } from '@tx5dr/contracts';

interface DecodeDisplayProps {
  slotPacks?: SlotPack[]; // 可选，如果不提供则使用store中的数据
}

export const DecodeDisplay: React.FC<DecodeDisplayProps> = ({ slotPacks: propSlotPacks }) => {
  const { state } = useRadio();
  const [ft8Groups, setFt8Groups] = useState<FT8Group[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);

  // 使用props中的slotPacks或store中的数据
  const slotPacks = propSlotPacks || state.slotPacks;

  useEffect(() => {
    // 将SlotPack数据转换为FT8Group格式，按15秒周期分组
    const groupsMap = new Map<string, { messages: FT8Message[], cycle: 'even' | 'odd' }>();
    let messageCount = 0;
    
    slotPacks.forEach(slotPack => {
      slotPack.frames.forEach((frame: FT8Frame) => {
        const slotStartTime = new Date(slotPack.startMs);
        const utcSeconds = slotStartTime.toISOString().slice(11, 19); // HH:MM:SS格式
        
        // 计算FT8周期：每15秒一个周期，从每分钟的0秒开始
        // 0-14秒为第一个周期，15-29秒为第二个周期，30-44秒为第三个周期，45-59秒为第四个周期
        const seconds = slotStartTime.getSeconds();
        const cycleNumber = Math.floor(seconds / 15);
        const isEvenCycle = cycleNumber % 2 === 0;
        
        // 生成组键：HHMMSS格式，但按15秒周期对齐
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
        
        // 使用新的统一位置解析函数
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
        messageCount++;
      });
    });

    // 转换为FT8Group数组并按时间排序
    const groups: FT8Group[] = Array.from(groupsMap.entries())
      .map(([time, { messages, cycle }]) => ({
        time,
        messages: messages.sort((a, b) => a.utc.localeCompare(b.utc)),
        type: 'receive' as const, // 目前都是接收消息，后续可以根据实际情况判断
        cycle
      }))
      .sort((a, b) => a.time.localeCompare(b.time)); // 最旧的在前，最新的在后

    setFt8Groups(groups);
    setTotalMessages(messageCount);
  }, [slotPacks]);

  // 连接到服务器
  const handleConnect = async () => {
    if (!state.radioService) return;
    
    setIsConnecting(true);
    try {
      await state.radioService.connect();
    } catch (error) {
      console.error('连接失败:', error);
    } finally {
      setIsConnecting(false);
    }
  };

  // 断开连接
  const handleDisconnect = () => {
    if (state.radioService) {
      state.radioService.disconnect();
    }
  };

  // 启动解码
  const handleStartDecoding = () => {
    if (state.radioService) {
      state.radioService.startDecoding();
    }
  };

  // 停止解码
  const handleStopDecoding = () => {
    if (state.radioService) {
      state.radioService.stopDecoding();
    }
  };

  return (
    <Card>
      <CardHeader className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">FT8 解码消息</h3>
          <Badge content={totalMessages} color="primary" size="sm" aria-label={`${totalMessages}条FT8消息`}>
            <span></span>
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Chip 
            color={state.isConnected ? "success" : "danger"} 
            variant="flat" 
            size="sm"
          >
            {state.isConnected ? "已连接" : "未连接"}
          </Chip>
          <Chip 
            color={state.isDecoding ? "primary" : "default"} 
            variant="flat" 
            size="sm"
          >
            {state.isDecoding ? "解码中" : "待机"}
          </Chip>
        </div>
      </CardHeader>
      <Divider />
      <CardBody>
        {/* 控制按钮 */}
        <div className="mb-4 flex gap-2">
          {!state.isConnected ? (
            <Button 
              size="sm" 
              color="primary" 
              variant="solid"
              onPress={handleConnect}
              isLoading={isConnecting}
            >
              {isConnecting ? '连接中...' : '连接服务器'}
            </Button>
          ) : (
            <Button 
              size="sm" 
              color="danger" 
              variant="flat"
              onPress={handleDisconnect}
            >
              断开连接
            </Button>
          )}
          
          {!state.isDecoding ? (
            <Button 
              size="sm" 
              color="success" 
              variant="flat"
              onPress={handleStartDecoding}
              isDisabled={!state.isConnected}
            >
              启动解码
            </Button>
          ) : (
            <Button 
              size="sm" 
              color="warning" 
              variant="flat"
              onPress={handleStopDecoding}
            >
              停止解码
            </Button>
          )}
        </div>

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
          <FT8Table groups={ft8Groups} className='h-[600px]' />
        )}
        
        {totalMessages > 0 && (
          <div className="mt-4 text-center">
            <span className="text-sm text-default-500">
              共显示 {ft8Groups.length} 个时间段的 {totalMessages} 条FT8消息
            </span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}; 