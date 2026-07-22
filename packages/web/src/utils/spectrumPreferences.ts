import type { SpectrumKind } from '@tx5dr/contracts';
import { createLogger } from './logger';

const logger = createLogger('SpectrumPrefs');

const STORAGE_KEY = 'tx5dr_spectrum_preferences';
/** Fallback bucket when no active profile id is available yet. */
const GLOBAL_SELECTION_KEY = '__global__';

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

function selectionKey(profileId: string | null): string {
  return profileId ?? GLOBAL_SELECTION_KEY;
}

export function getPreferredSpectrumKind(profileId: string | null): SpectrumKind | null {
  const store = readStore();
  const key = selectionKey(profileId);
  return store.profileSelections[key]
    ?? (profileId ? store.profileSelections[GLOBAL_SELECTION_KEY] ?? null : null);
}

export function setPreferredSpectrumKind(profileId: string | null, kind: SpectrumKind): void {
  if (!isSpectrumKind(kind)) {
    return;
  }
  const store = readStore();
  store.profileSelections[selectionKey(profileId)] = kind;
  // Keep a global fallback so refresh still works before profile id is known.
  store.profileSelections[GLOBAL_SELECTION_KEY] = kind;
  writeStore(store);
}
