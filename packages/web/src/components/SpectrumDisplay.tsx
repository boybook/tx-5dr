import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createLogger } from '../utils/logger';

const logger = createLogger('SpectrumDisplay');
import type { FT8Spectrum } from '@tx5dr/contracts';
import { useConnection, useOperators, useRadioState, useCurrentOperatorId } from '../store/radioStore';
import { WebGLWaterfall } from './WebGLWaterfall';
import type { AutoRangeConfig } from './WebGLWaterfall';
import { useTargetRxFrequencies } from '../hooks/useTargetRxFrequencies';
import { useTxFrequencies } from '../hooks/useTxFrequencies';
import { Button, Popover, PopoverTrigger, PopoverContent, Tabs, Tab, Slider, Input } from '@heroui/react';
import { Cog6ToothIcon, ArrowsPointingOutIcon } from '@heroicons/react/24/outline';
import { useTranslation } from 'react-i18next';

// 瀑布图配置
const WATERFALL_HISTORY = 120; // 保存120个历史数据点
const WATERFALL_UPDATE_INTERVAL = 100;
const SETTINGS_STORAGE_KEY = 'spectrum-range-settings';

// 默认配置
const DEFAULT_AUTO_CONFIG: AutoRangeConfig = {
  updateInterval: 10,
  minPercentile: 15,
  maxPercentile: 99,
  rangeExpansionFactor: 4.0,
};

interface SpectrumDisplayProps {
  className?: string;
  height?: number;
  hoverFrequency?: number | null;
  /** 是否显示"弹出到独立窗口"按钮（仅 Electron 环境生效），独立频谱窗口中应传 false */
  showPopOut?: boolean;
  /** 弹出状态变化时的回调，父组件可据此整体隐藏频谱区块 */
  onPopOutChange?: (isPopedOut: boolean) => void;
  /** 是否显示 TX/RX 频率标记线，默认 true。语音模式下可设为 false */
  showMarkers?: boolean;
}

interface WaterfallData {
  spectrumData: number[][];
  frequencies: number[];
  timeLabels: string[];
}

interface RangeSettings {
  mode: 'auto' | 'manual';
  manual: {
    minDb: number;
    maxDb: number;
  };
  auto: AutoRangeConfig;
}

