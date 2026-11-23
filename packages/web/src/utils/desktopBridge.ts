import type { DesktopBridgeCapability, DesktopStationKind } from '@tx5dr/contracts';

/**
 * Desktop shell capability detection.
 *
 * The page may be served to a browser, to the shell's embedded station or to a
 * shell connected to this station remotely. Code that needs a shell capability
 * checks it here instead of inferring it from the user agent.
 */
export function hasDesktopCapability(capability: DesktopBridgeCapability): boolean {
  if (typeof window === 'undefined') return false;
  return window.electronAPI?.bridge?.capabilities.includes(capability) ?? false;
}

/** Station kind reported by the shell, or null outside a bridge-aware shell. */
export function getDesktopStationKind(): DesktopStationKind | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI?.bridge?.kind ?? null;
}
