import React, { useEffect, useState, useRef, useCallback } from 'react';
import type { PlotParams } from 'react-plotly.js';
import type { Data } from 'plotly.js';
import createPlotlyComponent from 'react-plotly.js/factory';
import Plotly from 'plotly.js-dist-min';
import type { FT8Spectrum } from '@tx5dr/contracts';
import { useConnection } from '../store/radioStore';

// 创建Plot组件
const Plot = createPlotlyComponent(Plotly);

// 瀑布图配置
const WATERFALL_HISTORY = 120; // 保存120个历史数据点
const WATERFALL_UPDATE_INTERVAL = 100; // 100ms更新一次

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
  const lastUpdateRef = useRef<number>(0);

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

  // 更新瀑布图数据
  const updateWaterfallData = useCallback((newSpectrum: FT8Spectrum) => {
    const now = Date.now();
    if (now - lastUpdateRef.current < WATERFALL_UPDATE_INTERVAL) {
      return;
    }
    lastUpdateRef.current = now;

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
    };
  }, [connection.state.radioService, updateWaterfallData]);

  if (!spectrum || waterfallData.spectrumData.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`} style={{ height }}>
        <div className="text-default-400">等待频谱数据...</div>
      </div>
    );
  }

  const plotData: Data[] = [{
    type: 'heatmap' as const,
    z: waterfallData.spectrumData,
    x: waterfallData.frequencies,
    y: waterfallData.timeLabels,
    colorscale: [
      [0, '#000020'],    // 深蓝色
      [0.0833, '#000030'],
      [0.1666, '#000050'],
      [0.25, '#000091'],
      [0.3333, '#1E90FF'],
      [0.4166, '#FFFFFF'],
      [0.5, '#FFFF00'],  // 黄色
      [0.5833, '#FE6D16'],
      [0.6666, '#FF0000'], // 红色
      [0.75, '#C60000'],
      [0.8333, '#9F0000'],
      [0.9166, '#750000'],
      [1, '#4A0000'],    // 深红色
    ],
    zmin: -35, // 最小dB值
    zmax: 10,    // 最大dB值
    showscale: false, // 不显示颜色条
  }];

  return (
    <div className={className}>
      <Plot
        data={plotData}
        layout={{
          height,
          autosize: true,
          margin: { t: 0, r: 0, b: 0, l: 0 },
          showlegend: false,
          xaxis: {
            // 使用后端传来的频率范围
            range: [spectrum.frequencyRange.min, spectrum.frequencyRange.max],
            showgrid: false,
            zeroline: false,
            showline: false,
            showticklabels: false,
            fixedrange: true,
          },
          yaxis: {
            showgrid: false,
            zeroline: false,
            showline: false,
            showticklabels: false,
            autorange: 'reversed',
            fixedrange: true,
            range: [WATERFALL_HISTORY, 0],
            dtick: 1,
          },
          plot_bgcolor: 'transparent',
          paper_bgcolor: 'transparent',
        }}
        config={{
          displayModeBar: false,
          responsive: true,
          staticPlot: true,
        }}
        style={{
          width: '100%',
          height: '100%',
        }}
        useResizeHandler={true}
      />
    </div>
  );
}; 