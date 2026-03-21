// SyncServiceRegistry.ts - 按呼号管理同步服务实例的注册表

import { WaveLogService } from './WaveLogService.js';
import { QRZService } from './QRZService.js';
import { LoTWService } from './LoTWService.js';
import { ConfigManager } from '../config/config-manager.js';
import type { CallsignSyncConfig, WaveLogConfig, QRZConfig, LoTWConfig } from '@tx5dr/contracts';

/**
 * 同步服务注册表（单例）
 * 按呼号管理 WaveLog / QRZ / LoTW 服务实例
 */
export class SyncServiceRegistry {
  private static instance: SyncServiceRegistry;

  private waveLogServices: Map<string, WaveLogService> = new Map();
  private qrzServices: Map<string, QRZService> = new Map();
  private lotwServices: Map<string, LoTWService> = new Map();

  private constructor() {}

  static getInstance(): SyncServiceRegistry {
    if (!SyncServiceRegistry.instance) {
      SyncServiceRegistry.instance = new SyncServiceRegistry();
    }
    return SyncServiceRegistry.instance;
  }

  /**
   * 从呼号中提取基础呼号（去除前后缀）
   * 与 ConfigManager.normalizeCallsign 保持一致的逻辑
   */
  private normalizeCallsign(callsign: string): string {
    const upper = callsign.toUpperCase().trim();
    if (!upper.includes('/')) return upper;
    const parts = upper.split('/');
    let best = parts[0];
    for (const part of parts) {
      if (part.length > best.length && /[A-Z]/.test(part) && /\d/.test(part)) {
        best = part;
      }
    }
    return best;
  }

  /**
   * 从 ConfigManager 加载所有配置并初始化服务
   */
  initializeAll(): void {
    const configManager = ConfigManager.getInstance();
    const allConfigs = configManager.getAllCallsignSyncConfigs();

    // 清空现有服务实例
    this.waveLogServices.clear();
    this.qrzServices.clear();
    this.lotwServices.clear();

    for (const [callsign, config] of Object.entries(allConfigs)) {
      this.createServicesFromConfig(callsign, config);
    }

    console.log(
      `📋 [SyncServiceRegistry] 已初始化同步服务: ` +
      `WaveLog=${this.waveLogServices.size}, ` +
      `QRZ=${this.qrzServices.size}, ` +
      `LoTW=${this.lotwServices.size}`
    );
  }

  /**
   * 根据配置为指定呼号创建服务实例（有有效配置即创建，无需 enabled 开关）
   */
  private createServicesFromConfig(callsign: string, config: CallsignSyncConfig): void {
    const key = this.normalizeCallsign(callsign);

    if (config.wavelog && config.wavelog.url && config.wavelog.apiKey) {
      this.waveLogServices.set(key, new WaveLogService(config.wavelog));
    }

    if (config.qrz && config.qrz.apiKey) {
      this.qrzServices.set(key, new QRZService(config.qrz));
    }

    if (config.lotw && (config.lotw.username || config.lotw.tqslPath)) {
      this.lotwServices.set(key, new LoTWService(config.lotw));
    }
  }

  /**
   * 获取指定呼号的 WaveLog 服务（已启用才返回，否则 null）
   */
  getWaveLogService(callsign: string): WaveLogService | null {
    const key = this.normalizeCallsign(callsign);
    return this.waveLogServices.get(key) || null;
  }

  /**
   * 获取指定呼号的 QRZ 服务（已启用才返回，否则 null）
   */
  getQRZService(callsign: string): QRZService | null {
    const key = this.normalizeCallsign(callsign);
    return this.qrzServices.get(key) || null;
  }

  /**
   * 获取指定呼号的 LoTW 服务（已启用才返回，否则 null）
   */
  getLoTWService(callsign: string): LoTWService | null {
    const key = this.normalizeCallsign(callsign);
    return this.lotwServices.get(key) || null;
  }

  /**
   * 配置变更时更新或创建服务实例
   */
  updateServicesForCallsign(callsign: string, config: CallsignSyncConfig): void {
    const key = this.normalizeCallsign(callsign);

    // WaveLog：有 url + apiKey 即可
    if (config.wavelog && config.wavelog.url && config.wavelog.apiKey) {
      const existing = this.waveLogServices.get(key);
      if (existing) {
        existing.updateConfig(config.wavelog);
      } else {
        this.waveLogServices.set(key, new WaveLogService(config.wavelog));
      }
    } else {
      this.waveLogServices.delete(key);
    }

    // QRZ：有 apiKey 即可
    if (config.qrz && config.qrz.apiKey) {
      const existing = this.qrzServices.get(key);
      if (existing) {
        existing.updateConfig(config.qrz);
      } else {
        this.qrzServices.set(key, new QRZService(config.qrz));
      }
    } else {
      this.qrzServices.delete(key);
    }

    // LoTW：有 username（下载确认）或 tqslPath（上传）即可
    if (config.lotw && (config.lotw.username || config.lotw.tqslPath)) {
      const existing = this.lotwServices.get(key);
      if (existing) {
        existing.updateConfig(config.lotw);
      } else {
        this.lotwServices.set(key, new LoTWService(config.lotw));
      }
    } else {
      this.lotwServices.delete(key);
    }
  }

  /**
   * 删除指定呼号的所有服务实例
   */
  removeServicesForCallsign(callsign: string): void {
    const key = this.normalizeCallsign(callsign);
    this.waveLogServices.delete(key);
    this.qrzServices.delete(key);
    this.lotwServices.delete(key);
  }
}
