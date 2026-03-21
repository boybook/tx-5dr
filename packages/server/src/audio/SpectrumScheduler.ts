import { EventEmitter } from 'eventemitter3';
import type { FT8Spectrum } from '@tx5dr/contracts';
import type { AudioBufferProvider } from '@tx5dr/core';
import { SpectrumAnalyzer } from './SpectrumAnalyzer.js';
import { globalEventBus } from '../utils/EventBus.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SpectrumScheduler');

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
  private analyzer: SpectrumAnalyzer | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private sampleRate = 48000; // 默认采样率

  // PTT 状态管理
  private isPTTActive = false;
  private pausedDueToPTT = false;

  // 配置：是否允许发射时频谱分析
  private shouldSpectrumWhileTransmitting?: () => boolean;

  // 性能统计
  private stats = {
    totalAnalyses: 0,
    totalProcessingTime: 0,
    averageProcessingTime: 0,
    errorCount: 0
  };

  constructor(
    config: Partial<SpectrumConfig> = {},
    shouldSpectrumWhileTransmitting?: () => boolean
  ) {
    super();

    this.shouldSpectrumWhileTransmitting = shouldSpectrumWhileTransmitting;

    this.config = {
      analysisInterval: config.analysisInterval ?? 100, // 100ms间隔
      fftSize: config.fftSize ?? 2048,
      windowFunction: config.windowFunction ?? 'hann',
      enabled: config.enabled ?? true,
      targetSampleRate: config.targetSampleRate ?? 6000 // 12kHz降采样到6kHz，覆盖0-3kHz
    };
  }

  /**
   * 初始化调度器
   */
  async initialize(audioProvider: AudioBufferProvider, sampleRate: number): Promise<void> {
    this.audioProvider = audioProvider;
    this.sampleRate = sampleRate;

    if (!this.config.enabled) {
      logger.info('spectrum analysis disabled');
      return;
    }

    // 创建原生 FFT 分析器（替代 Piscina worker）
    this.analyzer = new SpectrumAnalyzer({
      sampleRate: this.sampleRate,
      fftSize: this.config.fftSize,
      windowFunction: this.config.windowFunction,
      targetSampleRate: this.config.targetSampleRate,
    });

    logger.info(`spectrum analyzer started: interval=${this.config.analysisInterval}ms fftSize=${this.config.fftSize} window=${this.config.windowFunction} sampleRate=${this.sampleRate}Hz`);
  }

  /**
   * 启动频谱分析
   */
  start(): void {
    if (!this.config.enabled || this.isRunning || !this.audioProvider || !this.analyzer) {
      return;
    }

    logger.info(`spectrum analysis started, interval=${this.config.analysisInterval}ms`);

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

    logger.info('spectrum analysis stopped');

    this.isRunning = false;
    this.pausedDueToPTT = false; // 重置暂停状态

    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
    }

    this.logStats();
  }

  /**
   * 设置PTT状态
   */
  setPTTActive(active: boolean): void {
    const wasActive = this.isPTTActive;
    this.isPTTActive = active;

    // 读取配置：是否允许发射时频谱分析（默认true保证向后兼容）
    const allowSpectrumWhileTransmitting = this.shouldSpectrumWhileTransmitting?.() ?? true;

    // 只有在配置禁用发射时频谱分析的情况下，才暂停/恢复
    if (!allowSpectrumWhileTransmitting) {
      if (active && !wasActive) {
        // PTT 激活，暂停频谱分析
        logger.debug('PTT active, spectrum analysis paused (transmit spectrum disabled)');
        this.pauseAnalysis();
      } else if (!active && wasActive) {
        // PTT 停止，恢复频谱分析
        logger.debug('PTT stopped, resuming spectrum analysis');
        this.resumeAnalysis();
      }
    } else if (active && !wasActive) {
      logger.debug('PTT active, spectrum analysis continues (transmit spectrum allowed)');
    }
  }

  /**
   * 暂停频谱分析（由于PTT激活）
   */
  private pauseAnalysis(): void {
    if (this.isRunning && !this.pausedDueToPTT) {
      this.pausedDueToPTT = true;
      if (this.analysisTimer) {
        clearInterval(this.analysisTimer);
        this.analysisTimer = null;
      }
      logger.debug('spectrum analysis paused (PTT active)');
    }
  }

  /**
   * 恢复频谱分析（PTT停止）
   */
  private resumeAnalysis(): void {
    if (this.isRunning && this.pausedDueToPTT) {
      this.pausedDueToPTT = false;
      // 重新启动定时分析
      this.analysisTimer = setInterval(() => {
        this.performAnalysis();
      }, this.config.analysisInterval);

      // 立即执行一次分析
      this.performAnalysis();
      logger.debug('spectrum analysis resumed (PTT stopped)');
    }
  }

  /**
   * 执行一次频谱分析
   */
  private async performAnalysis(): Promise<void> {
    if (!this.audioProvider || !this.analyzer || !this.isRunning) {
      return;
    }

    // 读取配置：是否允许发射时频谱分析（默认true保证向后兼容）
    const allowSpectrumWhileTransmitting = this.shouldSpectrumWhileTransmitting?.() ?? true;

    // 只有在配置禁用发射时频谱分析的情况下，才检查PTT状态
    if (!allowSpectrumWhileTransmitting && this.isPTTActive) {
      return;
    }

    try {
      const startTime = performance.now();

      // 计算需要的音频样本数（基于分析间隔）
      const durationMs = this.config.analysisInterval;
      const timestamp = Date.now();

      // 从音频缓冲区获取最新的音频数据
      const startMs = timestamp - durationMs;
      const audioBuffer = await this.audioProvider.getBuffer(startMs, durationMs);

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return;
      }

      // 将ArrayBuffer转换为Float32Array
      const audioData = new Float32Array(audioBuffer);

      // 使用原生 SpectrumAnalyzer 执行 FFT
      const spectrum = await this.analyzer.analyze(audioData);

      const processingTime = performance.now() - startTime;
      this.stats.totalAnalyses++;
      this.stats.totalProcessingTime += processingTime;
      this.stats.averageProcessingTime = this.stats.totalProcessingTime / this.stats.totalAnalyses;

      // 📝 EventBus 优化：双路径策略
      // 原路径 (3层)：SpectrumScheduler → DigitalRadioEngine
      //   - 用途：DigitalRadioEngine 健康检查（每100次采样）
      //   - 事件名：spectrumReady
      // EventBus (2层)：SpectrumScheduler → EventBus → WSServer
      //   - 用途：WebSocket 广播到前端（~6.7Hz 高频）
      //   - 事件名：bus:spectrumData
      //   - 性能：直达，减少33%开销

      this.emit('spectrumReady', spectrum);  // 原路径
      globalEventBus.emit('bus:spectrumData', spectrum);  // EventBus 直达
    } catch (error) {
      logger.error('spectrum analysis failed:', error);
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

    // 重建分析器以应用新配置
    if (this.analyzer) {
      this.analyzer = new SpectrumAnalyzer({
        sampleRate: this.sampleRate,
        fftSize: this.config.fftSize,
        windowFunction: this.config.windowFunction,
        targetSampleRate: this.config.targetSampleRate,
      });
    }

    logger.info('config updated:', newConfig);

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
      isPTTActive: this.isPTTActive,
      pausedDueToPTT: this.pausedDueToPTT,
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
      errorCount: 0
    };
  }

  /**
   * 输出统计信息
   */
  private logStats(): void {
    if (this.stats.totalAnalyses > 0) {
      logger.info(`stats: analyses=${this.stats.totalAnalyses} avgTime=${this.stats.averageProcessingTime.toFixed(2)}ms errors=${this.stats.errorCount}`);
    }
  }

  /**
   * 销毁调度器
   */
  async destroy(): Promise<void> {
    this.stop();
    this.analyzer = null;
    this.removeAllListeners();
    logger.info('spectrum scheduler destroyed');
  }
}