export const SpectrumDisplay: React.FC<SpectrumDisplayProps> = ({
  className = '',
  height = 200,
  hoverFrequency,
  showPopOut = true,
  onPopOutChange,
  showMarkers = true,
}) => {
  const { t } = useTranslation('common');
  const [spectrum, setSpectrum] = useState<FT8Spectrum | null>(null);
  const [waterfallData, setWaterfallData] = useState<WaterfallData>({
    spectrumData: [],
    frequencies: [],
    timeLabels: []
  });
  const connection = useConnection();
  const { operators } = useOperators();
  const { state: radioState } = useRadioState();
  const isTransmitting = radioState.pttStatus.isTransmitting;
  const lastUpdateRef = useRef<number>(0);
  const pendingDataRef = useRef<FT8Spectrum | null>(null);
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);

  // 弹出到独立窗口
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isElectron = typeof window !== 'undefined' && typeof (window as any).electronAPI !== 'undefined';
  const canPopOut = showPopOut && isElectron;

  // 弹出后此组件会被父层卸载，关窗监听由始终存活的 LeftLayout 负责
  const handlePopOut = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).electronAPI.window.openSpectrumWindow();
      onPopOutChange?.(true);
    } catch (error) {
      logger.error('Failed to open spectrum window:', error);
    }
  }, [onPopOutChange]);

  // 范围设置状态
  const [rangeSettings, setRangeSettings] = useState<RangeSettings>(() => {
    // 从 localStorage 加载设置
    const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        logger.error('Failed to parse saved settings:', e);
      }
    }
    // 默认设置
    return {
      mode: 'auto',
      manual: {
        minDb: -35,
        maxDb: 10,
      },
      auto: DEFAULT_AUTO_CONFIG,
    };
  });

  // 当前实际生效的范围（用于显示）
  const [actualRange, setActualRange] = useState<{ min: number; max: number } | null>(null);

  // 保存设置到 localStorage
  useEffect(() => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(rangeSettings));
  }, [rangeSettings]);

  // 获取所有操作者的通联目标RX频率
  const rxFrequencies = useTargetRxFrequencies();

  // 获取所有操作者的发射TX频率
  const txFrequencies = useTxFrequencies();

  // 处理TX频率拖动更新
  const handleTxFrequencyChange = useCallback((operatorId: string, frequency: number) => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    // 查找对应的操作者
    const operator = operators.find(op => op.id === operatorId);
    if (!operator) return;

    // 发送更新命令到后端
    radioService.setOperatorContext(operatorId, {
      myCall: operator.context.myCall,
      myGrid: operator.context.myGrid,
      targetCallsign: operator.context.targetCall,
      targetGrid: operator.context.targetGrid,
      frequency: Math.round(frequency), // 四舍五入到整数
      reportSent: operator.context.reportSent,
      reportReceived: operator.context.reportReceived,
    });
  }, [connection.state.radioService, operators]);

  // 右键快捷设置当前操作员TX频率
  const { currentOperatorId } = useCurrentOperatorId();
  const handleRightClickSetFrequency = useCallback((frequency: number) => {
    if (currentOperatorId) {
      handleTxFrequencyChange(currentOperatorId, frequency);
    }
  }, [currentOperatorId, handleTxFrequencyChange]);

  // 解码二进制频谱数据
  const decodeSpectrumData = useCallback((spectrum: FT8Spectrum) => {
    const { data, format } = spectrum.binaryData;
    
    // 将base64转换为二进制数组
    const binaryString = atob(data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // 创建Int16Array视图
    const int16Array = new Int16Array(bytes.buffer);
    
    // 还原为dB值
    const { scale = 1, offset = 0 } = format;
    const dbValues = Array.from(int16Array).map(value => value * scale + offset);
    
    return dbValues;
  }, []);

  // 生成频率轴数据
  const generateFrequencyAxis = useCallback((spectrum: FT8Spectrum) => {
    const { min, max } = spectrum.frequencyRange;
    const length = spectrum.binaryData.format.length;
    
    // 生成频率点
    const frequencies = new Array(length);
    for (let i = 0; i < length; i++) {
      frequencies[i] = min + (i * (max - min)) / (length - 1);
    }
    return frequencies;
  }, []);

  // 批量更新瀑布图数据
  const performUpdate = useCallback(() => {
    const newSpectrum = pendingDataRef.current;
    if (!newSpectrum) return;
    
    pendingDataRef.current = null;
    
    const dbValues = decodeSpectrumData(newSpectrum);
    const timeLabel = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS

    setWaterfallData(prev => {
      // 更新频率轴（如果需要）
      const frequencies = prev.frequencies.length === 0 
        ? generateFrequencyAxis(newSpectrum)
        : prev.frequencies;

      // 添加新数据到历史记录
      const spectrumData = [dbValues, ...prev.spectrumData].slice(0, WATERFALL_HISTORY);
      const timeLabels = [timeLabel, ...prev.timeLabels].slice(0, WATERFALL_HISTORY);

      return {
        spectrumData,
        frequencies,
        timeLabels
      };
    });

    setSpectrum(newSpectrum);
  }, [decodeSpectrumData, generateFrequencyAxis]);

  // 更新瀑布图数据（带节流）
  const updateWaterfallData = useCallback((newSpectrum: FT8Spectrum) => {
    const now = Date.now();
    pendingDataRef.current = newSpectrum;
    
    // 如果距离上次更新时间足够长，立即更新
    if (now - lastUpdateRef.current >= WATERFALL_UPDATE_INTERVAL) {
      lastUpdateRef.current = now;
      performUpdate();
    } else {
      // 否则，设置定时器在下一个更新间隔执行
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
      
      const delay = WATERFALL_UPDATE_INTERVAL - (now - lastUpdateRef.current);
      updateTimerRef.current = setTimeout(() => {
        lastUpdateRef.current = Date.now();
        performUpdate();
      }, delay);
    }
  }, [performUpdate]);

  // 订阅频谱数据更新
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;

    // 直接订阅 WSClient 事件
    const wsClient = radioService.wsClientInstance;

    const handleSpectrumData = (newSpectrum: FT8Spectrum) => {
      updateWaterfallData(newSpectrum);
    };

    wsClient.onWSEvent('spectrumData', handleSpectrumData);

    return () => {
      wsClient.offWSEvent('spectrumData', handleSpectrumData);
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
    };
  }, [connection.state.radioService, updateWaterfallData]);

  if (!spectrum || waterfallData.spectrumData.length === 0) {
    return (
      <div className={`relative flex items-center justify-center ${className}`} style={{ height }}>
        <div className="text-default-400">{t('spectrum.waiting')}</div>
        {canPopOut && (
          <Button
            isIconOnly
            size="sm"
            variant="light"
            onPress={handlePopOut}
            className="absolute top-1 right-1 min-w-unit-8 w-8 h-8 text-default-600 hover:text-default-900 dark:text-default-400 dark:hover:text-default-100 hover:bg-black/30 dark:hover:bg-white/20 hover:backdrop-blur-sm transition-all"
            title={t('spectrum.popOut')}
          >
            <ArrowsPointingOutIcon className="w-4 h-4" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      <WebGLWaterfall
        data={waterfallData.spectrumData}
        frequencies={waterfallData.frequencies}
        height={height}
        minDb={rangeSettings.mode === 'manual' ? rangeSettings.manual.minDb : -35}
        maxDb={rangeSettings.mode === 'manual' ? rangeSettings.manual.maxDb : 10}
        autoRange={rangeSettings.mode === 'auto'}
        autoRangeConfig={rangeSettings.auto}
        totalRows={WATERFALL_HISTORY}
        rxFrequencies={showMarkers ? rxFrequencies : []}
        txFrequencies={showMarkers ? txFrequencies : []}
        onTxFrequencyChange={showMarkers ? handleTxFrequencyChange : undefined}
        onRightClickSetFrequency={showMarkers ? handleRightClickSetFrequency : undefined}
        onActualRangeChange={setActualRange}
        hoverFrequency={hoverFrequency}
        isTransmitting={isTransmitting}
        className="bg-transparent"
      />

      {/* 弹出到独立窗口按钮 */}
      {canPopOut && (
        <Button
          isIconOnly
          size="sm"
          variant="light"
          onPress={handlePopOut}
          className="absolute top-1 right-9 min-w-unit-8 w-8 h-8 text-default-600 hover:text-default-900 dark:text-default-400 dark:hover:text-default-100 hover:bg-black/30 dark:hover:bg-white/20 hover:backdrop-blur-sm transition-all"
          title={t('spectrum.popOut')}
        >
          <ArrowsPointingOutIcon className="w-4 h-4" />
        </Button>
      )}

      {/* 设置按钮和 Popover */}
      <Popover placement="bottom-end">
        <PopoverTrigger>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            className="absolute top-1 right-1 min-w-unit-8 w-8 h-8 text-default-600 hover:text-default-900 dark:text-default-400 dark:hover:text-default-100 hover:bg-black/30 dark:hover:bg-white/20 hover:backdrop-blur-sm transition-all"
          >
            <Cog6ToothIcon className="w-4 h-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0">
          <div className="w-full">
            <div className="px-4 py-3 text-sm font-semibold border-b border-divider">
              {t('spectrum.rangeSettings')}
            </div>

            {/* 模式切换 - 使用 Tabs */}
            <div className="px-4 py-3">
              <Tabs
                selectedKey={rangeSettings.mode}
                onSelectionChange={(key) => {
                  const newMode = key as 'auto' | 'manual';
                  setRangeSettings(prev => {
                    // 如果从自动切换到手动，并且有实际范围数据，则使用实际范围
                    if (prev.mode === 'auto' && newMode === 'manual' && actualRange) {
                      return {
                        ...prev,
                        mode: newMode,
                        manual: {
                          minDb: Math.round(actualRange.min),
                          maxDb: Math.round(actualRange.max)
                        }
                      };
                    }
                    return { ...prev, mode: newMode };
                  });
                }}
                fullWidth
                size="sm"
                classNames={{
                  base: "w-full",
                  tabList: "w-full",
                  cursor: "w-full",
                  tab: "w-full",
                  panel: "w-full px-4 py-3"
                }}
              >
                <Tab key="auto" title={t('spectrum.autoMode')}>
                  <div className="space-y-4">
                    <Slider
                      label={t('spectrum.updateInterval')}
                      size="sm"
                      step={1}
                      minValue={1}
                      maxValue={20}
                      value={rangeSettings.auto.updateInterval}
                      onChange={(value) => {
                        setRangeSettings(prev => ({
                          ...prev,
                          auto: { ...prev.auto, updateInterval: value as number }
                        }));
                      }}
                      getValue={(value) => t('spectrum.frames', { count: value as number })}
                    />
                    <Slider
                      label={t('spectrum.minPercentile')}
                      size="sm"
                      step={1}
                      minValue={5}
                      maxValue={50}
                      value={rangeSettings.auto.minPercentile}
                      onChange={(value) => {
                        setRangeSettings(prev => ({
                          ...prev,
                          auto: { ...prev.auto, minPercentile: value as number }
                        }));
                      }}
                      getValue={(value) => `${value}%`}
                    />
                    <Slider
                      label={t('spectrum.maxPercentile')}
                      size="sm"
                      step={1}
                      minValue={90}
                      maxValue={100}
                      value={rangeSettings.auto.maxPercentile}
                      onChange={(value) => {
                        setRangeSettings(prev => ({
                          ...prev,
                          auto: { ...prev.auto, maxPercentile: value as number }
                        }));
                      }}
                      getValue={(value) => `${value}%`}
                    />
                    <Slider
                      label={t('spectrum.expansionFactor')}
                      size="sm"
                      step={0.5}
                      minValue={2}
                      maxValue={8}
                      value={rangeSettings.auto.rangeExpansionFactor}
                      onChange={(value) => {
                        setRangeSettings(prev => ({
                          ...prev,
                          auto: { ...prev.auto, rangeExpansionFactor: value as number }
                        }));
                      }}
                      getValue={(value) => `${(typeof value === 'number' ? value : value[0]).toFixed(1)}x`}
                    />
                  </div>
                </Tab>

                <Tab key="manual" title={t('spectrum.manualMode')}>
                  <div className="space-y-3">
                    <Input
                      label={t('spectrum.minDb')}
                      type="number"
                      size="sm"
                      value={rangeSettings.manual.minDb.toString()}
                      onValueChange={(value) => {
                        const num = parseFloat(value);
                        if (!isNaN(num) && num < rangeSettings.manual.maxDb) {  // 确保 min < max
                          setRangeSettings(prev => ({
                            ...prev,
                            manual: { ...prev.manual, minDb: num }
                          }));
                        }
                      }}
                    />
                    <Input
                      label={t('spectrum.maxDb')}
                      type="number"
                      size="sm"
                      value={rangeSettings.manual.maxDb.toString()}
                      onValueChange={(value) => {
                        const num = parseFloat(value);
                        if (!isNaN(num) && num > rangeSettings.manual.minDb) {  // 确保 max > min
                          setRangeSettings(prev => ({
                            ...prev,
                            manual: { ...prev.manual, maxDb: num }
                          }));
                        }
                      }}
                    />
                  </div>
                </Tab>
              </Tabs>
            </div>

            {/* 当前范围显示 */}
            {actualRange && (
              <div className="px-4 py-3 border-t border-divider">
                <div className="text-xs text-default-400">
                  {t('spectrum.currentRange', { min: actualRange.min.toFixed(1), max: actualRange.max.toFixed(1) })}
                </div>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}; 