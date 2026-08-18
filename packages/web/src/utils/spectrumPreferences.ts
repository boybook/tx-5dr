import type { SpectrumKind } from '@tx5dr/contracts';
import { createLogger } from './logger';

const logger = createLogger('SpectrumPrefs');

const STORAGE_KEY = 'tx5dr_spectrum_preferences';

const VALID_KINDS = new Set<SpectrumKind>(['audio', 'radio-sdr', 'openwebrx-sdr']);

interface SpectrumPreferenceStore {
  profileSelections: Record<string, SpectrumKind>;
  lastUpdated: number;
}

function isSpectrumKind(value: unknown): value is SpectrumKind {
  return typeof value === 'string' && VALID_KINDS.has(value as SpectrumKind);
}

function readStore(): SpectrumPreferenceStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { profileSelections: {}, lastUpdated: Date.now() };
    }

    const parsed = JSON.parse(raw) as Partial<SpectrumPreferenceStore>;
    const profileSelections: Record<string, SpectrumKind> = {};
    if (parsed.profileSelections && typeof parsed.profileSelections === 'object') {
      for (const [key, value] of Object.entries(parsed.profileSelections)) {
        if (isSpectrumKind(value)) {
          profileSelections[key] = value;
        }
      }
    }
    return {
      profileSelections,
      lastUpdated: parsed.lastUpdated ?? Date.now(),
    };
  } catch (error) {
    logger.warn('Failed to read spectrum preferences', error);
    return { profileSelections: {}, lastUpdated: Date.now() };
  }
}

function writeStore(store: SpectrumPreferenceStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...store,
      lastUpdated: Date.now(),
    }));
  } catch (error) {
    logger.error('Failed to save spectrum preferences', error);
  }
}

export function getPreferredSpectrumKind(profileId: string | null): SpectrumKind | null {
  if (!profileId) {
    return null;
  }
  const store = readStore();
  return store.profileSelections[profileId] ?? null;
}

export function setPreferredSpectrumKind(profileId: string | null, kind: SpectrumKind): void {
  if (!profileId || !isSpectrumKind(kind)) {
    return;
  }
  const store = readStore();
  store.profileSelections[profileId] = kind;
  writeStore(store);
}
