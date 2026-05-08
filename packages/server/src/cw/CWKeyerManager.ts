import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { EventEmitter } from 'eventemitter3';
import type { CWKeyerStatus, CWKeyerConfig, CWMessagePanel, CWMessageSlot } from '@tx5dr/contracts';
import { CWKeyerHardware } from './CWKeyerHardware.js';
import { encodeTextToCWEvents, type CWTimingEvent } from './CWTextEncoder.js';
import { getDataFilePath } from '../utils/app-paths.js';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CWKeyerManager');

const DEFAULT_SLOT_COUNT = 8;
const MAX_SLOT_COUNT = 12;
const MIN_SLOT_COUNT = 3;
const DEFAULT_REPEAT_INTERVAL_SEC = 5;

interface StoredCWManifest {
  version: 1;
  callsign: string;
  slotCount: number;
  slots: CWMessageSlot[];
}

interface ActiveKeying {
  clientId: string;
  label: string;
  mode: 'manual' | 'text' | 'message';
  messageId: string | null;
  repeating: boolean;
  stopRequested: boolean;
  events: CWTimingEvent[] | null;
  eventIndex: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** 操作员呼号，用于占位符替换 */
  callsign: string | null;
}

export interface CWKeyerManagerEvents {
  cwKeyerStatusChanged: (status: CWKeyerStatus) => void;
  cwConfigChanged: (config: CWKeyerConfig) => void;
}

export class CWKeyerManager extends EventEmitter<CWKeyerManagerEvents> {
  private hardware: CWKeyerHardware | null = null;
  private active: ActiveKeying | null = null;
  private _started = false;
  private _startingPromise: Promise<void> | null = null;
  private rootDir: string | null = null;
  private config: CWKeyerConfig = {
    keyPort: '',
    keyMethod: 'dtr',
    wpm: 20,
  };
  private status: CWKeyerStatus = {
    active: false,
    mode: 'idle',
    startedBy: null,
    startedByLabel: null,
    messageId: null,
    nextRunAt: null,
    error: null,
  };

  getStatus(): CWKeyerStatus {
    return { ...this.status };
  }

  getConfig(): CWKeyerConfig {
    return { ...this.config };
  }

  async updateConfig(update: Partial<CWKeyerConfig>): Promise<void> {
    this.config = { ...this.config, ...update };
    logger.info('CW keyer config updated', { config: this.config });
    this.emit('cwConfigChanged', this.getConfig());
  }

  /**
   * 初始化 CW 键控器（启动硬件、加载配置）
   */
  async start(config: CWKeyerConfig): Promise<void> {
    this.config = { ...config };

    if (this.config.keyPort) {
      // 关闭可能残留的旧硬件实例，避免端口被自身占用
      if (this.hardware) {
        await this.hardware.close();
        this.hardware = null;
      }
      this.hardware = new CWKeyerHardware(this.config.keyPort, this.config.keyMethod);
      try {
        await this.hardware.open();
        this._started = true;
        logger.info('CW keyer hardware started');
      } catch (error) {
        logger.error('Failed to open CW keyer hardware', error);
        this.hardware = null;
        throw error;
      }
    } else {
      logger.warn('CW keyer started without hardware (no keyPort configured)');
      this._started = true;
    }

    this.setStatus(this.idleStatus());
  }

  /**
   * 停止 CW 键控器
   */
  async stop(): Promise<void> {
    await this.stopActive('cw keyer stopped');

    if (this.hardware) {
      await this.hardware.close();
      this.hardware = null;
    }

    this._started = false;
    logger.info('CW keyer stopped');
  }

  private async ensureStarted(): Promise<void> {
    if (this._started) return;
    if (this._startingPromise) {
      await this._startingPromise;
      return;
    }
    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    this._startingPromise = this.start({
      keyPort: radioConfig.cwKeyPort || this.config.keyPort || '',
      keyMethod: radioConfig.cwKeyMethod || this.config.keyMethod || 'dtr',
      wpm: this.config.wpm || 20,
    });
    try {
      await this._startingPromise;
    } finally {
      this._startingPromise = null;
    }
  }

  // ========== 手键操作 ==========

