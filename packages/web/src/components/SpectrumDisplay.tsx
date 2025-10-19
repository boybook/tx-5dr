import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { FT8Spectrum } from '@tx5dr/contracts';
import { useConnection, useOperators } from '../store/radioStore';
import { WebGLWaterfall } from './WebGLWaterfall';
import { useTargetRxFrequencies } from '../hooks/useTargetRxFrequencies';
import { useTxFrequencies } from '../hooks/useTxFrequencies';

// 瀑布图配置
const WATERFALL_HISTORY = 120; // 保存120个历史数据点
const WATERFALL_UPDATE_INTERVAL = 100;

interface SpectrumDisplayProps {
  className?: string;
  height?: number;
}

interface WaterfallData {
  spectrumData: number[][];
  frequencies: number[];
  timeLabels: string[];
}

export const SpectrumDisplay: React.FC<SpectrumDisplayProps> = ({
  className = '',
  height = 200
}) => {
  const [spectrum, setSpectrum] = useState<FT8Spectrum | null>(null);
  const [waterfallData, setWaterfallData] = useState<WaterfallData>({
    spectrumData: [],
    frequencies: [],
    timeLabels: []
  });
  const connection = useConnection();
  const { operators } = useOperators();
  const lastUpdateRef = useRef<number>(0);
  const pendingDataRef = useRef<FT8Spectrum | null>(null);
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);

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

    const handleSpectrumData = (newSpectrum: FT8Spectrum) => {
      updateWaterfallData(newSpectrum);
    };

    radioService.on('spectrumData', handleSpectrumData);

    return () => {
      radioService.off('spectrumData');
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
    };
  }, [connection.state.radioService, updateWaterfallData]);

  if (!spectrum || waterfallData.spectrumData.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ height }}>
        <div className="text-default-400">等待频谱数据...</div>
      </div>
    );
  }

  return (
    <div className={className}>
      <WebGLWaterfall
        data={waterfallData.spectrumData}
        frequencies={waterfallData.frequencies}
        height={height}
        minDb={-35}
        maxDb={10}
        autoRange={true}
        rxFrequencies={rxFrequencies}
        txFrequencies={txFrequencies}
        onTxFrequencyChange={handleTxFrequencyChange}
        className="bg-transparent"
      />
    </div>
  );
}; 