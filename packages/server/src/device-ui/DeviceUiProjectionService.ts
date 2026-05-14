import { EventEmitter } from 'eventemitter3';
import { parseFT8LocationInfo } from '@tx5dr/core';
import type {
  FrequencyState,
  CWDecoderEvent,
  CWDecoderStatus,
  CWKeyerStatus,
  OperatorStatus,
  PTTStatus,
  SlotInfo,
  SlotPack,
  SystemStatus,
  VoiceKeyerStatus,
  VoicePTTLock,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';
import { getNetworkAccessInfo, type NetworkAccessInfoOptions } from '../utils/network-access.js';

export interface DeviceUiFrameSnapshot {
  slotId?: string | null;
  slotStartMs?: number | null;
  snr: number | null;
  freq: number | null;
  dt: number | null;
  message: string;
  operatorId: string | null;
  country?: string | null;
  countryZh?: string | null;
  countryEn?: string | null;
  countryCode?: string | null;
}

export interface DeviceUiCurrentTxSnapshot {
  active: boolean;
  operatorIds: string[];
  messages: string[];
  lastMessage: string | null;
  slotStartMs: number | null;
}

export interface DeviceUiModeSnapshot {
  name: string;
  slotMs?: number;
}

export interface DeviceUiSlotSnapshot {
  id: string;
  startMs: number;
  phaseMs: number;
  driftMs?: number;
  cycleNumber: number;
  utcSeconds: number;
  mode: string;
}

export interface DeviceUiSnapshot {
  server: {
    status: 'ok';
    version: string;
    webPort: number | null;
  };
  station: {
    callsign: string | null;
  };
  engine: {
    running: boolean;
    mode: string | null;
    currentMode: DeviceUiModeSnapshot | null;
    state: string | null;
  };
  radio: {
    connected: boolean;
    frequency: number | null;
    radioMode: string | null;
    ptt: boolean;
    tx: boolean;
  };
  ft8: {
    slot: DeviceUiSlotSnapshot | null;
    utc: number | null;
    cycle: number | null;
    periodMs: number | null;
    recentDecodeRawMessages: string[];
    lastDecodeRawMessage: string | null;
    recentFramesSlotId: string | null;
    recentFramesSlotStartMs: number | null;
    recentFrames: DeviceUiFrameSnapshot[];
    currentTx: DeviceUiCurrentTxSnapshot;
  };
  voice: {
    active: boolean;
    radioMode: string | null;
    pttLocked: boolean;
    pttLockedByLabel: string | null;
    keyerActive: boolean;
    keyerMode: string | null;
    keyerSlotId: string | null;
  };
  cw: {
    decoder: {
      enabled: boolean;
      active: boolean;
      state: string;
      muted: boolean;
      pendingText: string;
      committedText: string;
      lastDecodeAt: number | null;
      updatedAt: number;
    };
    keyer: {
      active: boolean;
      mode: string | null;
      messageId: string | null;
      currentText: string | null;
      lastText: string | null;
    };
    currentTx: {
      active: boolean;
      messages: string[];
      lastMessage: string | null;
    };
  };
  access: {
    localUrl: string | null;
    localUrls: string[];
  };
  updatedAt: number;
}

export interface DeviceUiProjectionEvents {
  snapshot: (snapshot: DeviceUiSnapshot) => void;
}

export interface DeviceUiProjectionOptions {
  webPort?: number | string | null;
  version?: string | null;
  now?: () => number;
  maxRecentDecodes?: number;
  stationCallsign?: string | null;
  networkAccess?: Pick<NetworkAccessInfoOptions, 'webPort' | 'env' | 'hostname' | 'networkInterfaces'>;
}

type Listener = (snapshot: DeviceUiSnapshot) => void;
type EngineLike = {
  on?: (event: string, listener: (...args: any[]) => void) => unknown;
  off?: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown;
  getStatus?: () => Partial<SystemStatus> & Record<string, unknown>;
  getCurrentSlotInfo?: () => SlotInfo | null;
  getActiveSlotPacks?: () => SlotPack[];
  getVoiceKeyerManager?: () => { getStatus?: () => VoiceKeyerStatus } | null;
  getVoiceSessionManager?: () => { getPTTLockState?: () => VoicePTTLock; getLockState?: () => VoicePTTLock } | null;
  getCWDecoderStatus?: () => CWDecoderStatus;
  getCWKeyerManager?: () => { getStatus?: () => CWKeyerStatus } | null;
  operatorManager?: { getOperatorsStatus?: () => OperatorStatus[] };
  getRadioManager?: () => {
    isConnected?: () => boolean;
    getKnownFrequency?: () => number | null;
  };
};

const DEFAULT_RECENT_DECODE_LIMIT = 12;
const NULL_TX: DeviceUiCurrentTxSnapshot = {
  active: false,
  operatorIds: [],
  messages: [],
  lastMessage: null,
  slotStartMs: null,
};

export class DeviceUiProjectionService {
  public readonly events = new EventEmitter<DeviceUiProjectionEvents>();

  private snapshot: DeviceUiSnapshot;
  private readonly listeners = new Set<Listener>();
  private readonly registrations: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  private readonly now: () => number;
  private readonly maxRecentDecodes: number;
  private operatorStatuses = new Map<string, OperatorStatus>();
  private pttStatus: PTTStatus = { isTransmitting: false, operatorIds: [] };
  private voicePttLock: VoicePTTLock | null = null;
  private voiceKeyerStatus: VoiceKeyerStatus | null = null;
  private readonly cwDecoderCommitKeys: string[] = [];

  constructor(private readonly engine: EngineLike, options: DeviceUiProjectionOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxRecentDecodes = Math.max(1, options.maxRecentDecodes ?? DEFAULT_RECENT_DECODE_LIMIT);
    this.snapshot = this.createDefaultSnapshot(options);
    this.attachEngineEvents();
    this.rebuildFromEngine(false);
  }

  getSnapshot(): DeviceUiSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getSnapshot());
    } catch {
      // Device UI subscribers must not be able to break the projection service.
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    for (const registration of this.registrations) {
      if (this.engine.off) {
        this.safeCall(() => this.engine.off?.(registration.event, registration.listener));
      } else if (this.engine.removeListener) {
        this.safeCall(() => this.engine.removeListener?.(registration.event, registration.listener));
      }
    }
    this.registrations.length = 0;
    this.listeners.clear();
    this.events.removeAllListeners();
  }

  private attachEngineEvents(): void {
    this.listen('systemStatus', (status: SystemStatus) => {
      this.applySystemStatus(status);
      this.publish();
    });
    this.listen('modeChanged', (mode: Record<string, unknown>) => {
      this.snapshot.engine.currentMode = toModeSnapshot(mode);
      this.snapshot.engine.mode = stringOrNull(mode?.name) ?? this.snapshot.engine.mode;
      this.snapshot.ft8.periodMs = numberOrNull(mode?.slotMs) ?? this.snapshot.ft8.periodMs;
      this.publish();
    });
    this.listen('frequencyChanged', (data: FrequencyState) => {
      this.applyFrequency(data);
      this.publish();
    });
    this.listen('radioStatusChanged', (data: Record<string, unknown>) => {
      this.snapshot.radio.connected = booleanOrDefault(data?.connected, this.snapshot.radio.connected);
      this.snapshot.radio.frequency = numberOrNull(data?.frequency) ?? this.snapshot.radio.frequency;
      this.snapshot.radio.radioMode = stringOrNull(data?.radioMode ?? data?.mode) ?? this.snapshot.radio.radioMode;
      this.publish();
    });
    this.listen('pttStatusChanged', (data: PTTStatus) => {
      this.applyPttStatus(data);
      this.publish();
    });
    this.listen('slotStart', (slotInfo: SlotInfo) => {
      this.applySlot(slotInfo);
      this.publish();
    });
    this.listen('slotPackUpdated', (slotPack: SlotPack) => {
      this.applySlotPack(slotPack);
      this.publish();
    });
    this.listen('operatorsList', (data: { operators?: OperatorStatus[] }) => {
      this.operatorStatuses = new Map((data?.operators ?? []).map((operator) => [operator.id, operator]));
      this.rebuildCurrentTx();
      this.publish();
    });
    this.listen('operatorStatusUpdate', (status: OperatorStatus) => {
      if (status?.id) {
        this.operatorStatuses.set(status.id, status);
        this.rebuildCurrentTx();
        this.publish();
      }
    });
    this.listen('transmissionLog', (data: { message?: string; slotStartMs?: number }) => {
      this.snapshot.ft8.currentTx = {
        ...this.snapshot.ft8.currentTx,
        lastMessage: stringOrNull(data?.message),
        messages: mergeRecentStrings(this.snapshot.ft8.currentTx.messages, stringOrNull(data?.message), this.maxRecentDecodes),
        slotStartMs: numberOrNull(data?.slotStartMs),
      };
      this.publish();
    });
    this.listen('voicePttLockChanged', (data: VoicePTTLock) => {
      this.voicePttLock = data ?? null;
      this.applyVoiceSummary();
      this.publish();
    });
    this.listen('voiceRadioModeChanged', (data: { radioMode?: string }) => {
      const radioMode = stringOrNull(data?.radioMode);
      this.snapshot.voice.radioMode = radioMode;
      this.snapshot.radio.radioMode = radioMode ?? this.snapshot.radio.radioMode;
      this.publish();
    });
    this.listen('voiceKeyerStatusChanged', (data: VoiceKeyerStatus) => {
      this.voiceKeyerStatus = data ?? null;
      this.applyVoiceSummary();
      this.publish();
    });
    this.listen('cwDecoderStatusChanged', (data: CWDecoderStatus) => {
      this.applyCwDecoderStatus(data);
      this.publish();
    });
    this.listen('cwDecoderEvent', (data: CWDecoderEvent) => {
      this.applyCwDecoderEvent(data);
      this.publish();
    });
    this.listen('cwKeyerStatusChanged', (data: CWKeyerStatus) => {
      this.applyCwKeyerStatus(data);
      this.publish();
    });
    this.listen('connected', () => {
      this.snapshot.radio.connected = true;
      this.publish();
    });
    this.listen('disconnected', () => {
      this.snapshot.radio.connected = false;
      this.publish();
    });
  }

  private listen(event: string, listener: (...args: any[]) => void): void {
    if (!this.engine.on) return;
    this.safeCall(() => this.engine.on?.(event, listener));
    this.registrations.push({ event, listener });
  }

  private rebuildFromEngine(shouldPublish: boolean): void {
    const status = this.safeCall(() => this.engine.getStatus?.()) ?? null;
    if (status) this.applySystemStatus(status as Partial<SystemStatus> & Record<string, unknown>);

    const currentSlot = this.safeCall(() => this.engine.getCurrentSlotInfo?.()) ?? null;
    if (currentSlot) this.applySlot(currentSlot);

    const activeSlotPacks = this.safeCall(() => this.engine.getActiveSlotPacks?.()) ?? [];
    if (Array.isArray(activeSlotPacks) && activeSlotPacks.length > 0) {
      const latest = [...activeSlotPacks].sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0))[0];
      this.applySlotPack(latest);
    }

    const operatorStatuses = this.safeCall(() => this.engine.operatorManager?.getOperatorsStatus?.()) ?? [];
    if (Array.isArray(operatorStatuses)) {
      this.operatorStatuses = new Map(operatorStatuses.map((operator) => [operator.id, operator]));
      this.rebuildCurrentTx();
    }

    const radioManager = this.safeCall(() => this.engine.getRadioManager?.()) ?? null;
    if (radioManager) {
      this.snapshot.radio.connected = booleanOrDefault(this.safeCall(() => radioManager.isConnected?.()), this.snapshot.radio.connected);
      this.snapshot.radio.frequency = numberOrNull(this.safeCall(() => radioManager.getKnownFrequency?.())) ?? this.snapshot.radio.frequency;
    }

    this.voiceKeyerStatus = this.safeCall(() => this.engine.getVoiceKeyerManager?.()?.getStatus?.()) ?? this.voiceKeyerStatus;
    const voiceSessionManager = this.safeCall(() => this.engine.getVoiceSessionManager?.()) ?? null;
    this.voicePttLock = this.safeCall(() => voiceSessionManager?.getPTTLockState?.())
      ?? this.safeCall(() => voiceSessionManager?.getLockState?.())
      ?? this.voicePttLock;
    this.applyVoiceSummary();

    const cwDecoderStatus = this.safeCall(() => this.engine.getCWDecoderStatus?.()) ?? null;
    if (cwDecoderStatus) this.applyCwDecoderStatus(cwDecoderStatus);
    const cwKeyerStatus = this.safeCall(() => this.engine.getCWKeyerManager?.()?.getStatus?.()) ?? null;
    if (cwKeyerStatus) this.applyCwKeyerStatus(cwKeyerStatus);

    if (shouldPublish) this.publish();
  }

  private applySystemStatus(status: Partial<SystemStatus> & Record<string, unknown>): void {
    this.snapshot.engine.running = booleanOrDefault(status?.isRunning, false);
    this.snapshot.engine.currentMode = toModeSnapshot(status?.currentMode) ?? this.snapshot.engine.currentMode;
    this.snapshot.engine.mode = stringOrNull(status?.engineMode) ?? this.snapshot.engine.currentMode?.name ?? null;
    this.snapshot.engine.state = stringOrNull(status?.engineState);
    this.snapshot.radio.connected = booleanOrDefault(status?.radioConnected, this.snapshot.radio.connected);
    this.snapshot.radio.ptt = booleanOrDefault(status?.isPTTActive, this.snapshot.radio.ptt);
    this.snapshot.radio.tx = this.snapshot.radio.ptt || this.pttStatus.isTransmitting;
    this.snapshot.radio.radioMode = stringOrNull(status?.currentRadioMode) ?? this.snapshot.radio.radioMode;
    this.snapshot.ft8.periodMs = numberOrNull(this.snapshot.engine.currentMode?.slotMs) ?? this.snapshot.ft8.periodMs;
    this.snapshot.voice.active = this.snapshot.engine.mode === 'voice';
    this.markUpdated();
  }

  private applyFrequency(data: Partial<FrequencyState> | null | undefined): void {
    if (!data) return;
    this.snapshot.radio.frequency = numberOrNull(data.frequency) ?? this.snapshot.radio.frequency;
    this.snapshot.radio.connected = booleanOrDefault(data.radioConnected, this.snapshot.radio.connected);
    this.snapshot.radio.radioMode = stringOrNull(data.radioMode ?? data.mode) ?? this.snapshot.radio.radioMode;
    this.markUpdated();
  }

  private applyPttStatus(data: Partial<PTTStatus> | null | undefined): void {
    this.pttStatus = {
      isTransmitting: booleanOrDefault(data?.isTransmitting, false),
      operatorIds: Array.isArray(data?.operatorIds) ? data.operatorIds.filter((id): id is string => typeof id === 'string') : [],
    };
    this.snapshot.radio.ptt = this.pttStatus.isTransmitting;
    this.snapshot.radio.tx = this.pttStatus.isTransmitting;
    this.rebuildCurrentTx();
    this.markUpdated();
  }

  private applySlot(slotInfo: SlotInfo): void {
    this.snapshot.ft8.slot = toSlotSnapshot(slotInfo);
    this.snapshot.ft8.utc = numberOrNull(slotInfo?.utcSeconds);
    this.snapshot.ft8.cycle = numberOrNull(slotInfo?.cycleNumber);
    this.snapshot.ft8.periodMs = numberOrNull(this.snapshot.engine.currentMode?.slotMs) ?? this.snapshot.ft8.periodMs;
    this.markUpdated();
  }

  private applySlotPack(slotPack: SlotPack): void {
    if (!slotPack) return;
    this.snapshot.radio.frequency = numberOrNull(slotPack.frequencyContext?.frequency) ?? this.snapshot.radio.frequency;
    this.snapshot.radio.radioMode = stringOrNull(slotPack.frequencyContext?.radioMode ?? slotPack.frequencyContext?.mode) ?? this.snapshot.radio.radioMode;
    this.snapshot.ft8.recentFramesSlotId = stringOrNull(slotPack.slotId);
    this.snapshot.ft8.recentFramesSlotStartMs = numberOrNull(slotPack.startMs);
    this.snapshot.ft8.recentFrames = (slotPack.frames ?? []).map((frame) => toFrameSnapshot(frame, slotPack));
    const messages = (slotPack.frames ?? []).map((frame) => stringOrNull(frame.message)).filter((message): message is string => Boolean(message));
    for (const message of messages) {
      this.snapshot.ft8.recentDecodeRawMessages = mergeRecentStrings(this.snapshot.ft8.recentDecodeRawMessages, message, this.maxRecentDecodes);
      this.snapshot.ft8.lastDecodeRawMessage = message;
    }
    this.markUpdated();
  }

  private rebuildCurrentTx(): void {
    const operatorIds = this.pttStatus.operatorIds.length > 0
      ? this.pttStatus.operatorIds
      : Array.from(this.operatorStatuses.values())
        .filter((status) => status.isTransmitting || status.isInActivePTT)
        .map((status) => status.id);
    const messages = operatorIds
      .map((id) => this.operatorStatuses.get(id))
      .map((status) => currentOperatorMessage(status))
      .filter((message): message is string => Boolean(message));

    this.snapshot.ft8.currentTx = {
      active: this.pttStatus.isTransmitting || operatorIds.length > 0,
      operatorIds,
      messages,
      lastMessage: messages[messages.length - 1] ?? this.snapshot.ft8.currentTx.lastMessage ?? null,
      slotStartMs: this.snapshot.ft8.currentTx.slotStartMs,
    };
  }

  private applyVoiceSummary(): void {
    this.snapshot.voice = {
      active: this.snapshot.engine.mode === 'voice',
      radioMode: this.snapshot.voice.radioMode ?? this.snapshot.radio.radioMode,
      pttLocked: booleanOrDefault(this.voicePttLock?.locked, false),
      pttLockedByLabel: stringOrNull(this.voicePttLock?.lockedByLabel),
      keyerActive: booleanOrDefault(this.voiceKeyerStatus?.active, false),
      keyerMode: stringOrNull(this.voiceKeyerStatus?.mode),
      keyerSlotId: stringOrNull(this.voiceKeyerStatus?.slotId),
    };
    this.markUpdated();
  }

  private applyCwDecoderStatus(status: Partial<CWDecoderStatus> | null | undefined): void {
    if (!status) return;
    const state = stringOrNull(status.state) ?? this.snapshot.cw.decoder.state;
    const enabled = isCwDecoderOffState(state)
      ? false
      : booleanOrDefault(status.enabled, this.snapshot.cw.decoder.enabled);
    this.snapshot.cw.decoder = {
      enabled,
      active: enabled && booleanOrDefault(status.active ?? status.running, this.snapshot.cw.decoder.active),
      state,
      muted: booleanOrDefault(status.muted, this.snapshot.cw.decoder.muted),
      pendingText: enabled ? stringOrEmpty(status.pendingText, this.snapshot.cw.decoder.pendingText) : '',
      committedText: enabled ? stringOrEmpty(status.committedText, this.snapshot.cw.decoder.committedText) : '',
      lastDecodeAt: enabled ? numberOrNull(status.lastDecodeAt) ?? this.snapshot.cw.decoder.lastDecodeAt : null,
      updatedAt: numberOrNull(status.updatedAt) ?? this.now(),
    };
    this.markUpdated();
  }

  private applyCwDecoderEvent(event: CWDecoderEvent | null | undefined): void {
    if (!event) return;
    const kind = stringOrNull((event as Record<string, unknown>).kind);
    if (kind === 'transcript_reset') {
      this.cwDecoderCommitKeys.length = 0;
      this.snapshot.cw.decoder.pendingText = '';
      this.snapshot.cw.decoder.committedText = '';
      this.snapshot.cw.decoder.updatedAt = numberOrNull((event as Record<string, unknown>).timestamp) ?? this.now();
      this.markUpdated();
      return;
    }
    if (kind === 'transcript_pending') {
      const pending = (event as Record<string, unknown>).pending;
      this.snapshot.cw.decoder.pendingText = pending && typeof pending === 'object'
        ? stringOrEmpty((pending as Record<string, unknown>).text)
        : '';
      this.snapshot.cw.decoder.updatedAt = numberOrNull((event as Record<string, unknown>).timestamp) ?? this.now();
      this.markUpdated();
      return;
    }
    if (kind === 'pending' || kind === 'partial') {
      this.snapshot.cw.decoder.pendingText = stringOrEmpty((event as Record<string, unknown>).text);
      this.snapshot.cw.decoder.updatedAt = numberOrNull((event as Record<string, unknown>).timestamp) ?? this.now();
      this.markUpdated();
      return;
    }
    if (kind === 'transcript_commit' || kind === 'commit' || kind === 'transcript') {
      const record = event as Record<string, unknown>;
      const segment = record.segment && typeof record.segment === 'object' ? record.segment as Record<string, unknown> : null;
      const text = stringOrNull(segment?.text) ?? stringOrNull(record.text);
      if (text) {
        const commitKey = cwCommitKey(segment, record, text);
        if (commitKey && this.cwDecoderCommitKeys.includes(commitKey)) {
          this.snapshot.cw.decoder.pendingText = '';
          this.snapshot.cw.decoder.updatedAt = numberOrNull(record.timestamp) ?? this.now();
          this.markUpdated();
          return;
        }
        if (commitKey) {
          this.cwDecoderCommitKeys.push(commitKey);
          this.cwDecoderCommitKeys.splice(0, Math.max(0, this.cwDecoderCommitKeys.length - 64));
        }
        const prependSpace = typeof segment?.prependSpace === 'boolean' ? segment.prependSpace : true;
        this.snapshot.cw.decoder.committedText = joinTranscriptText(this.snapshot.cw.decoder.committedText, text, prependSpace);
        this.snapshot.cw.decoder.pendingText = '';
        this.snapshot.cw.decoder.lastDecodeAt = numberOrNull(record.timestamp) ?? this.now();
      }
      this.snapshot.cw.decoder.updatedAt = numberOrNull(record.timestamp) ?? this.now();
      this.markUpdated();
    }
  }

  private applyCwKeyerStatus(status: Partial<CWKeyerStatus> | null | undefined): void {
    if (!status) return;
    const hasLastText = Object.prototype.hasOwnProperty.call(status, 'lastText');
    const currentText = stringOrNull(status.currentText);
    const lastText = hasLastText
      ? stringOrNull(status.lastText)
      : currentText ?? this.snapshot.cw.keyer.lastText;
    this.snapshot.cw.keyer = {
      active: booleanOrDefault(status.active, false),
      mode: stringOrNull(status.mode),
      messageId: stringOrNull(status.messageId),
      currentText,
      lastText,
    };
    const messages = [currentText, lastText].filter((message): message is string => Boolean(message));
    this.snapshot.cw.currentTx = {
      active: booleanOrDefault(status.active, false),
      messages,
      lastMessage: messages[0] ?? null,
    };
    this.markUpdated();
  }

  private publish(): void {
    this.markUpdated();
    const snapshot = cloneSnapshot(this.snapshot);
    this.events.emit('snapshot', snapshot);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Keep notifying other listeners even if one client callback fails.
      }
    }
  }

  private createDefaultSnapshot(options: DeviceUiProjectionOptions): DeviceUiSnapshot {
    const networkAccess = getNetworkAccessInfo({
      ...(options.networkAccess ?? {}),
      webPort: options.networkAccess?.webPort ?? options.webPort,
    });
    const localUrls = networkAccess.addresses.map((address) => address.url);
    return {
      server: {
        status: 'ok',
        version: options.version ?? SERVER_BUILD_INFO.version ?? 'unknown',
        webPort: networkAccess.webPort,
      },
      station: {
        callsign: stringOrNull(options.stationCallsign) ?? this.readStationCallsign(),
      },
      engine: {
        running: false,
        mode: null,
        currentMode: null,
        state: null,
      },
      radio: {
        connected: false,
        frequency: null,
        radioMode: null,
        ptt: false,
        tx: false,
      },
      ft8: {
        slot: null,
        utc: null,
        cycle: null,
        periodMs: null,
        recentDecodeRawMessages: [],
        lastDecodeRawMessage: null,
        recentFramesSlotId: null,
        recentFramesSlotStartMs: null,
        recentFrames: [],
        currentTx: { ...NULL_TX },
      },
      voice: {
        active: false,
        radioMode: null,
        pttLocked: false,
        pttLockedByLabel: null,
        keyerActive: false,
        keyerMode: null,
        keyerSlotId: null,
      },
      cw: {
        decoder: {
          enabled: false,
          active: false,
          state: 'disabled',
          muted: false,
          pendingText: '',
          committedText: '',
          lastDecodeAt: null,
          updatedAt: this.now(),
        },
        keyer: {
          active: false,
          mode: null,
          messageId: null,
          currentText: null,
          lastText: null,
        },
        currentTx: {
          active: false,
          messages: [],
          lastMessage: null,
        },
      },
      access: {
        localUrl: localUrls[0] ?? null,
        localUrls,
      },
      updatedAt: this.now(),
    };
  }

  private markUpdated(): void {
    this.snapshot.updatedAt = this.now();
  }

  private readStationCallsign(): string | null {
    return stringOrNull(this.safeCall(() => ConfigManager.getInstance().getStationInfo().callsign))?.toUpperCase() ?? null;
  }

  private safeCall<T>(call: () => T): T | null {
    try {
      return call();
    } catch {
      return null;
    }
  }
}

