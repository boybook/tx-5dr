import { SpectrumAnalyzer } from './SpectrumAnalyzer.js';
import type { FT8Spectrum } from '@tx5dr/contracts';

/**
 * FFT Worker任务参数
 */
export interface FFTWorkerTask {
  audioData: Float32Array;
  sampleRate: number;
  fftSize: number;
  windowFunction?: 'hann' | 'hamming' | 'blackman' | 'none';
  timestamp: number;
  targetSampleRate: number;
}

/**
 * FFT Worker结果
 */
export interface FFTWorkerResult {
  spectrum: FT8Spectrum;
  processingTime: number;
}

// Worker实例缓存，避免重复创建
let analyzerCache: Map<string, SpectrumAnalyzer> = new Map();

/**
 * 获取或创建SpectrumAnalyzer实例
 */
function getAnalyzer(sampleRate: number, fftSize: number, windowFunction: string): SpectrumAnalyzer {
  const key = `${sampleRate}_${fftSize}_${windowFunction}`;
  
  if (!analyzerCache.has(key)) {
    const analyzer = new SpectrumAnalyzer({
      sampleRate,
      fftSize,
      windowFunction: windowFunction as any,
      overlapRatio: 0 // Worker中不使用重叠，由调度器控制
    });
    analyzerCache.set(key, analyzer);
  }
  
  return analyzerCache.get(key)!;
}

/**
 * FFT Worker主函数
 * 在独立线程中执行FFT分析
 */
export default function fftWorker(task: FFTWorkerTask): FFTWorkerResult {
  const startTime = performance.now();
  
  try {
    // 获取分析器实例
    const analyzer = getAnalyzer(
      task.sampleRate,
      task.fftSize,
      task.windowFunction || 'hann'
    );
    
    // 更新目标采样率配置
    analyzer.updateConfig({
      targetSampleRate: task.targetSampleRate
    });
    
    // 执行FFT分析
    const spectrum = analyzer.analyze(task.audioData);
    
    // 使用任务的时间戳而不是分析时的时间戳
    spectrum.timestamp = task.timestamp;
    
    const processingTime = performance.now() - startTime;
    
    return {
      spectrum,
      processingTime
    };
    
  } catch (error) {
    console.error('FFT Worker执行失败:', error);
    throw error;
  }
} 