const STORAGE_KEY = 'spectrum-display-collapsed';

let paused = readInitialPaused();

function readInitialPaused(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function isSpectrumSubscriptionPaused(): boolean {
  return paused;
}

export function setSpectrumSubscriptionPaused(nextPaused: boolean): void {
  paused = nextPaused;

  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, nextPaused ? 'true' : 'false');
  } catch {
    // Ignore storage failures; the in-memory flag still protects this session.
  }
}

export function readSpectrumSubscriptionPaused(): boolean {
  paused = readInitialPaused();
  return paused;
}

export const SPECTRUM_COLLAPSED_STORAGE_KEY = STORAGE_KEY;
