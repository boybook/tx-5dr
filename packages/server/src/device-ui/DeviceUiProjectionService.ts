import { EventEmitter } from 'eventemitter3';
import type {
  FrequencyState,
  OperatorStatus,
  PTTStatus,
  SlotInfo,
  SlotPack,
  SystemStatus,
  VoiceKeyerStatus,
  VoicePTTLock,
} from '@tx5dr/contracts';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';

export interface DeviceUiFrameSnapshot {
  snr: number | null;
  freq: number | null;
  dt: number | null;
  message: string;
  operatorId: string | null;
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
  access: {
    localUrl: string | null;
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
    this.snapshot.ft8.recentFrames = (slotPack.frames ?? []).map(toFrameSnapshot);
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
    const webPort = parsePort(options.webPort ?? process.env.WEB_PORT ?? process.env.PORT ?? null);
    return {
      server: {
        status: 'ok',
        version: options.version ?? SERVER_BUILD_INFO.version ?? 'unknown',
        webPort,
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
      access: {
        localUrl: webPort == null ? null : `http://localhost:${webPort}`,
      },
      updatedAt: this.now(),
    };
  }

  private markUpdated(): void {
    this.snapshot.updatedAt = this.now();
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

function toFrameSnapshot(frame: SlotPack['frames'][number]): DeviceUiFrameSnapshot {
  return {
    snr: numberOrNull(frame?.snr),
    freq: numberOrNull(frame?.freq),
    dt: numberOrNull(frame?.dt),
    message: stringOrNull(frame?.message) ?? '',
    operatorId: stringOrNull(frame?.operatorId),
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

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cloneSnapshot(snapshot: DeviceUiSnapshot): DeviceUiSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as DeviceUiSnapshot;
}
