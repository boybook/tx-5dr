import { useEffect } from 'react';
import type { KeyboardMessageSlot } from '@tx5dr/contracts';
import { matchesKeyerShortcut, type KeyerShortcutPreset } from '../utils/keyerShortcutPreferences';

export interface UseGlobalSlotHotkeysOptions<TSlot extends Pick<KeyboardMessageSlot, 'id' | 'text'>> {
  /**
   * Whether F-keys may trigger slots. Pass false unless this mode's panel is
   * the active one, in operate view, with a callsign, so only one panel reacts.
   */
  enabled: boolean;
  /** Slots that can be triggered (normally the visible ones). */
  slots: TSlot[];
  /** Slot id → preset; slots without an entry have no shortcut. */
  shortcuts: Record<string, KeyerShortcutPreset>;
  /** True while this mode is transmitting: Escape stops it and F-keys are ignored. */
  isActive: boolean;
  /** Whether Escape may stop an active transmission. Default true. */
  escapeEnabled?: boolean;
  /** Let F-keys trigger slots while `isActive` (e.g. type-ahead appends). Default false. */
  allowTriggerWhileActive?: boolean;
  /** Ignore F-keys while focus is inside a dialog (e.g. a settings modal). Escape still stops. */
  ignoreInDialogs?: boolean;
  /** Ignore key auto-repeat (holding an F-key must not send the macro several times). */
  ignoreAutoRepeat?: boolean;
  /** Called for a matching slot with text; the event is already consumed. */
  onTrigger(slot: TSlot): void;
  /** Called on Escape while active. */
  onStop(): void;
}

const F_KEY_CODE = /^F(?:[1-9]|1[0-2])$/;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * Window-level F1-F12 / Escape handling for a message panel. The listener runs
 * in the capture phase so F-keys work while a text input is focused, and a
 * triggered key is stopped from reaching other handlers.
 */
export function useGlobalSlotHotkeys<TSlot extends Pick<KeyboardMessageSlot, 'id' | 'text'>>({
  enabled,
  slots,
  shortcuts,
  isActive,
  escapeEnabled = true,
  allowTriggerWhileActive = false,
  ignoreInDialogs = false,
  ignoreAutoRepeat = false,
  onTrigger,
  onStop,
}: UseGlobalSlotHotkeysOptions<TSlot>): void {
  // The listener is re-registered whenever an input changes (pass stable
  // callbacks to avoid churn); this keeps the latest values without refs.
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const isFKey = F_KEY_CODE.test(event.code);
      if (isTypingTarget(event.target) && !isFKey && event.key !== 'Escape') return;

      if (event.key === 'Escape' && isActive && escapeEnabled) {
        event.preventDefault();
        onStop();
        return;
      }

      if (!enabled) return;
      if (ignoreInDialogs && (event.target as Element | null)?.closest?.('[role="dialog"]')) return;
      if (ignoreAutoRepeat && event.repeat && F_KEY_CODE.test(event.code)) {
        event.preventDefault();
        return;
      }

      const slot = slots.find(candidate => {
        const preset = shortcuts[candidate.id];
        return preset !== undefined && matchesKeyerShortcut(event.code, preset);
      });

      if (!slot || !slot.text || (isActive && !allowTriggerWhileActive)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onTrigger(slot);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [allowTriggerWhileActive, enabled, escapeEnabled, ignoreAutoRepeat, ignoreInDialogs, isActive, onStop, onTrigger, shortcuts, slots]);
}
