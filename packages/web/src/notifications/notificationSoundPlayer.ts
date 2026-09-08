import type { NotificationSoundId } from './clientNotificationPreferences';
import { createLogger } from '../utils/logger';

const logger = createLogger('NotificationSoundPlayer');
export const NOTIFICATION_SOUND_URLS: Record<NotificationSoundId, string> = {
  glass: new URL('../assets/notification-sounds/glass.wav', import.meta.url).href,
  glassLong: new URL('../assets/notification-sounds/glass-long.wav', import.meta.url).href,
  pluck: new URL('../assets/notification-sounds/pluck.wav', import.meta.url).href,
  pluckAlt: new URL('../assets/notification-sounds/pluck-alt.wav', import.meta.url).href,
  confirmation: new URL('../assets/notification-sounds/confirmation.wav', import.meta.url).href,
  confirmationAlt: new URL('../assets/notification-sounds/confirmation-alt.wav', import.meta.url).href,
  bong: new URL('../assets/notification-sounds/bong.wav', import.meta.url).href,
  question: new URL('../assets/notification-sounds/question.wav', import.meta.url).href,
};
export type NotificationSoundStatus = 'locked' | 'ready' | 'unsupported' | 'error';

export class NotificationSoundPlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private buffers = new Map<NotificationSoundId, AudioBuffer>();
  private pending = new Map<NotificationSoundId, Promise<void>>();
  private listeners = new Set<() => void>();
  private status: NotificationSoundStatus = 'locked';
  private volume = 0.5;
  private generation = 0;
  private playbackGeneration = 0;
  private resourceError = false;

  getStatus = (): NotificationSoundStatus => this.status;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private refresh = (): void => {
    const next = typeof AudioContext === 'undefined' ? 'unsupported'
      : this.resourceError ? 'error'
        : this.context?.state === 'running' ? 'ready' : 'locked';
    if (this.status === next) return;
    this.status = next;
    this.listeners.forEach(listener => listener());
  };

  initialize(): void { this.refresh(); }

  async unlock(): Promise<boolean> {
    if (typeof AudioContext === 'undefined') {
      this.refresh();
      return false;
    }
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.context.addEventListener('statechange', this.refresh);
        this.gain = this.context.createGain();
        this.gain.gain.value = this.volume;
        this.gain.connect(this.context.destination);
      }
      const context = this.context;
      // Invoke resume synchronously in the user gesture, before fetching assets.
      if (context.state !== 'running') await context.resume();
      this.refresh();
      return context === this.context && context.state === 'running';
    } catch (error) {
      logger.warn('Failed to unlock notification audio', error);
      this.refresh();
      return false;
    }
  }

  async prepare(sound: NotificationSoundId): Promise<void> {
    const context = this.context;
    if (!context || this.buffers.has(sound)) return;
    const existing = this.pending.get(sound);
    if (existing) return existing;
    const generation = this.generation;
    const task = (async () => {
      try {
        const response = await fetch(NOTIFICATION_SOUND_URLS[sound]);
        if (!response.ok) throw new Error(`Sound asset request failed: ${response.status}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (generation !== this.generation) return;
        this.buffers.set(sound, buffer);
        this.resourceError = false;
      } catch (error) {
        if (generation !== this.generation) return;
        this.resourceError = true;
        logger.warn('Failed to load notification sound', error);
      } finally {
        if (generation === this.generation) {
          this.pending.delete(sound);
          this.refresh();
        }
      }
    })();
    this.pending.set(sound, task);
    return task;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  /** Event delivery never waits for permission or assets and never queues audio. */
  play(sound: NotificationSoundId): boolean {
    const buffer = this.buffers.get(sound);
    if (!this.context || this.context.state !== 'running' || !this.gain || !buffer) return false;
    this.stop();
    if (this.volume === 0) return false;
    try {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      source.onended = () => {
        source.disconnect();
        if (this.source === source) this.source = null;
      };
      this.source = source;
      source.start();
      return true;
    } catch (error) {
      this.resourceError = true;
      this.refresh();
      logger.warn('Failed to play notification sound', error);
      return false;
    }
  }

  async preview(sound: NotificationSoundId): Promise<boolean> {
    this.stop();
    const generation = this.playbackGeneration;
    if (!await this.unlock()) return false;
    await this.prepare(sound);
    return generation === this.playbackGeneration && this.play(sound);
  }

  stop(): void {
    this.playbackGeneration += 1;
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }

  dispose(): void {
    this.stop();
    this.generation += 1;
    this.context?.removeEventListener('statechange', this.refresh);
    void this.context?.close().catch(error => logger.warn('Failed to close notification audio', error));
    this.context = null;
    this.gain = null;
    this.buffers.clear();
    this.pending.clear();
    this.resourceError = false;
    this.refresh();
  }
}
