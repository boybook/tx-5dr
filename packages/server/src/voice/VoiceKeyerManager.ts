import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { EventEmitter } from 'eventemitter3';
import * as nodeWav from 'node-wav';
import type { VoiceKeyerPanel, VoiceKeyerSlot, VoiceKeyerStatus } from '@tx5dr/contracts';
import type { AudioStreamManager } from '../audio/AudioStreamManager.js';
import type { VoiceSessionManager } from './VoiceSessionManager.js';
import { getDataFilePath } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('VoiceKeyerManager');
const DEFAULT_SLOT_COUNT = 8;
const MAX_SLOT_COUNT = 12;
const MIN_SLOT_COUNT = 3;
const DEFAULT_REPEAT_INTERVAL_SEC = 5;
const MAX_AUDIO_DURATION_MS = 120_000;
const MIN_AUDIO_DURATION_MS = 500;
const PTT_LEAD_IN_MS = 150;
const PTT_TAIL_MS = 500;

interface StoredManifest {
  version: 1;
  callsign: string;
  slotCount: number;
  slots: VoiceKeyerSlot[];
}

interface ActivePlayback {
  keyerClientId: string;
  startedBy: string;
  startedByLabel: string;
  callsign: string;
  slotId: string;
  repeating: boolean;
  stopRequested: boolean;
  timer: NodeJS.Timeout | null;
  timerResolve: (() => void) | null;
}

export interface VoiceKeyerManagerEvents {
  voiceKeyerStatusChanged: (status: VoiceKeyerStatus) => void;
}

export interface VoiceKeyerManagerDeps {
  voiceSessionManager: VoiceSessionManager;
  audioStreamManager: AudioStreamManager;
  storageRootDir?: string;
}

export class VoiceKeyerManager extends EventEmitter<VoiceKeyerManagerEvents> {
  private rootDir: string | null = null;
  private active: ActivePlayback | null = null;
  private status: VoiceKeyerStatus = {
    active: false,
    callsign: null,
    slotId: null,
    mode: 'idle',
    repeating: false,
    startedBy: null,
    startedByLabel: null,
    nextRunAt: null,
    error: null,
  };

  constructor(private readonly deps: VoiceKeyerManagerDeps) {
    super();
  }

  static normalizeCallsign(callsign: string): string {
    return callsign.trim().toUpperCase();
  }

  static safeCallsign(callsign: string): string {
    return encodeURIComponent(VoiceKeyerManager.normalizeCallsign(callsign));
  }

  getStatus(): VoiceKeyerStatus {
    return { ...this.status };
  }

