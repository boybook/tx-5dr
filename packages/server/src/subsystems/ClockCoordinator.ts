import type { EventEmitter } from 'eventemitter3';
import type { DigitalRadioEngineEvents, ModeDescriptor, SlotInfo, SlotPack } from '@tx5dr/contracts';
import { FT8MessageParser, type SlotClock } from '@tx5dr/core';
import type { WSJTXDecodeWorkQueue } from '../decode/WSJTXDecodeWorkQueue.js';
import type { SlotPackManager } from '../slot/SlotPackManager.js';
import type { SpectrumScheduler } from '../audio/SpectrumScheduler.js';
import type { RadioOperatorManager } from '../operator/RadioOperatorManager.js';
import { ConfigManager } from '../config/config-manager.js';
import type { PSKReporterService } from '../services/PSKReporterService.js';
import { ListenerManager } from './ListenerManager.js';
import type { TransmissionPipeline } from './TransmissionPipeline.js';
import type { RadioBridge } from './RadioBridge.js';
import type { CallsignContextTracker } from '../slot/CallsignContextTracker.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ClockCoordinator');

export interface ClockCoordinatorDeps {
  engineEmitter: EventEmitter<DigitalRadioEngineEvents>;
  slotClock: SlotClock;
  decodeQueue: WSJTXDecodeWorkQueue;
  slotPackManager: SlotPackManager;
  spectrumScheduler: SpectrumScheduler;
  operatorManager: RadioOperatorManager;
  callsignTracker: CallsignContextTracker;
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
  private hasSeenFirstSlot = false;
  private decodeTimingWarningEmitted = false;

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
      logger.debug(`slot start id=${slotInfo.id} start=${new Date(slotInfo.startMs).toISOString()} phase=${slotInfo.phaseMs}ms drift=${slotInfo.driftMs}ms`);

      // 在 await 让出控制权之前同步捕获 SlotPack，防止 encodeStart
      // 处理器在 await 间隙通过 addTransmissionFrame 覆盖 lastSlotPack
      const latestSlotPack = slotPackManager.getLatestSlotPack();

      // 确保PTT在新时隙开始时被停止
      await getTransmissionPipeline().forceStopPTT();

      // 停止残留音频 + 清空时隙缓存
      await getTransmissionPipeline().onSlotStart();

      // 时隙边界清理：取消重决策 debounce + 清空编码请求ID映射
      operatorManager.onSlotBoundary();

      engineEmitter.emit('slotStart', slotInfo, latestSlotPack);

