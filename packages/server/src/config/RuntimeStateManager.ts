import type { PSKReporterStats, RepeaterShift, ToneSquelchMode } from '@tx5dr/contracts';
import { getConfigFilePath } from '../utils/app-paths.js';
import { JsonFileStore, PersistenceCoordinator } from '../utils/persistence/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RuntimeStateManager');

export interface LastSelectedFrequencyState {
  frequency: number;
  mode: string;
  radioMode?: string;
  band: string;
  description?: string;
}

export interface LastVoiceFrequencyState {
  frequency: number;
  radioMode?: string;
  band: string;
  description?: string;
  repeaterShift?: RepeaterShift;
  repeaterOffsetHz?: number;
  toneMode?: ToneSquelchMode;
  ctcssToneTenthsHz?: number;
  dcsCode?: number;
}

export interface RuntimeState {
  lastSelectedFrequency?: LastSelectedFrequencyState | null;
  lastVoiceFrequency?: LastVoiceFrequencyState | null;
  lastVolumeGain?: { gain: number; gainDb: number } | null;
  volumeGainMap?: Record<string, { gain: number; gainDb: number }> | null;
  lastEngineMode?: 'digital' | 'voice';
  lastDigitalModeName?: string;
  pskreporterStats?: Partial<PSKReporterStats>;
  authLastUsedAt?: Record<string, number>;
}

function validateRuntimeState(value: unknown): RuntimeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime state root must be an object');
  }
  return value as RuntimeState;
}

export class RuntimeStateManager {
  private static instance: RuntimeStateManager | null = null;
  private store: JsonFileStore<RuntimeState> | null = null;
  private unregister: (() => void) | null = null;

  static getInstance(): RuntimeStateManager {
    if (!this.instance) {
      this.instance = new RuntimeStateManager();
    }
    return this.instance;
  }

  async initialize(seed?: Partial<RuntimeState>): Promise<void> {
    if (this.store) {
      const loaded = this.store.get();
      if (this.applySeed(loaded, seed)) {
        await this.store.set(loaded, { defer: true });
      }
      return;
    }
    const filePath = await getConfigFilePath('runtime-state.json');
    this.store = new JsonFileStore<RuntimeState>(filePath, {
      defaultValue: () => ({}),
      validate: validateRuntimeState,
      backups: 3,
      debounceMs: 1500,
    });
    const loaded = await this.store.load();
    const seeded = this.applySeed(loaded, seed);
    if (seeded) {
      await this.store.set(loaded, { defer: true });
    }
    this.unregister = PersistenceCoordinator.getInstance().register({
      name: 'runtime-state',
      flush: async () => this.flush(),
    });
    logger.info('runtime state initialized', { filePath });
  }

  isInitialized(): boolean {
    return this.store !== null;
  }

  private applySeed(state: RuntimeState, seed?: Partial<RuntimeState>): boolean {
    if (!seed) return false;
    let changed = false;
    for (const [key, value] of Object.entries(seed) as Array<[keyof RuntimeState, RuntimeState[keyof RuntimeState]]>) {
      if (value === undefined) continue;
      if (state[key] === undefined) {
        (state as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    return changed;
  }

  getState(): RuntimeState {
    return { ...this.requireStore().get() };
  }

  get<K extends keyof RuntimeState>(key: K): RuntimeState[K] | undefined {
    return this.requireStore().get()[key];
  }

  async set<K extends keyof RuntimeState>(key: K, value: RuntimeState[K], options: { defer?: boolean } = { defer: true }): Promise<void> {
    const store = this.requireStore();
    const next = { ...store.get(), [key]: value };
    await store.set(next, options);
  }

  async patch(patch: Partial<RuntimeState>, options: { defer?: boolean } = { defer: true }): Promise<void> {
    const store = this.requireStore();
    await store.set({ ...store.get(), ...patch }, options);
  }

  async flush(): Promise<void> {
    await this.store?.flush();
  }

  disposeForTests(): void {
    this.unregister?.();
    this.unregister = null;
    this.store = null;
  }

  private requireStore(): JsonFileStore<RuntimeState> {
    if (!this.store) {
      throw new Error('RuntimeStateManager not initialized');
    }
    return this.store;
  }
}