  async getPanel(callsign: string): Promise<VoiceKeyerPanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    return this.toPanel(manifest);
  }

  async updatePanel(callsign: string, slotCount: number): Promise<VoiceKeyerPanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    manifest.slotCount = Math.max(MIN_SLOT_COUNT, Math.min(MAX_SLOT_COUNT, Math.round(slotCount)));
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async updateSlot(
    callsign: string,
    slotId: string,
    update: { label?: string; repeatEnabled?: boolean; repeatIntervalSec?: number },
  ): Promise<VoiceKeyerPanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);

    if (typeof update.label === 'string') {
      slot.label = update.label.trim().slice(0, 32) || `M${slot.index}`;
    }
    if (typeof update.repeatEnabled === 'boolean') {
      slot.repeatEnabled = update.repeatEnabled;
    }
    if (typeof update.repeatIntervalSec === 'number') {
      slot.repeatIntervalSec = Math.max(1, Math.min(300, Math.round(update.repeatIntervalSec)));
    }

    await this.writeManifest(manifest);
    await this.applyActiveSlotConfig(normalized, slot, update);
    return this.toPanel(manifest);
  }

  async saveSlotAudio(callsign: string, slotId: string, wavBuffer: Buffer): Promise<VoiceKeyerPanel> {
    const normalized = this.requireCallsign(callsign);
    const decoded = this.decodeWav(wavBuffer);
    const durationMs = Math.round((decoded.samples.length / decoded.sampleRate) * 1000);
    if (durationMs < MIN_AUDIO_DURATION_MS || durationMs > MAX_AUDIO_DURATION_MS) {
      throw new Error(`Voice keyer audio must be between 0.5s and 120s (received ${(durationMs / 1000).toFixed(1)}s)`);
    }

    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);
    const audioPath = await this.getSlotAudioPath(normalized, slot.id);
    await fs.mkdir(dirname(audioPath), { recursive: true });
    await fs.writeFile(audioPath, wavBuffer);

    slot.hasAudio = true;
    slot.durationMs = durationMs;
    slot.updatedAt = Date.now();
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async deleteSlotAudio(callsign: string, slotId: string): Promise<VoiceKeyerPanel> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);
    const audioPath = await this.getSlotAudioPath(normalized, slot.id);
    await fs.rm(audioPath, { force: true });
    slot.hasAudio = false;
    slot.durationMs = 0;
    slot.updatedAt = null;
    await this.writeManifest(manifest);
    return this.toPanel(manifest);
  }

  async getSlotAudioPathForRead(callsign: string, slotId: string): Promise<string> {
    const normalized = this.requireCallsign(callsign);
    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, slotId);
    if (!slot.hasAudio) {
      throw new Error('Voice keyer slot has no recording');
    }
    return this.getSlotAudioPath(normalized, slot.id);
  }

  async play(
    params: {
      callsign: string;
      slotId: string;
      repeat: boolean;
      connectionId: string;
      label: string;
    },
  ): Promise<void> {
    const normalized = this.requireCallsign(params.callsign);
    await this.stopActive('replaced by new voice keyer playback');

    const manifest = await this.readManifest(normalized);
    const slot = this.requireSlot(manifest, params.slotId);
    if (!slot.hasAudio) {
      throw new Error('Voice keyer slot has no recording');
    }

    const active: ActivePlayback = {
      keyerClientId: `voice-keyer:${params.connectionId}`,
      startedBy: params.connectionId,
      startedByLabel: params.label,
      callsign: normalized,
      slotId: slot.id,
      repeating: params.repeat,
      stopRequested: false,
      timer: null,
      timerResolve: null,
    };
    this.active = active;
    void this.runPlaybackLoop(active);
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
    active.timerResolve?.();
    active.timerResolve = null;
    this.setStatus({
      ...this.status,
      active: true,
      mode: 'stopping',
      nextRunAt: null,
      error: null,
    });

    try {
      await this.deps.audioStreamManager.stopCurrentPlayback();
    } catch {
      // stopCurrentPlayback may report that no complete clip is active; PTT cleanup below is authoritative.
    }
    await this.deps.voiceSessionManager.stopTransmit(active.keyerClientId);

    if (this.active === active) {
      this.active = null;
    }
    logger.info('Voice keyer stopped', { reason });
    this.setStatus(this.idleStatus());
  }

  async handleClientDisconnect(connectionId: string): Promise<void> {
    if (this.active?.startedBy === connectionId) {
      await this.stopActive('client disconnected');
    }
  }

  private async runPlaybackLoop(active: ActivePlayback): Promise<void> {
    try {
      while (!active.stopRequested && this.active === active) {
        await this.playOnce(active);
        if (!active.repeating || active.stopRequested || this.active !== active) {
          break;
        }

        const panel = await this.getPanel(active.callsign);
        const slot = this.requireSlot(panel, active.slotId);
        if (!slot.repeatEnabled) {
          break;
        }
        const waitMs = slot.repeatIntervalSec * 1000;
        const nextRunAt = Date.now() + waitMs;
        this.setStatus(this.statusFor(active, 'repeat-waiting', nextRunAt));
        await new Promise<void>((resolve) => {
          active.timerResolve = resolve;
          active.timer = setTimeout(resolve, waitMs);
        });
        active.timer = null;
        active.timerResolve = null;
      }
    } catch (error) {
      logger.error('Voice keyer playback failed', error);
      this.setStatus(this.statusFor(active, 'error', null, error instanceof Error ? error.message : String(error)));
    } finally {
      if (this.active === active) {
        await this.deps.voiceSessionManager.stopTransmit(active.keyerClientId);
        this.active = null;
        if (active.stopRequested || this.status.mode !== 'error') {
          this.setStatus(this.idleStatus());
        }
      }
    }
  }

  private async playOnce(active: ActivePlayback): Promise<void> {
    const audioPath = await this.getSlotAudioPathForRead(active.callsign, active.slotId);
    const decoded = this.decodeWav(await fs.readFile(audioPath));
    const lock = await this.deps.voiceSessionManager.startTransmit(
      active.keyerClientId,
      `${active.startedByLabel} Voice Keyer`,
    );
    if (!lock.success) {
      throw new Error(lock.reason || 'Voice keyer PTT request denied');
    }

    this.setStatus(this.statusFor(active, 'playing'));
    await this.sleep(PTT_LEAD_IN_MS, active);
    if (active.stopRequested || this.active !== active) {
      throw new Error('playback interrupted');
    }
    await this.deps.audioStreamManager.playAudio(decoded.samples, decoded.sampleRate, {
      injectIntoMonitor: true,
    });
    if (active.stopRequested || this.active !== active) {
      throw new Error('playback interrupted');
    }
    await this.sleep(PTT_TAIL_MS, active);
    await this.deps.voiceSessionManager.stopTransmit(active.keyerClientId);
  }

  private sleep(ms: number, active: ActivePlayback): Promise<void> {
    if (ms <= 0 || active.stopRequested) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private decodeWav(buffer: Buffer): { sampleRate: number; samples: Float32Array } {
    const decoded = nodeWav.decode(buffer);
    const channels = decoded.channelData;
    if (!channels.length || decoded.sampleRate <= 0) {
      throw new Error('Invalid WAV audio');
    }

    const length = channels[0]?.length ?? 0;
    const mono = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      let sum = 0;
      for (const channel of channels) {
        sum += channel[i] ?? 0;
      }
      const sample = sum / channels.length;
      mono[i] = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
    }
    return { sampleRate: decoded.sampleRate, samples: mono };
  }

  private async readManifest(callsign: string): Promise<StoredManifest> {
    const manifestPath = await this.getManifestPath(callsign);
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return this.normalizeManifest(JSON.parse(raw), callsign);
    } catch {
      const manifest = this.createDefaultManifest(callsign);
      await this.writeManifest(manifest);
      return manifest;
    }
  }

  private async writeManifest(manifest: StoredManifest): Promise<void> {
    const manifestPath = await this.getManifestPath(manifest.callsign);
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify(this.normalizeManifest(manifest, manifest.callsign), null, 2), 'utf8');
  }

  private normalizeManifest(raw: Partial<StoredManifest>, callsign: string): StoredManifest {
    const defaults = this.createDefaultManifest(callsign);
    const rawSlots = Array.isArray(raw.slots) ? raw.slots : [];
    const slots = defaults.slots.map((slot) => {
      const existing = rawSlots.find((candidate) => candidate?.id === slot.id);
      return {
        ...slot,
        ...existing,
        index: slot.index,
        label: typeof existing?.label === 'string' && existing.label.trim() ? existing.label.trim().slice(0, 32) : slot.label,
        hasAudio: Boolean(existing?.hasAudio),
        durationMs: Math.max(0, Math.round(Number(existing?.durationMs ?? 0))),
        updatedAt: typeof existing?.updatedAt === 'number' ? existing.updatedAt : null,
        repeatEnabled: Boolean(existing?.repeatEnabled),
        repeatIntervalSec: Math.max(1, Math.min(300, Math.round(Number(existing?.repeatIntervalSec ?? DEFAULT_REPEAT_INTERVAL_SEC)))),
      };
    });

    return {
      version: 1,
      callsign,
      slotCount: Math.max(MIN_SLOT_COUNT, Math.min(MAX_SLOT_COUNT, Math.round(Number(raw.slotCount ?? DEFAULT_SLOT_COUNT)))),
      slots,
    };
  }

  private createDefaultManifest(callsign: string): StoredManifest {
    return {
      version: 1,
      callsign,
      slotCount: DEFAULT_SLOT_COUNT,
      slots: Array.from({ length: MAX_SLOT_COUNT }, (_, index) => ({
        id: String(index + 1),
        index: index + 1,
        label: `M${index + 1}`,
        hasAudio: false,
        durationMs: 0,
        updatedAt: null,
        repeatEnabled: false,
        repeatIntervalSec: DEFAULT_REPEAT_INTERVAL_SEC,
      })),
    };
  }

  private toPanel(manifest: StoredManifest): VoiceKeyerPanel {
    return {
      callsign: manifest.callsign,
      slotCount: manifest.slotCount,
      maxSlotCount: MAX_SLOT_COUNT,
      slots: manifest.slots,
    };
  }

  private requireSlot(manifest: { slots: VoiceKeyerSlot[] }, slotId: string): VoiceKeyerSlot {
    const slot = manifest.slots.find((candidate) => candidate.id === slotId);
    if (!slot) {
      throw new Error(`Unknown voice keyer slot: ${slotId}`);
    }
    return slot;
  }

  private requireCallsign(callsign: string): string {
    const normalized = VoiceKeyerManager.normalizeCallsign(callsign);
    if (!normalized) {
      throw new Error('Callsign is required');
    }
    return normalized;
  }

  private async applyActiveSlotConfig(
    callsign: string,
    slot: VoiceKeyerSlot,
    update: { repeatEnabled?: boolean; repeatIntervalSec?: number },
  ): Promise<void> {
    const active = this.active;
    if (!active || active.callsign !== callsign || active.slotId !== slot.id) {
      return;
    }

    if (active.repeating && update.repeatEnabled === false) {
      await this.stopActive('repeat disabled');
      return;
    }

    if (
      typeof update.repeatIntervalSec !== 'number'
      || !active.repeating
      || this.status.mode !== 'repeat-waiting'
      || !active.timerResolve
    ) {
      return;
    }

    if (active.timer) {
      clearTimeout(active.timer);
    }
    const waitMs = slot.repeatIntervalSec * 1000;
    const nextRunAt = Date.now() + waitMs;
    this.setStatus(this.statusFor(active, 'repeat-waiting', nextRunAt));
    active.timer = setTimeout(() => {
      active.timer = null;
      const resolve = active.timerResolve;
      active.timerResolve = null;
      resolve?.();
    }, waitMs);
  }

  private async getRootDir(): Promise<string> {
    if (!this.rootDir) {
      this.rootDir = this.deps.storageRootDir ?? await getDataFilePath('voice-keyer');
      await fs.mkdir(this.rootDir, { recursive: true });
    }
    return this.rootDir;
  }

  private async getCallsignDir(callsign: string): Promise<string> {
    return join(await this.getRootDir(), VoiceKeyerManager.safeCallsign(callsign));
  }

  private async getManifestPath(callsign: string): Promise<string> {
    return join(await this.getCallsignDir(callsign), 'manifest.json');
  }

  private async getSlotAudioPath(callsign: string, slotId: string): Promise<string> {
    return join(await this.getCallsignDir(callsign), 'slots', `${slotId}.wav`);
  }

  private statusFor(
    active: ActivePlayback,
    mode: VoiceKeyerStatus['mode'],
    nextRunAt: number | null = null,
    error: string | null = null,
  ): VoiceKeyerStatus {
    return {
      active: true,
      callsign: active.callsign,
      slotId: active.slotId,
      mode,
      repeating: active.repeating,
      startedBy: active.startedBy,
      startedByLabel: active.startedByLabel,
      nextRunAt,
      error,
    };
  }

  private idleStatus(): VoiceKeyerStatus {
    return {
      active: false,
      callsign: null,
      slotId: null,
      mode: 'idle',
      repeating: false,
      startedBy: null,
      startedByLabel: null,
      nextRunAt: null,
      error: null,
    };
  }

  private setStatus(status: VoiceKeyerStatus): void {
    this.status = status;
    this.emit('voiceKeyerStatusChanged', status);
  }
}