      // 广播所有操作员的状态更新
      operatorManager.broadcastAllOperatorStatusUpdates();
    });

    this.lm.listen(slotClock, 'encodeStart', (slotInfo: SlotInfo) => {
      const mode = getCurrentMode();
      logger.debug(`encode start id=${slotInfo.id} time=${new Date().toISOString()} advance=${mode.encodeAdvance}ms`);

      // 检查前一时隙是否有已完成的解码结果
      // 仅在有操作员需要发射时检查（非发射周期无需解码数据做决策）
      // 跳过引擎启动后的第一个时隙（没有前一时隙数据是正常的）
      // 每轮异常只告警一次，解码恢复正常后重置
      if (this.hasSeenFirstSlot && operatorManager.hasActiveTransmissionsInCurrentCycle(slotInfo)) {
        const prevSlotStartMs = slotInfo.startMs - mode.slotMs;
        if (!slotPackManager.hasCompletedDecodes(prevSlotStartMs)) {
          if (!this.decodeTimingWarningEmitted) {
            this.decodeTimingWarningEmitted = true;
            logger.warn(`no decode results for previous slot (startMs=${prevSlotStartMs}) by decision time`);
            engineEmitter.emit('timingWarning', {
              title: 'Decode timing warning',
              text: `No decode results received for previous slot by decision time. Decoding may be lagging behind.`
            });
          }
        } else {
          this.decodeTimingWarningEmitted = false;
        }
      }
      this.hasSeenFirstSlot = true;

      engineEmitter.emit('encodeStart', slotInfo);

      getTransmissionPipeline().onEncodeStart(slotInfo);
    });

    this.lm.listen(slotClock, 'transmitStart', (slotInfo: SlotInfo) => {
      const mode = getCurrentMode();
      logger.debug(`transmit start id=${slotInfo.id} time=${new Date().toISOString()} timing=${mode.transmitTiming}ms`);

      getTransmissionPipeline().onTransmitStart(slotInfo);

      engineEmitter.emit('transmitStart', slotInfo);
    });

    this.lm.listen(slotClock, 'subWindow', (slotInfo: SlotInfo, windowIdx: number) => {
      const mode = getCurrentMode();
      const totalWindows = mode.windowTiming?.length || 0;
      logger.debug(`sub-window slot=${slotInfo.id} window=${windowIdx}/${totalWindows} start=${new Date(slotInfo.startMs).toISOString()}`);
      engineEmitter.emit('subWindow', { slotInfo, windowIdx });
    });

    // ─── DecodeQueue 事件 ──────────────────────────

    this.lm.listen(decodeQueue, 'decodeComplete', (result: Parameters<typeof slotPackManager.processDecodeResult>[0]) => {
      slotPackManager.processDecodeResult(result);
    });

    this.lm.listen(decodeQueue, 'decodeError', (error: Error, request: { slotId: string; windowIdx: number }) => {
      logger.error(`decode error: slot=${request.slotId} window=${request.windowIdx}: ${error.message}`);
      engineEmitter.emit('decodeError', { error, request });
    });

    // ─── SlotPackManager 事件 ──────────────────────

    this.lm.listen(slotPackManager, 'slotPackUpdated', async (slotPack: { slotId: string; startMs: number; frames: Array<{ snr: number; dt: number; freq: number; message: string }>; stats: { totalDecodes: number } }) => {
      logger.debug(`slot pack updated: ${slotPack.slotId} frames=${slotPack.frames.length} decodes=${slotPack.stats.totalDecodes}`);

      // Update callsign context tracker from decoded frames (before downstream consumers)
      this.deps.callsignTracker.updateFromSlotPack(
        slotPack as unknown as SlotPack,
        FT8MessageParser.parseMessage.bind(FT8MessageParser),
      );

      // PSKReporter 上报
      if (this.pskreporterService) {
        const lastFreq = ConfigManager.getInstance().getLastSelectedFrequency();
        const rfFrequency = lastFreq?.frequency ?? 0;
        if (rfFrequency < 1_000_000) {
          logger.warn(`PSKReporter skipping report: RF frequency invalid (${rfFrequency} Hz)`);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.pskreporterService.processSlotPack(slotPack as any, rfFrequency);
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      engineEmitter.emit('slotPackUpdated', slotPack as any);
    });

    // 晚到解码重决策订阅 decode-only 事件，避免被 addTransmissionFrame 的 TX echo
    // slotPackUpdated 错误触发（会把当前 TX 槽的 slotPack 当成上一 RX 槽喂给
    // standard-qso，污染 QSO 上下文——见 2026-04-19 BG5DRB 事故）。
    this.lm.listen(slotPackManager, 'slotPackDecodeUpdated', (slotPack: SlotPack) => {
      operatorManager.reDecideOnLateDecodes(slotPack);
    });

    // ─── SpectrumScheduler 事件 ────────────────────

    this.lm.listen(spectrumScheduler, 'spectrumReady', () => {
      getRadioBridge().onSpectrumEvent();
    });

    this.lm.listen(spectrumScheduler, 'error', (error: Error) => {
      logger.error('spectrum analyzer error:', error);
    });

    // ─── self transmissionLog 事件 ─────────────────

    this.lm.listen(engineEmitter, 'transmissionLog', (data: {
      operatorId: string;
      time: string;
      message: string;
      frequency: number;
      slotStartMs: number;
      replaceExisting?: boolean;
    }) => {
      const slotId = `slot-${data.slotStartMs}`;
      slotPackManager.addTransmissionFrame(
        slotId,
        data.operatorId,
        data.message,
        data.frequency,
        data.slotStartMs,
        data.replaceExisting
      );
    });

    logger.info(`event listeners registered (${this.lm.count})`);
  }

  /**
   * 清理监听器（doStop 时调用）
   */
  teardown(): void {
    this.lm.disposeAll();
    this.hasSeenFirstSlot = false;
    this.decodeTimingWarningEmitted = false;
    logger.info('event listeners disposed');
  }
}
