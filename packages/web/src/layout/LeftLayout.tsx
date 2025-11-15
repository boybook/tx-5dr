import React, { useState, useEffect } from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTrashCan, faDesktop } from '@fortawesome/free-solid-svg-icons';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { SpectrumDisplay } from '../components/SpectrumDisplay';
import { SlotPacksMessageDisplay } from '../components/SlotPacksMessageDisplay';
import { RadioMetersDisplay } from '../components/RadioMetersDisplay';
import { useSlotPacks, useRadioState, useConnection } from '../store/radioStore';
import { isElectron } from '../utils/config';

export const LeftLayout: React.FC = () => {
  const slotPacks = useSlotPacks();
  const radio = useRadioState();
  const connection = useConnection();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isMobile, setIsMobile] = useState(false);
  const [hoveredMessageFreq, setHoveredMessageFreq] = useState<number | null>(null);
  const [clientCount, setClientCount] = useState(0);

  // 更新当前时间
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // 监听屏幕宽度变化
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');

    setIsMobile(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  // 订阅客户端数量变化事件
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    const wsClient = radioService.wsClientInstance;

    const handleClientCountChanged = (data: { count: number; timestamp: number }) => {
      setClientCount(data.count);
    };

    wsClient.onWSEvent('clientCountChanged', handleClientCountChanged);

    return () => {
      wsClient.offWSEvent('clientCountChanged', handleClientCountChanged);
    };
  }, [connection.state.radioService]);

  // 清空数据
  const handleClearData = () => {
    slotPacks.dispatch({ type: 'CLEAR_DATA' });
  };

  // 格式化UTC时间
  const formatUTCTime = (date: Date) => {
    return date.toISOString().slice(11, 19); // HH:MM:SS格式
  };

  return (
    <div className="h-full flex flex-col">
      {/* 顶部空隙和UTC时间/清空按钮 */}
      <div
        className="flex-shrink-0 flex justify-between items-center p-1 px-2 md:p-2 md:px-3 cursor-default select-none"
        style={{
          WebkitAppRegion: 'drag',
        } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        {/* 左侧：非Electron环境下显示软件名称 */}
        <div className="flex items-center">
          {!isElectron() && (
            <div className="text-lg font-bold text-foreground cursor-default select-none pl-2 flex items-center gap-1">
              <span className="text-default-800">TX-5DR</span>
              <Button
                onPress={() => window.open('https://github.com/boybook/tx-5dr', '_blank')}
                isIconOnly
                variant="light"
                size="sm"
                title="Github"
                aria-label="Github"
              >
                <FontAwesomeIcon icon={faGithub} className="text-default-400 text-sm" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <Button
            onPress={handleClearData}
            isIconOnly
            variant="light"
            size="sm"
            title="清空数据"
            aria-label="清空数据"
          >
            <FontAwesomeIcon icon={faTrashCan} className="text-default-400" />
          </Button>
          {/* 客户端数量显示（只在大于1个时显示） */}
          {clientCount > 1 && (
            <div className="bg-content1 dark:bg-content2 rounded-md px-3 py-1 flex items-center gap-2">
              <FontAwesomeIcon icon={faDesktop} className="text-default-400 text-xs" />
              <div className="text-xs font-mono text-default-500">
                {clientCount}
              </div>
            </div>
          )}
          {/* UTC时间显示 */}
          <div className="bg-content1 dark:bg-content2 rounded-md px-3 py-1">
            <div className="text-xs font-mono text-default-500">
              UTC {formatUTCTime(currentTime)}
            </div>
          </div>
        </div>
      </div>

      {/* 主要内容区域 */}
      <div className="flex-1 px-2 pb-2 md:px-5 md:pb-5 min-h-0 flex flex-col gap-2 md:gap-4">
        {/* FT8解码消息表格 */}
        <div className="flex-1 min-h-0">
          <SlotPacksMessageDisplay
            className="h-full"
            onMessageHover={setHoveredMessageFreq}
          />
        </div>

        {/* 频谱显示 */}
        <div className="bg-content2 rounded-lg shadow-sm overflow-hidden">
          <SpectrumDisplay
            height={isMobile ? 80 : 128}
            hoverFrequency={hoveredMessageFreq}
          />
        </div>

        {/* 电台数值表（所有连接类型） */}
        {radio.state.radioConnected && (
          <RadioMetersDisplay
            meterData={radio.state.meterData || { swr: null, alc: null, level: null, power: null }}
            isPttActive={radio.state.pttStatus.isTransmitting}
          />
        )}
      </div>
    </div>
  );
};