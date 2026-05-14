import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { EventEmitter } from 'eventemitter3';
import type {
  CWKeyerStatus,
  CWKeyerConfig,
  CWMessagePanel,
  CWMessageSlot,
  CWKeyerBackend as CWKeyerBackendType,
  CWPlaceholderValues,
} from '@tx5dr/contracts';
import { HamlibCatCWKeyerBackend } from './HamlibCatCWKeyerBackend.js';
import { SerialCWKeyerBackend } from './SerialCWKeyerBackend.js';
import type { CWKeyerBackend } from './CWKeyerBackend.js';
import { getDataFilePath } from '../utils/app-paths.js';
import { ConfigManager } from '../config/config-manager.js';
import type { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CWKeyerManager');

const DEFAULT_SLOT_COUNT = 8;
const MAX_SLOT_COUNT = 12;
const MIN_SLOT_COUNT = 3;
const DEFAULT_REPEAT_INTERVAL_SEC = 5;

const DEFAULT_CW_MESSAGE_SLOTS: Array<Pick<CWMessageSlot, 'label' | 'text' | 'repeatIntervalSec'>> = [
  {
    label: 'CQ',
    text: 'CQ CQ DE {MYCALL} {MYCALL} K',
    repeatIntervalSec: 5,
  },
  {
    label: '呼叫',
    text: '{HISCALL} DE {MYCALL} {MYCALL} K',
    repeatIntervalSec: 5,
  },
  {
    label: '报告',
    text: '{HISCALL} DE {MYCALL} UR 599 599 BK',
    repeatIntervalSec: 5,
  },
  {
    label: 'TU',
    text: '{HISCALL} DE {MYCALL} R R TU 73 SK',
    repeatIntervalSec: 5,
  },
  {
    label: '重发呼号',
    text: 'DE {MYCALL} {MYCALL} K',
    repeatIntervalSec: 5,
  },
  {
    label: 'QRZ?',
    text: 'QRZ? DE {MYCALL} K',
    repeatIntervalSec: 5,
  },
  {
    label: 'AGN?',
    text: 'AGN? AGN? DE {MYCALL} K',
    repeatIntervalSec: 5,
  },
  {
    label: 'SRI',
    text: 'SRI CALL? DE {MYCALL} K',
    repeatIntervalSec: 5,
  },
];

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
  timer: ReturnType<typeof setTimeout> | null;
  delayResolve: (() => void) | null;
  /** 操作员呼号，用于占位符替换 */
  callsign: string | null;
  /** 前端发送时提供的占位符值，用于 repeat 时保持同一发送上下文 */
  placeholderValues: CWPlaceholderValues;
  /** 当前已解析并发送给后端的明文报文 */
  currentText: string | null;
}

export interface CWKeyerManagerEvents {
  cwKeyerStatusChanged: (status: CWKeyerStatus) => void;
  cwConfigChanged: (config: CWKeyerConfig) => void;
}

export class CWKeyerManager extends EventEmitter<CWKeyerManagerEvents> {
  private readonly backends: Record<CWKeyerBackendType, CWKeyerBackend>;
  private active: ActiveKeying | null = null;
  private lastText: string | null = null;
  private _started = false;
  private _startingPromise: Promise<void> | null = null;
  private configLoaded = false;
  private configLoadPromise: Promise<void> | null = null;
  private rootDir: string | null = null;
  private config: CWKeyerConfig = {
    backend: 'cat',
    keyPort: '',
    keyMethod: 'dtr',
    wpm: 20,
  };
  private backendExplicit = false;
  private status: CWKeyerStatus = {
    active: false,
    mode: 'idle',
    startedBy: null,
    startedByLabel: null,
    messageId: null,
    nextRunAt: null,
    error: null,
    backend: 'cat',
    backendAvailable: false,
    backendError: 'CAT CW requires an active Hamlib radio connection',
    currentText: null,
    lastText: null,
  };

  constructor(getRadioManager?: () => PhysicalRadioManager) {
    super();
    this.backends = {
      cat: new HamlibCatCWKeyerBackend(() => {
        const radioManager = getRadioManager?.();
        if (!radioManager) {
          throw new Error('Radio manager is not available for CAT CW backend');
        }
        return radioManager;
      }),
      serial: new SerialCWKeyerBackend(),
    };
  }