function currentOperatorMessage(status: OperatorStatus | undefined): string | null {
  if (!status) return null;
  const slot = status.currentSlot;
  if (slot && status.slots && slot in status.slots) {
    const message = status.slots[slot as keyof NonNullable<OperatorStatus['slots']>];
    if (message) return message;
  }
  if (status.runtime?.slots && slot && slot in status.runtime.slots) {
    const message = status.runtime.slots[slot as keyof NonNullable<NonNullable<OperatorStatus['runtime']>['slots']>];
    if (message) return message;
  }
  return null;
}

function toFrameSnapshot(frame: SlotPack['frames'][number], slotPack: SlotPack): DeviceUiFrameSnapshot {
  const message = stringOrNull(frame?.message) ?? '';
  const locationInfo = message ? parseFT8LocationInfo(message) : {};
  return {
    slotId: stringOrNull(slotPack.slotId),
    slotStartMs: numberOrNull(slotPack.startMs),
    snr: numberOrNull(frame?.snr),
    freq: numberOrNull(frame?.freq),
    dt: numberOrNull(frame?.dt),
    message,
    operatorId: stringOrNull(frame?.operatorId),
    country: stringOrNull(locationInfo.country),
    countryZh: stringOrNull(locationInfo.countryZh),
    countryEn: stringOrNull(locationInfo.countryEn),
    countryCode: stringOrNull(locationInfo.countryCode),
  };
}