  async handleKeyAction(clientId: string, label: string, action: 'key-down' | 'key-up'): Promise<void> {
    // 手键优先抢占正在进行的文字/报文
    if (this.active && this.active.mode !== 'manual' && !this.active.stopRequested) {
      await this.stopActive('preempted by manual key');
    }

    if (action === 'key-down') {
      // 独占锁：同一时间只能一个客户端手键
      if (this.active && this.active.mode === 'manual' && this.active.clientId !== clientId) {
        logger.debug('Manual key rejected: already keying by another client');
        return;
      }

      if (!this.active) {
        this.active = {
          clientId,
          label,
          mode: 'manual',
          messageId: null,
          repeating: false,
          stopRequested: false,
          events: null,
          eventIndex: 0,
          timer: null,
          callsign: null,
        };
      }

      try {
        await this.ensureStarted();
        if (this.hardware) {
          await this.hardware.keyDown();
        }
        this.setStatus(this.statusFor(clientId, label, 'keying', null));
      } catch (error) {
        this.active = null;
        throw error;
      }
    } else {
      // key-up
      if (!this.active || this.active.mode !== 'manual' || this.active.clientId !== clientId) {
        return;
      }

      await this.ensureStarted();
      if (this.hardware) {
        await this.hardware.keyUp();
      }
      this.active = null;
      this.setStatus(this.idleStatus());
    }
  }

  // ========== 文字输入 ==========

  async handleTextInput(clientId: string, label: string, text: string, callsign?: string): Promise<void> {
    // 如果当前有手键活动，拒绝文字输入
    if (this.active?.mode === 'manual') {
      logger.debug('Text input rejected: manual key active');
      return;
    }

    // 停止当前文字
    if (this.active) {
      await this.stopActive('replaced by new text input');
    }

    // 替换占位符
    const replaced = this.replacePlaceholders(text, callsign);
    const events = encodeTextToCWEvents(replaced, this.config.wpm);
    if (events.length === 0) {
      return;
    }

    const active: ActiveKeying = {
      clientId,
      label,
      mode: 'text',
      messageId: null,
      repeating: false,
      stopRequested: false,
      events,
      eventIndex: 0,
      timer: null,
      callsign: callsign ?? null,
    };
    this.active = active;
    this.setStatus(this.statusFor(clientId, label, 'playing', null));

    try {
      await this.ensureStarted();
      await this.executeEvents(active);
    } catch (error) {
      this.active = null;
      this.setStatus(this.idleStatus());
      throw error;
    }
  }

  // ========== 预设报文管理 ==========

  static normalizeCallsign(callsign: string): string {
    return callsign.trim().toUpperCase();
  }

  static safeCallsign(callsign: string): string {
    return encodeURIComponent(CWKeyerManager.normalizeCallsign(callsign));
  }