  getStatus(): CWKeyerStatus {
    return { ...this.status };
  }

  getConfig(): CWKeyerConfig {
    return this.resolveRuntimeConfig();
  }

  async getConfigAsync(): Promise<CWKeyerConfig> {
    await this.ensureConfigLoaded();
    return this.getConfig();
  }

  async updateConfig(update: Partial<CWKeyerConfig>): Promise<void> {
    await this.ensureConfigLoaded();
    const filtered = this.filterConfigUpdate(update);
    const previousBackend = this.resolveRuntimeConfig().backend;
    if (filtered.backend) {
      this.backendExplicit = true;
    }
    const next = this.normalizeConfig({ ...this.config, ...filtered });
    const backendChanged = this.resolveRuntimeConfig(next).backend !== previousBackend;
    if (backendChanged && this._started) {
      await this.stopActive('cw backend changed');
      await this.stopBackends();
      this._started = false;
    }
    this.config = next;
    await this.writePersistedConfig();
    logger.info('CW keyer config updated', { config: this.config });
    this.emit('cwConfigChanged', this.getConfig());
    this.setStatus(this.idleStatus());
  }

  /**
   * 初始化 CW 键控器（启动硬件、加载配置）。
   * 状态由调用方的播放/手键流程发布，避免首次 lazy start 覆盖 active 状态。
   */
  async start(config: CWKeyerConfig): Promise<void> {
    await this.ensureConfigLoaded();
    const filtered = this.filterConfigUpdate(config);
    if (!this.backendExplicit) {
      delete filtered.backend;
    }
    this.config = this.normalizeConfig({ ...this.config, ...filtered });
    const runtimeConfig = this.resolveRuntimeConfig();
    await this.getBackend().start(runtimeConfig);
    this._started = true;
    logger.info('CW keyer backend started', { backend: runtimeConfig.backend });
  }

  /**
   * 停止 CW 键控器
   */
  async stop(): Promise<void> {
    await this.stopActive('cw keyer stopped');
    await this.stopBackends();
    this._started = false;
    logger.info('CW keyer stopped');
  }

  private async ensureStarted(): Promise<void> {
    await this.ensureConfigLoaded();
    if (this._started) return;
    if (this._startingPromise) {
      await this._startingPromise;
      return;
    }
    this._startingPromise = this.start(this.resolveRuntimeConfig());
    try {
      await this._startingPromise;
    } finally {
      this._startingPromise = null;
    }
  }

  // ========== 手键操作 ==========

