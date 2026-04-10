import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AudioVolumeController');

const DEFAULT_GAIN_DB = -10;
const DEFAULT_GAIN_LINEAR = Math.pow(10, DEFAULT_GAIN_DB / 20);

/**
 * 音量控制子系统
 *
 * 职责：按模式+频段管理音量增益、ConfigManager 持久化、事件广播
 * 模式类别：digital (FT8/FT4) / voice
 * 频段：由 frequencyChanged 事件的 band 字段获取
 */
export class AudioVolumeController {
  private currentBand: string = 'Unknown';
  private currentModeCategory: 'digital' | 'voice' = 'digital';

  constructor(
    private engineEmitter: EventEmitter<DigitalRadioEngineEvents>,
    private audioStreamManager: AudioStreamManager,
    private getEngineMode: () => 'digital' | 'voice',
  ) {}

  /**
   * 设置事件监听，响应频段和模式变化自动切换增益
   * 须在引擎初始化后调用
   */
  setupEventListeners(): void {
    this.engineEmitter.on('frequencyChanged', (data) => {
      const newBand = data.band || 'Unknown';
      if (newBand !== this.currentBand) {
        logger.debug(`Band changed: ${this.currentBand} -> ${newBand}`);
        this.currentBand = newBand;
        this.applyGainForCurrentSlot();
      }
    });

    this.engineEmitter.on('modeChanged', () => {
      const newModeCategory = this.getEngineMode();
      if (newModeCategory !== this.currentModeCategory) {
        logger.debug(`Mode category changed: ${this.currentModeCategory} -> ${newModeCategory}`);
        this.currentModeCategory = newModeCategory;
        this.applyGainForCurrentSlot();
      }
    });
  }

  /**
   * 设置音量增益（线性单位）
   */
  setVolumeGain(gain: number): void {
    logger.debug(`Setting volume gain: ${gain}`);
    this.audioStreamManager.setVolumeGain(gain);
    this.persistAndBroadcast();
  }

  /**
   * 设置音量增益（dB单位）
   */
  setVolumeGainDb(gainDb: number): void {
    logger.debug(`Setting volume gain: ${gainDb.toFixed(1)}dB`);
    this.audioStreamManager.setVolumeGainDb(gainDb);
    this.persistAndBroadcast();
  }

  /**
   * 获取当前音量增益（线性单位）
   */
  getVolumeGain(): number {
    return this.audioStreamManager.getVolumeGain();
  }

  /**
   * 获取当前音量增益（dB单位）
   */
  getVolumeGainDb(): number {
    return this.audioStreamManager.getVolumeGainDb();
  }

  /**
   * 从配置恢复当前槽位的增益（启动时调用）
   * 从 lastEngineMode 和 lastSelectedFrequency.band 初始化当前 modeCategory 和 band
   */
  restoreGainForCurrentSlot(): void {
    const configManager = ConfigManager.getInstance();
    const lastEngineMode = configManager.getLastEngineMode();
    if (lastEngineMode) {
      this.currentModeCategory = lastEngineMode;
    }
    const lastFreq = configManager.getLastSelectedFrequency();
    if (lastFreq?.band) {
      this.currentBand = lastFreq.band;
    }
    this.applyGainForCurrentSlot();
  }

  /**
   * 应用当前模式+频段对应的增益值
   */
  private applyGainForCurrentSlot(): void {
    const configManager = ConfigManager.getInstance();
    const saved = configManager.getVolumeGainForSlot(this.currentModeCategory, this.currentBand);
    const gainDb = saved ? saved.gainDb : DEFAULT_GAIN_DB;
    logger.debug(`Applying gain for ${this.currentModeCategory}_${this.currentBand}: ${gainDb.toFixed(1)}dB`);
    this.audioStreamManager.setVolumeGainDb(gainDb);

    // 广播新增益值
    this.engineEmitter.emit('volumeGainChanged', {
      gain: this.audioStreamManager.getVolumeGain(),
      gainDb: this.audioStreamManager.getVolumeGainDb(),
    });
  }

  private persistAndBroadcast(): void {
    const currentGain = this.audioStreamManager.getVolumeGain();
    const currentGainDb = this.audioStreamManager.getVolumeGainDb();

    // 持久化到按模式+频段的配置
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConfigManager.getInstance().updateVolumeGainForSlot(this.currentModeCategory, this.currentBand, currentGain, currentGainDb).catch((error: any) => {
      logger.warn('Failed to save volume gain config:', error);
    });

    // 广播事件
    this.engineEmitter.emit('volumeGainChanged', {
      gain: currentGain,
      gainDb: currentGainDb
    });
  }
}