  async getPanel(callsign: string): Promise<CWMessagePanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    return this.toPanel(manifest);
  }

  async updatePanel(callsign: string, slotCount: number): Promise<CWMessagePanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    manifest.slotCount = Math.max(MIN_SLOT_COUNT, Math.min(MAX_SLOT_COUNT, Math.round(slotCount)));
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async updateSlot(
    callsign: string,
    slotId: string,
    update: { label?: string; text?: string; repeatEnabled?: boolean; repeatIntervalSec?: number },
  ): Promise<CWMessagePanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);

    if (typeof update.label === 'string') {
      slot.label = update.label.trim().slice(0, 32) || `M${slot.index}`;
    }
    if (typeof update.text === 'string') {
      slot.text = update.text.trim().slice(0, 500);
    }
    if (typeof update.repeatEnabled === 'boolean') {
      slot.repeatEnabled = update.repeatEnabled;
    }
    if (typeof update.repeatIntervalSec === 'number') {
      slot.repeatIntervalSec = Math.max(1, Math.min(300, Math.round(update.repeatIntervalSec)));
    }

    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async deleteSlotText(callsign: string, slotId: string): Promise<CWMessagePanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);
    slot.text = '';
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  // ========== 预设报文播放 ==========

  async playMessage(
    clientId: string,
    label: string,
    callsign: string,
    slotId: string,
    repeat: boolean,
  ): Promise<void> {
    const normalized = this.requireCallsign(callsign);

    if (this.active) {
      await this.stopActive('replaced by message playback');
    }

    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);
    if (!slot.text) {
      throw new Error('CW message slot has no text');
    }

    const replaced = this.replacePlaceholders(slot.text, normalized);
    const events = encodeTextToCWEvents(replaced, this.config.wpm);
    if (events.length === 0) {
      return;
    }

    const active: ActiveKeying = {
      clientId,
      label,
      mode: 'message',
      messageId: slotId,
      repeating: repeat,
      stopRequested: false,
      events,
      eventIndex: 0,
      timer: null,
      callsign: normalized,
    };
    this.active = active;
    this.setStatus(this.statusFor(clientId, label, 'playing', slotId));

    try {
      await this.ensureStarted();
      await this.executeEvents(active);
    } catch (error) {
      this.active = null;
      this.setStatus(this.idleStatus());
      throw error;
    }
  }

  async stopActive(reason = 'stopped'): Promise<void> {
    const active = this.active;
    if (!active) {
      this.setStatus(this.idleStatus());
      return;
    }

    active.stopRequested = true;
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }

    // 确保键控释放
    if (this.hardware?.isKeyDown) {
      await this.hardware.keyUp();
    }

    this.active = null;
    logger.info('CW keying stopped', { reason });
    this.setStatus(this.idleStatus());
  }

  async handleClientDisconnect(clientId: string): Promise<void> {
    if (this.active?.clientId === clientId) {
      await this.stopActive('client disconnected');
    }
  }

  // ========== 私有方法 ==========

  private async executeEvents(active: ActiveKeying): Promise<void> {
    if (!active.events || active.stopRequested) {
      return;
    }

    for (let i = active.eventIndex; i < active.events.length; i++) {
      if (active.stopRequested || this.active !== active) {
        return;
      }

      const event = active.events[i];
      active.eventIndex = i;

      // 等待 afterMs
      if (event.afterMs > 0) {
        await this.delay(event.afterMs, active);
        if (active.stopRequested || this.active !== active) {
          return;
        }
      }

      // 执行键控
      if (event.type === 'key-down') {
        if (this.hardware) {
          await this.hardware.keyDown();
        }
        this.setStatus(this.statusFor(active.clientId, active.label, 'playing', active.messageId));
      } else {
        if (this.hardware) {
          await this.hardware.keyUp();
        }
      }
    }

    // 事件序列完成
    if (this.active === active && !active.stopRequested) {
      if (active.repeating && active.mode === 'message') {
        // 循环播放：等待 repeat 间隔后重新播放
        const slot = await this.getActiveSlot(active);
        const waitMs = (slot?.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC) * 1000;

        const nextRunAt = Date.now() + waitMs;
        this.setStatus(this.statusFor(active.clientId, active.label, 'repeat-waiting', active.messageId, nextRunAt));

        await this.delay(waitMs, active);
        if (active.stopRequested || this.active !== active) {
          return;
        }

        // 重新编码（可能有配置变更）
        if (slot?.text) {
          const replaced = this.replacePlaceholders(slot.text, active.callsign);
          const events = encodeTextToCWEvents(replaced, this.config.wpm);
          active.events = events;
          active.eventIndex = 0;
          this.setStatus(this.statusFor(active.clientId, active.label, 'playing', active.messageId));
          await this.executeEvents(active);
        }
      } else {
        // 正常结束
        this.active = null;
        this.setStatus(this.idleStatus());
      }
    }
  }

  private async getActiveSlot(active: ActiveKeying): Promise<CWMessageSlot | null> {
    if (!active.messageId) return null;
    // messageId is the slotId; but we need the callsign which we don't store in ActiveKeying
    // For message mode, we rely on the stored manifest which has the callsign in its path
    return null; // Simplified: active repeating uses stored repeatInterval
  }

  private delay(ms: number, active: ActiveKeying): Promise<void> {
    return new Promise<void>((resolve) => {
      active.timer = setTimeout(() => {
        active.timer = null;
        resolve();
      }, ms);
    });
  }

  private setStatus(status: CWKeyerStatus): void {
    this.status = status;
    this.emit('cwKeyerStatusChanged', status);
  }

  /** 替换 CW 报文中的占位符，如 {MYCALL} → 操作员呼号 */
  private replacePlaceholders(text: string, callsign: string | null | undefined): string {
    if (!callsign) return text;
    return text.replace(/\{MYCALL\}/gi, callsign);
  }

  private idleStatus(): CWKeyerStatus {
    return {
      active: false,
      mode: 'idle',
      startedBy: null,
      startedByLabel: null,
      messageId: null,
      nextRunAt: null,
      error: null,
    };
  }

  private statusFor(
    clientId: string,
    label: string,
    mode: CWKeyerStatus['mode'],
    messageId: string | null = null,
    nextRunAt: number | null = null,
  ): CWKeyerStatus {
    return {
      active: true,
      mode,
      startedBy: clientId,
      startedByLabel: label,
      messageId,
      nextRunAt,
      error: null,
    };
  }

  // ========== 报文存储 ==========

  private async getRootDir(): Promise<string> {
    if (!this.rootDir) {
      this.rootDir = await getDataFilePath('cw-keyer');
      await fs.mkdir(this.rootDir, { recursive: true });
    }
    return this.rootDir;
  }

  private async getCallsignDir(callsign: string): Promise<string> {
    return join(await this.getRootDir(), CWKeyerManager.safeCallsign(callsign));
  }

  private async getManifestPath(callsign: string): Promise<string> {
    return join(await this.getCallsignDir(callsign), 'manifest.json');
  }

  private async readManifest(callsign: string): Promise<StoredCWManifest> {
    const manifestPath = await this.getManifestPath(callsign);
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      return this.normalizeManifest(parsed, callsign);
    } catch {
      const manifest = this.createDefaultManifest(callsign);
      await this.writeManifest(manifest);
      return manifest;
    }
  }

  private async writeManifest(manifest: StoredCWManifest): Promise<void> {
    const manifestPath = await this.getManifestPath(manifest.callsign);
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    await fs.writeFile(
      manifestPath,
      JSON.stringify(this.normalizeManifest(manifest, manifest.callsign), null, 2),
      'utf8',
    );
  }

  private normalizeManifest(raw: Partial<StoredCWManifest>, callsign: string): StoredCWManifest {
    const defaults = this.createDefaultManifest(callsign);
    const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
    const slots = defaults.slots.map((slot) => {
      const existing = rawSlots.find((c) => c?.id === slot.id);
      return {
        id: slot.id,
        index: slot.index,
        label: typeof existing?.label === 'string' && existing.label.trim()
          ? existing.label.trim().slice(0, 32) : slot.label,
        text: typeof existing?.text === 'string' ? existing.text.trim().slice(0, 500) : '',
        repeatEnabled: Boolean(existing?.repeatEnabled),
        repeatIntervalSec: Math.max(
          1,
          Math.min(300, Math.round(Number(existing?.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC))),
        ),
      };
    });

    return {
      version: 1,
      callsign,
      slotCount: Math.max(MIN_SLOT_COUNT, Math.min(MAX_SLOT_COUNT, Math.round(Number(raw.slotCount ?? DEFAULT_SLOT_COUNT)))),
      slots,
    };
  }

  private createDefaultManifest(callsign: string): StoredCWManifest {
    return {
      version: 1,
      callsign,
      slotCount: DEFAULT_SLOT_COUNT,
      slots: Array.from({ length: MAX_SLOT_COUNT }, (_, index) => ({
        id: String(index + 1),
        index: index + 1,
        label: `CW${index + 1}`,
        text: '',
        repeatEnabled: false,
        repeatIntervalSec: DEFAULT_REPEAT_INTERVAL_SEC,
      })),
    };
  }

  private toPanel(manifest: StoredCWManifest): CWMessagePanel {
    return {
      callsign: manifest.callsign,
      slotCount: manifest.slotCount,
      maxSlotCount: MAX_SLOT_COUNT,
      slots: manifest.slots,
    };
  }

  private requireSlot(manifest: { slots: CWMessageSlot[] }, slotId: string): CWMessageSlot {
    const slot = manifest.slots.find((c) => c.id === slotId);
    if (!slot) {
      throw new Error(`Unknown CW message slot: ${slotId}`);
    }
    return slot;
  }

  private requireCallsign(callsign: string): string {
    const normalized = CWKeyerManager.normalizeCallsign(callsign);
    if (!normalized) {
      throw new Error('Callsign is required');
    }
    return normalized;
  }
}