  async handleKeyAction(clientId: string, label: string, action: 'key-down' | 'key-up'): Promise<void> {
    await this.ensureConfigLoaded();
    const backend = this.getBackend();
    if (!backend.supportsManualKeying || !backend.keyDown || !backend.keyUp) {
      throw new Error('CAT backend does not support real-time manual keying');
    }

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
          timer: null,
          delayResolve: null,
          callsign: null,
          placeholderValues: {},
          currentText: null,
        };
      }

      try {
        await this.ensureStarted();
        await backend.keyDown();
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
      await backend.keyUp();
      this.active = null;
      this.setStatus(this.idleStatus());
    }
  }

  // ========== 文字输入 ==========

  async handleTextInput(
    clientId: string,
    label: string,
    text: string,
    callsign?: string,
    placeholderValues?: CWPlaceholderValues,
  ): Promise<void> {
    await this.ensureConfigLoaded();
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
    const values = this.normalizePlaceholderValues(placeholderValues, callsign);
    const replaced = this.replacePlaceholders(text, values).trim();
    if (!replaced) {
      return;
    }

    const active: ActiveKeying = {
      clientId,
      label,
      mode: 'text',
      messageId: null,
      repeating: false,
      stopRequested: false,
      timer: null,
      delayResolve: null,
      callsign: callsign ?? null,
      placeholderValues: values,
      currentText: replaced,
    };
    this.active = active;
    this.lastText = replaced;
    this.setStatus(this.statusFor(clientId, label, 'playing', null, null, replaced));

    try {
      await this.ensureStarted();
      await this.executePlayback(active, replaced);
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

  async swapSlots(callsign: string, slotIdA: string, slotIdB: string): Promise<CWMessagePanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    const slotA = this.requireSlot(manifest, slotIdA);
    const slotB = this.requireSlot(manifest, slotIdB);

    // Swap content fields
    const tmpLabel = slotA.label;
    const tmpText = slotA.text;
    const tmpRepeatEnabled = slotA.repeatEnabled;
    const tmpRepeatIntervalSec = slotA.repeatIntervalSec;
    slotA.label = slotB.label;
    slotA.text = slotB.text;
    slotA.repeatEnabled = slotB.repeatEnabled;
    slotA.repeatIntervalSec = slotB.repeatIntervalSec;
    slotB.label = tmpLabel;
    slotB.text = tmpText;
    slotB.repeatEnabled = tmpRepeatEnabled;
    slotB.repeatIntervalSec = tmpRepeatIntervalSec;

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
    startImmediately = true,
    placeholderValues?: CWPlaceholderValues,
  ): Promise<void> {
    await this.ensureConfigLoaded();
    const normalized = this.requireCallsign(callsign);

    if (this.active) {
      await this.stopActive('replaced by message playback');
    }

    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);
    if (!slot.text) {
      throw new Error('CW message slot has no text');
    }
    const values = this.normalizePlaceholderValues(placeholderValues, normalized);
    const replaced = this.replacePlaceholders(slot.text, values).trim();
    if (!replaced) {
      return;
    }

    const active: ActiveKeying = {
      clientId,
      label,
      mode: 'message',
      messageId: slotId,
      repeating: repeat,
      stopRequested: false,
      timer: null,
      delayResolve: null,
      callsign: normalized,
      placeholderValues: values,
      currentText: replaced,
    };
    this.active = active;
    this.lastText = replaced;

    try {
      await this.ensureStarted();
      if (active.repeating && !startImmediately) {
        await this.continueRepeat(active);
      } else {
        this.setStatus(this.statusFor(clientId, label, 'playing', slotId, null, replaced));
        await this.executePlayback(active, replaced);
      }
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
    this.clearActiveDelay(active);

    await this.getBackend().stopActive();

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

  private async executePlayback(active: ActiveKeying, text: string): Promise<void> {
    if (active.stopRequested || this.active !== active) {
      return;
    }

    const backend = this.getBackend();
    await backend.sendText(text, this.config.wpm, {
      isStopped: () => active.stopRequested || this.active !== active,
      wait: async (ms) => {
        await this.delay(ms, active);
        return !active.stopRequested && this.active === active;
      },
      onKeyDown: () => {
        if (!active.stopRequested && this.active === active) {
          this.setStatus(this.statusFor(active.clientId, active.label, 'playing', active.messageId, null, active.currentText));
        }
      },
    });

    if (active.stopRequested || this.active !== active) {
      return;
    }

    // 事件序列完成
    if (this.active === active && !active.stopRequested) {
      if (active.repeating && active.mode === 'message') {
        await this.continueRepeat(active);
      } else {
        // 正常结束
        this.active = null;
        this.setStatus(this.idleStatus());
      }
    }
  }

  private async continueRepeat(active: ActiveKeying): Promise<void> {
    const slot = await this.getActiveSlot(active);
    if (!slot?.text || !slot.repeatEnabled) {
      this.active = null;
      this.setStatus(this.idleStatus());
      return;
    }

    const waitMs = slot.repeatIntervalSec * 1000;
    const nextRunAt = Date.now() + waitMs;
    active.currentText = null;
    this.setStatus(this.statusFor(active.clientId, active.label, 'repeat-waiting', active.messageId, nextRunAt, null));

    await this.delay(waitMs, active);
    if (active.stopRequested || this.active !== active) {
      return;
    }

    // 重新读取报文和配置（可能有配置变更）
    const latestSlot = await this.getActiveSlot(active);
    if (!latestSlot?.text || !latestSlot.repeatEnabled) {
      this.active = null;
      this.setStatus(this.idleStatus());
      return;
    }

    const replaced = this.replacePlaceholders(latestSlot.text, active.placeholderValues).trim();
    if (!replaced) {
      this.active = null;
      this.setStatus(this.idleStatus());
      return;
    }

    active.currentText = replaced;
    this.lastText = replaced;
    this.setStatus(this.statusFor(active.clientId, active.label, 'playing', active.messageId, null, replaced));
    await this.executePlayback(active, replaced);
  }

  private async getActiveSlot(active: ActiveKeying): Promise<CWMessageSlot | null> {
    if (!active.messageId || !active.callsign) return null;
    try {
      const manifest = await this.readManifest(active.callsign);
      return manifest.slots.find((slot) => slot.id === active.messageId) ?? null;
    } catch (error) {
      logger.warn('Failed to read active CW slot', { error: (error as Error).message });
      return null;
    }
  }

  private delay(ms: number, active: ActiveKeying): Promise<void> {
    return new Promise<void>((resolve) => {
      active.timer = setTimeout(() => {
        active.timer = null;
        active.delayResolve = null;
        resolve();
      }, ms);
      active.delayResolve = resolve;
    });
  }

  private clearActiveDelay(active: ActiveKeying): void {
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    active.delayResolve?.();
    active.delayResolve = null;
  }

  private setStatus(status: CWKeyerStatus): void {
    this.status = status;
    this.emit('cwKeyerStatusChanged', status);
  }

  /** 替换 CW 报文中的占位符，如 {MYCALL} / {HISCALL} / {TRST} / {RRST} */
  private replacePlaceholders(text: string, values: CWPlaceholderValues): string {
    const unresolved = new Set<string>();
    const replaced = text.replace(/\{(MYCALL|HISCALL|TRST|RRST)\}/gi, (source, name: string) => {
      const key = name.toUpperCase();
      let value: string | undefined;
      switch (key) {
        case 'MYCALL':
          value = values.myCall;
          break;
        case 'HISCALL':
          value = values.hisCall;
          break;
        case 'TRST':
          value = values.trst;
          break;
        case 'RRST':
          value = values.rrst;
          break;
      }
      if (!value?.trim()) {
        unresolved.add(key);
        return source;
      }
      return value.trim().toUpperCase();
    });
    if (unresolved.size > 0) {
      throw new Error(`CW message placeholder value is missing: ${Array.from(unresolved).join(', ')}`);
    }
    return replaced;
  }

  private normalizePlaceholderValues(
    values: CWPlaceholderValues | undefined,
    fallbackMyCall?: string | null,
  ): CWPlaceholderValues {
    const myCall = typeof values?.myCall === 'string' ? values.myCall : '';
    const hisCall = typeof values?.hisCall === 'string' ? values.hisCall : '';
    const trst = typeof values?.trst === 'string' ? values.trst : '';
    const rrst = typeof values?.rrst === 'string' ? values.rrst : '';
    return {
      myCall: (myCall || fallbackMyCall || '').trim().toUpperCase() || undefined,
      hisCall: hisCall.trim().toUpperCase() || undefined,
      trst: trst.trim().toUpperCase() || undefined,
      rrst: rrst.trim().toUpperCase() || undefined,
    };
  }

  private getBackend(): CWKeyerBackend {
    const runtimeConfig = this.resolveRuntimeConfig();
    return this.backends[runtimeConfig.backend] ?? this.backends.cat;
  }

  refreshRuntimeState(): void {
    const config = this.getConfig();
    this.emit('cwConfigChanged', config);
    if (!this.active) {
      this.setStatus(this.idleStatus());
    }
  }

  private resolveRuntimeConfig(config: CWKeyerConfig = this.config): CWKeyerConfig {
    const radioConfig = ConfigManager.getInstance().getRadioConfig();
    const runtimeConfig = this.normalizeConfig({
      ...config,
      keyPort: radioConfig.cwKeyPort || config.keyPort || '',
      keyMethod: radioConfig.cwKeyMethod || config.keyMethod || 'dtr',
    });
    return {
      ...runtimeConfig,
      backend: this.resolveEffectiveBackend(runtimeConfig),
    };
  }

  private resolveEffectiveBackend(config: CWKeyerConfig): CWKeyerBackendType {
    if (this.backendExplicit) {
      return config.backend;
    }
    try {
      const catAvailability = this.backends.cat.getAvailability();
      if (catAvailability.available) {
        return 'cat';
      }
    } catch {
      // If CAT availability cannot be evaluated yet, fall through to serial when configured.
    }
    if (config.keyPort.trim()) {
      return 'serial';
    }
    return 'cat';
  }

  private filterConfigUpdate(update: Partial<CWKeyerConfig>): Partial<CWKeyerConfig> {
    const filtered: Partial<CWKeyerConfig> = {};
    if (update.backend === 'cat' || update.backend === 'serial') {
      filtered.backend = update.backend;
    }
    if (typeof update.keyPort === 'string') {
      filtered.keyPort = update.keyPort;
    }
    if (update.keyMethod === 'dtr' || update.keyMethod === 'rts') {
      filtered.keyMethod = update.keyMethod;
    }
    if (typeof update.wpm === 'number' && Number.isFinite(update.wpm)) {
      filtered.wpm = update.wpm;
    }
    return filtered;
  }

  private normalizeConfig(config: Partial<CWKeyerConfig>): CWKeyerConfig {
    return {
      backend: config.backend === 'serial' ? 'serial' : 'cat',
      keyPort: typeof config.keyPort === 'string' ? config.keyPort : '',
      keyMethod: config.keyMethod === 'rts' ? 'rts' : 'dtr',
      wpm: Math.max(5, Math.min(60, Math.round(Number(config.wpm ?? 20)))),
    };
  }

  private async ensureConfigLoaded(): Promise<void> {
    if (this.configLoaded) return;
    if (this.configLoadPromise) {
      await this.configLoadPromise;
      return;
    }
    this.configLoadPromise = (async () => {
      try {
        const raw = await fs.readFile(await this.getConfigPath(), 'utf8');
        const parsed = JSON.parse(raw) as Partial<CWKeyerConfig>;
        this.backendExplicit = Object.prototype.hasOwnProperty.call(parsed, 'backend');
        this.config = this.normalizeConfig({ ...this.config, ...parsed });
      } catch {
        this.backendExplicit = false;
        this.config = this.normalizeConfig(this.config);
      } finally {
        this.configLoaded = true;
        this.configLoadPromise = null;
      }
    })();
    await this.configLoadPromise;
  }

  private async writePersistedConfig(): Promise<void> {
    const configPath = await this.getConfigPath();
    await fs.mkdir(dirname(configPath), { recursive: true });
    const persisted: { backend?: CWKeyerBackendType; wpm: number } = { wpm: this.config.wpm };
    if (this.backendExplicit) {
      persisted.backend = this.config.backend;
    }
    await fs.writeFile(
      configPath,
      JSON.stringify(persisted, null, 2),
      'utf8',
    );
  }

  private async getConfigPath(): Promise<string> {
    return join(await this.getRootDir(), 'config.json');
  }

  private async stopBackends(): Promise<void> {
    await Promise.all(Object.values(this.backends).map((backend) => backend.stop().catch((error) => {
      logger.warn('Failed to stop CW backend', {
        backend: backend.type,
        error: error instanceof Error ? error.message : String(error),
      });
    })));
  }

  private statusBackendFields(): Pick<CWKeyerStatus, 'backend' | 'backendAvailable' | 'backendError'> {
    const runtimeConfig = this.resolveRuntimeConfig();
    const backend = this.backends[runtimeConfig.backend] ?? this.backends.cat;
    if (backend.type === 'serial') {
      const available = Boolean(runtimeConfig.keyPort.trim());
      return {
        backend: backend.type,
        backendAvailable: available,
        backendError: available ? null : 'CW serial key port is not configured',
      };
    }
    try {
      const availability = backend.getAvailability();
      return {
        backend: backend.type,
        backendAvailable: availability.available,
        backendError: availability.error,
      };
    } catch (error) {
      return {
        backend: backend.type,
        backendAvailable: false,
        backendError: error instanceof Error ? error.message : String(error),
      };
    }
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
      currentText: null,
      lastText: this.lastText,
      ...this.statusBackendFields(),
    };
  }

  private statusFor(
    clientId: string,
    label: string,
    mode: CWKeyerStatus['mode'],
    messageId: string | null = null,
    nextRunAt: number | null = null,
    currentText: string | null = null,
  ): CWKeyerStatus {
    return {
      active: true,
      mode,
      startedBy: clientId,
      startedByLabel: label,
      messageId,
      nextRunAt,
      error: null,
      currentText,
      lastText: currentText ?? this.lastText,
      ...this.statusBackendFields(),
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
      slots: Array.from({ length: MAX_SLOT_COUNT }, (_, index) => {
        const preset = DEFAULT_CW_MESSAGE_SLOTS[index];
        return {
          id: String(index + 1),
          index: index + 1,
          label: preset?.label ?? `CW${index + 1}`,
          text: preset?.text ?? '',
          repeatEnabled: false,
          repeatIntervalSec: preset?.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC,
        };
      }),
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