function toModeSnapshot(mode: unknown): DeviceUiModeSnapshot | null {
  if (!mode || typeof mode !== 'object') return null;
  const value = mode as Record<string, unknown>;
  const name = stringOrNull(value.name);
  if (!name) return null;
  const slotMs = numberOrNull(value.slotMs);
  return slotMs == null ? { name } : { name, slotMs };
}

function toSlotSnapshot(slotInfo: SlotInfo | null | undefined): DeviceUiSlotSnapshot | null {
  if (!slotInfo) return null;
  return {
    id: slotInfo.id,
    startMs: slotInfo.startMs,
    phaseMs: slotInfo.phaseMs,
    driftMs: slotInfo.driftMs,
    cycleNumber: slotInfo.cycleNumber,
    utcSeconds: slotInfo.utcSeconds,
    mode: slotInfo.mode,
  };
}

function mergeRecentStrings(items: string[], next: string | null, limit: number): string[] {
  if (!next) return items.slice(-limit);
  return [...items, next].slice(-limit);
}

function joinTranscriptText(current: string, next: string, prependSpace: boolean): string {
  const text = next.trim();
  if (!text) return current;
  if (!current) return text;
  return prependSpace ? `${current} ${text}` : `${current}${text}`;
}

function cwCommitKey(segment: Record<string, unknown> | null, event: Record<string, unknown>, text: string): string | null {
  const id = stringOrNull(segment?.id);
  if (id) return `id:${id}`;
  const sessionId = stringOrNull(segment?.sessionId);
  const sequence = numberOrNull(segment?.sequence);
  if (sessionId && sequence != null) return `seq:${sessionId}:${sequence}`;
  const timestamp = numberOrNull(event.timestamp);
  return timestamp != null ? `legacy:${timestamp}:${text}` : null;
}

function isCwDecoderOffState(state: string | null): boolean {
  return state === 'disabled' || state === 'stopped' || state === 'stopping' || state === 'idle' || state === 'off' || state === 'unavailable';
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringOrEmpty(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function cloneSnapshot(snapshot: DeviceUiSnapshot): DeviceUiSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as DeviceUiSnapshot;
}
