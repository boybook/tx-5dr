import { EventEmitter } from 'eventemitter3';
import type { AudioInputSignalType, SpectrumFrame } from '@tx5dr/contracts';
import type { AudioBufferProvider } from '@tx5dr/core';
import { SpectrumAnalyzer } from './SpectrumAnalyzer.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SpectrumScheduler');

/**
 * 频谱分析配置
 */
export interface SpectrumConfig {
  /** 分析间隔（毫秒），默认100ms */
  analysisInterval: number;
  /** FFT大小，默认2048 */
  fftSize: number;
  /** 窗口函数，默认 blackmanHarris */
  windowFunction: 'hann' | 'hamming' | 'blackman' | 'blackmanHarris' | 'none';
  /** 是否启用频谱分析，默认true */
  enabled: boolean;
  /** 目标采样率，默认6000Hz */
  targetSampleRate: number;
  /** Display-only IF halo reduction */
  haloReduce: boolean;
}

/**
 * 频谱调度器事件
 */
export interface SpectrumSchedulerEvents {
  spectrumReady: (spectrum: SpectrumFrame) => void;
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
  private subscriptionActive = false;
  private sampleRate = 48000; // 默认采样率

  // PTT 状态管理
  private isPTTActive = false;
  private pausedDueToPTT = false;

  // 配置：是否允许发射时频谱分析
  private shouldSpectrumWhileTransmitting?: () => boolean;
  private inputSignalType: AudioInputSignalType = 'af';
  private readonly baseFftSize: number;
  private readonly baseWindowFunction: SpectrumConfig['windowFunction'];

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
    this.baseFftSize = config.fftSize ?? 2048;
    this.baseWindowFunction = config.windowFunction ?? 'blackmanHarris';

    this.config = {
      analysisInterval: config.analysisInterval ?? 100, // 100ms间隔
      fftSize: this.baseFftSize,
      windowFunction: this.baseWindowFunction,
      enabled: config.enabled ?? true,
      targetSampleRate: config.targetSampleRate ?? 6000, // 12kHz降采样到6kHz，覆盖0-3kHz
      haloReduce: config.haloReduce ?? false,
    };
  }

  /**
   * 初始化调度器
   */
  async initialize(audioProvider: AudioBufferProvider, sampleRate: number): Promise<void> {
    this.setAudioSource(audioProvider, sampleRate);
  }

  /**
   * Updates the RX audio provider/sample rate without changing subscription state.
   */
  setAudioSource(audioProvider: AudioBufferProvider, sampleRate: number): void {
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
      haloReduce: this.config.haloReduce,
    });

    logger.info(`spectrum analyzer started: interval=${this.config.analysisInterval}ms fftSize=${this.config.fftSize} window=${this.config.windowFunction} haloReduce=${this.config.haloReduce} sampleRate=${this.sampleRate}Hz`);
    this.updateTimerState();
  }

  /**
   * Tune audio waterfall FFT for IF demod mode (display only; decode path unchanged).
   */
  setInputSignalType(inputSignalType: AudioInputSignalType | undefined): void {
    const nextType: AudioInputSignalType = inputSignalType === 'icom-12k-if' ? 'icom-12k-if' : 'af';
    if (nextType === this.inputSignalType) {
      return;
    }
    this.inputSignalType = nextType;

    if (nextType === 'icom-12k-if') {
      // Blackman-Harris has much lower sidelobes than Hann — reduces strong-tone "halo".
      this.updateConfig({
        windowFunction: 'blackmanHarris',
        fftSize: this.baseFftSize,
        haloReduce: true,
      });
      logger.info('IF audio waterfall tuning enabled', {
        windowFunction: 'blackmanHarris',
        fftSize: this.baseFftSize,
        haloReduce: true,
      });
      return;
    }

    this.updateConfig({
      windowFunction: this.baseWindowFunction,
      fftSize: this.baseFftSize,
      haloReduce: false,
    });
    logger.info('IF audio waterfall tuning disabled; restored AF spectrum settings', {
      windowFunction: this.baseWindowFunction,
      fftSize: this.baseFftSize,
    });
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
    this.updateTimerState();
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

  setSubscriptionActive(active: boolean): void {
    if (this.subscriptionActive === active) {
      return;
    }

    this.subscriptionActive = active;
    this.updateTimerState();
  }

  /**
   * 暂停频谱分析（由于PTT激活）
   */
  private pauseAnalysis(): void {
    if (this.isRunning && !this.pausedDueToPTT) {
      this.pausedDueToPTT = true;
      this.updateTimerState();
      logger.debug('spectrum analysis paused (PTT active)');
    }
  }

  /**
   * 恢复频谱分析（PTT停止）
   */
  private resumeAnalysis(): void {
    if (this.isRunning && this.pausedDueToPTT) {
      this.pausedDueToPTT = false;
      this.updateTimerState();
      logger.debug('spectrum analysis resumed (PTT stopped)');
    }
  }

  private updateTimerState(): void {
    const shouldRunTimer =
      this.isRunning &&
      this.subscriptionActive &&
      !this.pausedDueToPTT &&
      !!this.audioProvider &&
      !!this.analyzer;

    if (shouldRunTimer && !this.analysisTimer) {
      this.analysisTimer = setInterval(() => {
        this.performAnalysis();
      }, this.config.analysisInterval);
      this.performAnalysis();
      logger.debug('spectrum analysis timer started');
      return;
    }

    if (!shouldRunTimer && this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = null;
      logger.debug('spectrum analysis timer stopped');
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

      // Read enough history to cover one full FFT window after resampling.
      const durationMs = Math.max(
        this.config.analysisInterval,
        Math.ceil((this.config.fftSize / this.config.targetSampleRate) * 1000),
      );
      const timestamp = this.audioProvider.getCurrentTimeMs?.() ?? Date.now();

      // 从音频缓冲区获取最新的音频数据
      const startMs = timestamp - durationMs;
      const audioBuffer = await this.audioProvider.getBuffer(startMs, durationMs);

      if (!audioBuffer || audioBuffer.byteLength === 0) {
        return;
      }

      // 将ArrayBuffer转换为Float32Array
      const audioData = new Float32Array(audioBuffer);

      const spectrum = await this.analyzer.analyze(audioData);

      const processingTime = performance.now() - startTime;
      this.stats.totalAnalyses++;
      this.stats.totalProcessingTime += processingTime;
      this.stats.averageProcessingTime = this.stats.totalProcessingTime / this.stats.totalAnalyses;

      this.emit('spectrumReady', spectrum);
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
        haloReduce: this.config.haloReduce,
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
