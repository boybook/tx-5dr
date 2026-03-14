import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, ModeDescriptor, SlotInfo } from '@tx5dr/contracts';
import type { SlotClock } from '@tx5dr/core';
import type { WSJTXDecodeWorkQueue } from '../decode/WSJTXDecodeWorkQueue.js';
import type { SlotPackManager } from '../slot/SlotPackManager.js';
import type { SpectrumScheduler } from '../audio/SpectrumScheduler.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import { ConfigManager } from '../config/config-manager.js';
import type { PSKReporterService } from '../services/PSKReporterService.js';
import { ListenerManager } from './ListenerManager.js';
import type { TransmissionPipeline } from './TransmissionPipeline.js';
import type { RadioBridge } from './RadioBridge.js';

export interface ClockCoordinatorDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  slotClock: SlotClock;
  decodeQueue: WSJTXDecodeWorkQueue;
  slotPackManager: SlotPackManager;
  spectrumScheduler: SpectrumScheduler;
  operatorManager: RadioOperatorManager;
  getTransmissionPipeline: () => TransmissionPipeline;
  getRadioBridge: () => RadioBridge;
  getCurrentMode: () => ModeDescriptor;
}

/**
 * 时钟协调子系统
 *
 * 职责：时钟/解码/频谱/SlotPack 事件桥接、PSKReporter 转发
 */
export class ClockCoordinator {
  private lm = new ListenerManager();
  private pskreporterService: PSKReporterService | null = null;

  constructor(private deps: ClockCoordinatorDeps) {}

  setPSKReporterService(service: PSKReporterService | null): void {
    this.pskreporterService = service;
  }

  onModeChanged(mode: ModeDescriptor): void {
    if (this.pskreporterService) {
      this.pskreporterService.setMode(mode.name);
    }
  }

