import Piscina from 'piscina';
import { EventEmitter } from 'eventemitter3';
import type { FT8Spectrum } from '@tx5dr/contracts';
import type { AudioBufferProvider } from '@tx5dr/core';
import type { FFTWorkerTask, FFTWorkerResult } from './fft-worker.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 频谱分析配置
 */
export interface SpectrumConfig {
  /** 分析间隔（毫秒），默认100ms */
  analysisInterval: number;
  /** FFT大小，默认4096 */
  fftSize: number;
  /** 窗口函数，默认'hann' */
  windowFunction: 'hann' | 'hamming' | 'blackman' | 'none';
  /** Worker池大小，默认2 */
  workerPoolSize: number;
  /** 是否启用频谱分析，默认true */
  enabled: boolean;
  /** 目标采样率，默认8000Hz */
  targetSampleRate: number;
}

/**
 * 频谱调度器事件
 */
export interface SpectrumSchedulerEvents {
  spectrumReady: (spectrum: FT8Spectrum) => void;
  error: (error: Error) => void;
}

/**
 * 频谱分析调度器
 * 负责定时从音频缓冲区获取数据并调度FFT分析
 */
export class SpectrumScheduler extends EventEmitter<SpectrumSchedulerEvents> {
  private config: SpectrumConfig;
  private audioProvider: AudioBufferProvider | null = null;
  private workerPool: Piscina | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private sampleRate = 48000; // 默认采样率
  
  // 性能统计
  private stats = {
    totalAnalyses: 0,
    totalProcessingTime: 0,
    averageProcessingTime: 0,
    queuedTasks: 0,
    completedTasks: 0,
    errorCount: 0
  };

  constructor(config: Partial<SpectrumConfig> = {}) {
    super();
    
    this.config = {
      analysisInterval: config.analysisInterval ?? 100, // 100ms间隔
      fftSize: config.fftSize ?? 2048, // 减小FFT大小，因为采样率降低了
      windowFunction: config.windowFunction ?? 'hann',
      workerPoolSize: config.workerPoolSize ?? 2,
      enabled: config.enabled ?? true,
      targetSampleRate: config.targetSampleRate ?? 4000 // 默认8kHz
    };
  }

  /**
   * 初始化调度器
   */
  async initialize(audioProvider: AudioBufferProvider, sampleRate: number): Promise<void> {
    this.audioProvider = audioProvider;
    this.sampleRate = sampleRate;
    
    if (!this.config.enabled) {
      console.log('📊 [频谱调度器] 频谱分析已禁用');
      return;
    }

    // 创建Worker池
    this.workerPool = new Piscina({
      filename: join(__dirname, 'fft-worker.js'),
      maxThreads: this.config.workerPoolSize,
      minThreads: 1,
      idleTimeout: 30000, // 30秒空闲超时
    });

    console.log(`📊 [频谱调度器] 初始化完成:`);
    console.log(`   - 分析间隔: ${this.config.analysisInterval}ms`);
    console.log(`   - FFT大小: ${this.config.fftSize}`);
    console.log(`   - 窗口函数: ${this.config.windowFunction}`);
    console.log(`   - Worker池大小: ${this.config.workerPoolSize}`);
    console.log(`   - 采样率: ${this.sampleRate}Hz`);
  }

  /**
   * 启动频谱分析
   */
  start(): void {
    if (!this.config.enabled || this.isRunning || !this.audioProvider || !this.workerPool) {
      return;
    }

    console.log(`📊 [频谱调度器] 启动频谱分析，间隔: ${this.config.analysisInterval}ms`);
    
    this.isRunning = true;
    this.resetStats();
    
    // 启动定时分析
    this.analysisTimer = setInterval(() => {
      this.performAnalysis();
    }, this.config.analysisInterval);
    
    // 立即执行一次分析
    this.performAnalysis();
  }

  /**
   * 停止频谱分析
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    console.log('📊 [频谱调度器] 停止频谱分析');
    
    this.isRunning = false;
    
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }
    
    this.logStats();
  }

  /**
   * 执行一次频谱分析
   */
  private async performAnalysis(): Promise<void> {
    if (!this.audioProvider || !this.workerPool || !this.isRunning) {
      return;
    }

    try {
      const timestamp = Date.now();
      
      // 计算需要的音频样本数（基于分析间隔）
      const durationMs = this.config.analysisInterval;
      
      // 从音频缓冲区获取最新的音频数据
      const startMs = timestamp - durationMs;
      const audioBuffer = await this.audioProvider.getBuffer(startMs, durationMs);
      
      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return;
      }

      // 将ArrayBuffer转换为Float32Array
      const audioData = new Float32Array(audioBuffer);

      // 如果音频数据不足FFT大小，用零填充
      let processData: Float32Array;
      if (audioData.length < this.config.fftSize) {
        processData = new Float32Array(this.config.fftSize);
        processData.set(audioData);
      } else {
        processData = audioData.slice(-this.config.fftSize);
      }

      // 创建FFT任务
      const task: FFTWorkerTask = {
        audioData: processData,
        sampleRate: this.sampleRate,
        fftSize: this.config.fftSize,
        windowFunction: this.config.windowFunction,
        timestamp,
        targetSampleRate: this.config.targetSampleRate // 添加目标采样率
      };

      this.stats.queuedTasks++;

      const result = await this.workerPool.run(task) as FFTWorkerResult;
      
      this.stats.completedTasks++;
      this.stats.totalAnalyses++;
      this.stats.totalProcessingTime += result.processingTime;
      this.stats.averageProcessingTime = this.stats.totalProcessingTime / this.stats.totalAnalyses;

      this.emit('spectrumReady', result.spectrum);
    } catch (error) {
      console.error('频谱分析失败:', error);
      this.stats.errorCount++;
    }
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<SpectrumConfig>): void {
    const wasRunning = this.isRunning;
    
    if (wasRunning) {
      this.stop();
    }
    
    Object.assign(this.config, newConfig);
    
    console.log('📊 [频谱调度器] 配置已更新:', newConfig);
    
    if (wasRunning && this.config.enabled) {
      this.start();
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): SpectrumConfig {
    return { ...this.config };
  }

  /**
   * 获取性能统计
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      workerPoolStats: this.workerPool ? {
        threads: this.workerPool.threads.length,
        queueSize: this.workerPool.queueSize,
        completed: this.workerPool.completed,
        duration: this.workerPool.duration
      } : null
    };
  }

  /**
   * 重置统计信息
   */
  private resetStats(): void {
    this.stats = {
      totalAnalyses: 0,
      totalProcessingTime: 0,
      averageProcessingTime: 0,
      queuedTasks: 0,
      completedTasks: 0,
      errorCount: 0
    };
  }

  /**
   * 输出统计信息
   */
  private logStats(): void {
    if (this.stats.totalAnalyses > 0) {
      console.log('📊 [频谱调度器] 性能统计:');
      console.log(`   - 总分析次数: ${this.stats.totalAnalyses}`);
      console.log(`   - 平均处理时间: ${this.stats.averageProcessingTime.toFixed(2)}ms`);
      console.log(`   - 队列任务: ${this.stats.queuedTasks}`);
      console.log(`   - 完成任务: ${this.stats.completedTasks}`);
      console.log(`   - 错误次数: ${this.stats.errorCount}`);
    }
  }

  /**
   * 销毁调度器
   */
  async destroy(): Promise<void> {
    this.stop();
    
    if (this.workerPool) {
      await this.workerPool.destroy();
      this.workerPool = null;
    }
    
    this.removeAllListeners();
    console.log('📊 [频谱调度器] 已销毁');
  }
} 