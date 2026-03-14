import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents } from '@tx5dr/contracts';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import { ConfigManager } from '../config/config-manager.js';

/**
 * 音量控制子系统
 *
 * 职责：音量读写 + ConfigManager 持久化 + 事件广播
 */
export class AudioVolumeController {
  constructor(
    private engineEmitter: EventEmitter<DigitalRadioEngineEvents>,
    private audioStreamManager: AudioStreamManager
  ) {}

  /**
   * 设置音量增益（线性单位）
   */
  setVolumeGain(gain: number): void {
    this.audioStreamManager.setVolumeGain(gain);
    this.persistAndBroadcast();
  }

  /**
   * 设置音量增益（dB单位）
   */
  setVolumeGainDb(gainDb: number): void {
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

  private persistAndBroadcast(): void {
    const currentGain = this.audioStreamManager.getVolumeGain();
    const currentGainDb = this.audioStreamManager.getVolumeGainDb();

    // 持久化到配置
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConfigManager.getInstance().updateLastVolumeGain(currentGain, currentGainDb).catch((error: any) => {
      console.warn('⚠️ [AudioVolumeController] 保存音量增益配置失败:', error);
    });

    // 广播事件
    this.engineEmitter.emit('volumeGainChanged', {
      gain: currentGain,
      gainDb: currentGainDb
    });
  }
}
