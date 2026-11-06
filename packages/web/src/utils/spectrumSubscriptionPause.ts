const STORAGE_KEY = 'spectrum-display-collapsed';

// The collapse preference belongs to the main workspace. A standalone spectrum
// page detaches from it so it always subscribes on open and never rewrites the
// workspace preference while both pages are open side by side.
let persisted = true;
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

  if (!persisted || typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, nextPaused ? 'true' : 'false');
  } catch {
    // Ignore storage failures; the in-memory flag still protects this session.
  }
}

export function readSpectrumSubscriptionPaused(): boolean {
  if (persisted) {
    paused = readInitialPaused();
  }
  return paused;
}

/**
 * Makes the pause state page-local and initially unpaused. Called once by the
 * standalone spectrum entry before rendering.
 */
export function detachSpectrumSubscriptionPauseFromWorkspace(): void {
  persisted = false;
  paused = false;
}

export const SPECTRUM_COLLAPSED_STORAGE_KEY = STORAGE_KEY;