  /**
   * 注册时钟/解码/频谱事件监听器（doStart 时调用）
   */
  setup(): void {
    const {
      engineEmitter, slotClock, decodeQueue, slotPackManager,
      spectrumScheduler, operatorManager,
      getTransmissionPipeline, getRadioBridge, getCurrentMode
    } = this.deps;

    // ─── SlotClock 事件 ────────────────────────────

    this.lm.listen(slotClock, 'slotStart', async (slotInfo: SlotInfo) => {
      console.log(`🎯 [时隙开始] ID: ${slotInfo.id}, 开始时间: ${new Date(slotInfo.startMs).toISOString()}, 相位: ${slotInfo.phaseMs}ms, 漂移: ${slotInfo.driftMs}ms`);

      // 确保PTT在新时隙开始时被停止
      await getTransmissionPipeline().forceStopPTT();

      // 通知 TransmissionPipeline 清空时隙缓存
      getTransmissionPipeline().onSlotStart();

      engineEmitter.emit('slotStart', slotInfo, slotPackManager.getLatestSlotPack());

      // 广播所有操作员的状态更新
      operatorManager.broadcastAllOperatorStatusUpdates();
    });

    this.lm.listen(slotClock, 'encodeStart', (slotInfo: SlotInfo) => {
      const mode = getCurrentMode();
      console.log(`🔧 [编码时机] ID: ${slotInfo.id}, 时间: ${new Date().toISOString()}, 提前量: ${mode.encodeAdvance}ms`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('encodeStart' as any, slotInfo);

      getTransmissionPipeline().onEncodeStart(slotInfo);
    });

    this.lm.listen(slotClock, 'transmitStart', (slotInfo: SlotInfo) => {
      const mode = getCurrentMode();
      console.log(`📡 [目标播放时机] ID: ${slotInfo.id}, 时间: ${new Date().toISOString()}, 延迟: ${mode.transmitTiming}ms`);

      getTransmissionPipeline().onTransmitStart(slotInfo);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('transmitStart' as any, slotInfo);
    });

    this.lm.listen(slotClock, 'subWindow', (slotInfo: SlotInfo, windowIdx: number) => {
      const mode = getCurrentMode();
      const totalWindows = mode.windowTiming?.length || 0;
      console.log(`🔍 [子窗口] 时隙: ${slotInfo.id}, 窗口: ${windowIdx}/${totalWindows}, 开始: ${new Date(slotInfo.startMs).toISOString()}`);
      engineEmitter.emit('subWindow', { slotInfo, windowIdx });
    });

    // ─── DecodeQueue 事件 ──────────────────────────

    this.lm.listen(decodeQueue, 'decodeComplete', (result: Parameters<typeof slotPackManager.processDecodeResult>[0]) => {
      slotPackManager.processDecodeResult(result);
    });

    this.lm.listen(decodeQueue, 'decodeError', (error: Error, request: { slotId: string; windowIdx: number }) => {
      console.error(`💥 [ClockCoordinator] 解码错误: 时隙=${request.slotId}, 窗口=${request.windowIdx}:`, error.message);
      engineEmitter.emit('decodeError', { error, request });
    });

    // ─── SlotPackManager 事件 ──────────────────────

    this.lm.listen(slotPackManager, 'slotPackUpdated', async (slotPack: { slotId: string; startMs: number; frames: Array<{ snr: number; dt: number; freq: number; message: string }>; stats: { totalDecodes: number } }) => {
      console.log(`📦 [ClockCoordinator] 时隙包更新事件: ${slotPack.slotId}`);
      console.log(`   当前状态: ${slotPack.frames.length}个信号, 解码${slotPack.stats.totalDecodes}次`);

      if (slotPack.frames.length > 0) {
        const slotStartTime = new Date(slotPack.startMs);
        for (const frame of slotPack.frames) {
          const utcTime = slotStartTime.toISOString().slice(11, 19).replace(/:/g, '').slice(0, 6);
          if (frame.snr === -999) {
            console.log(` - ${utcTime}  TX  ${frame.dt.toFixed(1).padStart(5)} ${Math.round(frame.freq).toString().padStart(4)} ~  ${frame.message}`);
          } else {
            const snr = frame.snr >= 0 ? ` ${frame.snr}` : `${frame.snr}`;
            const dt = frame.dt.toFixed(1).padStart(5);
            const freq = Math.round(frame.freq).toString().padStart(4);
            console.log(` - ${utcTime} ${snr.padStart(3)} ${dt} ${freq} ~  ${frame.message}`);
          }
        }
      }

      // PSKReporter 上报
      if (this.pskreporterService) {
        const lastFreq = ConfigManager.getInstance().getLastSelectedFrequency();
        const rfFrequency = lastFreq?.frequency ?? 0;
        if (rfFrequency < 1_000_000) {
          console.warn(`⚠️ [PSKReporter] 跳过上报：RF 频率无效 (${rfFrequency} Hz)，请先选择操作频率`);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.pskreporterService.processSlotPack(slotPack as any, rfFrequency);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('slotPackUpdated', slotPack as any);
    });

    // ─── SpectrumScheduler 事件 ────────────────────

    this.lm.listen(spectrumScheduler, 'spectrumReady', () => {
      getRadioBridge().onSpectrumEvent();
    });

    this.lm.listen(spectrumScheduler, 'error', (error: Error) => {
      console.error('📊 [ClockCoordinator] 频谱分析错误:', error);
    });

    // ─── self transmissionLog 事件 ─────────────────

    this.lm.listen(engineEmitter, 'transmissionLog', (data: {
      operatorId: string;
      time: string;
      message: string;
      frequency: number;
      slotStartMs: number;
    }) => {
      const slotId = `slot-${data.slotStartMs}`;
      slotPackManager.addTransmissionFrame(
        slotId,
        data.operatorId,
        data.message,
        data.frequency,
        data.slotStartMs
      );
    });

    console.log(`✅ [ClockCoordinator] 事件监听器已注册 (${this.lm.count} 个)`);
  }

  /**
   * 清理监听器（doStop 时调用）
   */
  teardown(): void {
    this.lm.disposeAll();
    console.log(`✅ [ClockCoordinator] 事件监听器已清理`);
  }
}
