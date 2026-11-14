/**
 * Keyboard focus hand-off between RTTY panels: the transmit buffer registers
 * its input, and other panels (terminal clicks, global typing) return focus
 * to it so keystrokes are never silently lost.
 */
let target: (() => void) | null = null;

/** Registers the transmit buffer's focus function; returns an unregister callback. */
export function registerRttyTxBufferFocus(focus: () => void): () => void {
  target = focus;
  return () => {
    if (target === focus) target = null;
  };
}

/** True on mouse/trackpad devices; on touch screens focusing an input opens the soft keyboard. */
export function hasFinePointer(): boolean {
  try {
    return typeof window.matchMedia !== 'function' || window.matchMedia('(pointer: fine)').matches;
  } catch {
    return true;
  }
}

/**
 * Moves keyboard focus to the transmit buffer, if one is mounted and the
 * device has a fine pointer (never pops up a soft keyboard). Returns whether it did.
 */
export function focusRttyTxBuffer(): boolean {
  if (!target || !hasFinePointer()) return false;
  target();
  return true;
}
