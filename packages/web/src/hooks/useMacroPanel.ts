import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import type {
  KeyboardMessagePanel,
  KeyboardMessageSlot,
  KeyboardMessageSlotUpdate,
} from '@tx5dr/contracts';

/**
 * Message-panel persistence for a keyboard mode. Each function resolves to the
 * panel the server returns after the change. Keep the adapter object stable
 * (module constant or useMemo) so the panel is not reloaded on every render.
 */
export interface MacroPanelAdapter {
  getPanel(callsign: string): Promise<KeyboardMessagePanel>;
  updatePanel(callsign: string, update: { slotCount: number }): Promise<KeyboardMessagePanel>;
  updateSlot(callsign: string, slotId: string, update: KeyboardMessageSlotUpdate): Promise<KeyboardMessagePanel>;
  deleteSlot(callsign: string, slotId: string): Promise<KeyboardMessagePanel>;
  swapSlots(callsign: string, slotIdA: string, slotIdB: string): Promise<KeyboardMessagePanel>;
}

export type MacroPanelMode = 'operate' | 'edit';

export type MacroSlotUpdate = Partial<Pick<KeyboardMessageSlot, 'label' | 'text' | 'repeatEnabled' | 'repeatIntervalSec'>>;

export interface UseMacroPanelOptions {
  /** Load the panel only while true (e.g. while the engine is in this mode). */
  enabled: boolean;
  /** Debounce for queued slot updates (repeat interval edits). Default 350 ms. */
  queuedUpdateDelayMs?: number;
}

export interface UseMacroPanelResult {
  /** The callsign the panel belongs to (trimmed operator callsign, may be ''). */
  callsign: string;
  panel: KeyboardMessagePanel | null;
  panelLoading: boolean;
  /** `panel.slots` limited to `panel.slotCount`. */
  visibleSlots: KeyboardMessageSlot[];
  panelMode: MacroPanelMode;
  setPanelMode(mode: MacroPanelMode): void;
  canIncreaseSlots: boolean;
  canDecreaseSlots: boolean;
  loadPanel(): Promise<void>;
  /** Optimistic local edit without persisting. */
  updateSlotLocal(slotId: string, update: MacroSlotUpdate): void;
  /** Persist a slot change; resolves to the new panel or null after a toast. */
  updateSlot(slotId: string, update: MacroSlotUpdate): Promise<KeyboardMessagePanel | null>;
  /** Persist a slot change after the debounce, replacing a pending one for the same slot. */
  queueSlotUpdate(slotId: string, update: MacroSlotUpdate): void;
  /** Clamp to 1..300 s, update locally and queue the persisted update. */
  setRepeatIntervalSec(slot: KeyboardMessageSlot, value: string): void;
  changeSlotCount(delta: number): Promise<void>;
  deleteSlot(slot: KeyboardMessageSlot): Promise<void>;
  /** Optimistically swap the slot contents and persist; reloads on failure. */
  swapSlots(sourceSlotId: string, targetSlotId: string): Promise<void>;
}

const MIN_SLOT_COUNT = 3;
const DEFAULT_MAX_SLOT_COUNT = 12;
const SWAP_FIELDS = ['label', 'text', 'repeatEnabled', 'repeatIntervalSec'] as const;

export function clampRepeatIntervalSec(value: unknown): number {
  return Math.max(1, Math.min(300, Math.round(Number(value) || 1)));
}

export function useMacroPanel(
  adapter: MacroPanelAdapter,
  callsign: string,
  { enabled, queuedUpdateDelayMs = 350 }: UseMacroPanelOptions,
): UseMacroPanelResult {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<KeyboardMessagePanel | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelMode, setPanelMode] = useState<MacroPanelMode>('operate');
  const slotUpdateTimersRef = useRef<Record<string, number>>({});

  const showError = useCallback((err: unknown) => {
    addToast({
      title: t('common:error'),
      description: String(err),
      color: 'danger',
    });
  }, [t]);

  const loadPanel = useCallback(async () => {
    if (!callsign) {
      setPanel(null);
      return;
    }
    setPanelLoading(true);
    try {
      setPanel(await adapter.getPanel(callsign));
    } catch {
      // Keep the keyer usable even if the preset panel cannot be loaded temporarily.
    } finally {
      setPanelLoading(false);
    }
  }, [adapter, callsign]);

  useEffect(() => {
    if (enabled) {
      void loadPanel();
    }
  }, [enabled, loadPanel]);

  useEffect(() => () => {
    Object.values(slotUpdateTimersRef.current).forEach(timer => window.clearTimeout(timer));
    slotUpdateTimersRef.current = {};
  }, []);

  const visibleSlots = useMemo(() => panel?.slots.slice(0, panel.slotCount) ?? [], [panel]);

  const updateSlotLocal = useCallback((slotId: string, update: MacroSlotUpdate) => {
    setPanel(current => current ? {
      ...current,
      slots: current.slots.map(item => item.id === slotId ? { ...item, ...update } : item),
    } : current);
  }, []);

  const updateSlot = useCallback(async (
    slotId: string,
    update: MacroSlotUpdate,
  ): Promise<KeyboardMessagePanel | null> => {
    if (!callsign) return null;
    try {
      const nextPanel = await adapter.updateSlot(callsign, slotId, update);
      setPanel(nextPanel);
      return nextPanel;
    } catch (err) {
      showError(err);
      return null;
    }
  }, [adapter, callsign, showError]);

  const queueSlotUpdate = useCallback((slotId: string, update: MacroSlotUpdate) => {
    const timers = slotUpdateTimersRef.current;
    if (timers[slotId]) window.clearTimeout(timers[slotId]);
    timers[slotId] = window.setTimeout(() => {
      delete timers[slotId];
      void updateSlot(slotId, update);
    }, queuedUpdateDelayMs);
  }, [queuedUpdateDelayMs, updateSlot]);

  const setRepeatIntervalSec = useCallback((slot: KeyboardMessageSlot, value: string) => {
    const repeatIntervalSec = clampRepeatIntervalSec(value);
    updateSlotLocal(slot.id, { repeatIntervalSec });
    queueSlotUpdate(slot.id, { repeatIntervalSec });
  }, [queueSlotUpdate, updateSlotLocal]);

  const changeSlotCount = useCallback(async (delta: number) => {
    if (!callsign || !panel) return;
    try {
      setPanel(await adapter.updatePanel(callsign, { slotCount: panel.slotCount + delta }));
    } catch (err) {
      showError(err);
    }
  }, [adapter, callsign, panel, showError]);

  const deleteSlot = useCallback(async (slot: KeyboardMessageSlot) => {
    if (!callsign) return;
    try {
      setPanel(await adapter.deleteSlot(callsign, slot.id));
    } catch (err) {
      showError(err);
    }
  }, [adapter, callsign, showError]);

  const swapSlots = useCallback(async (sourceSlotId: string, targetSlotId: string) => {
    if (!callsign || sourceSlotId === targetSlotId) return;

    setPanel(current => {
      if (!current) return current;
      const sourceSlot = current.slots.find(s => s.id === sourceSlotId);
      const targetSlot = current.slots.find(s => s.id === targetSlotId);
      if (!sourceSlot || !targetSlot) return current;
      return {
        ...current,
        slots: current.slots.map(slot => {
          if (slot.id === sourceSlotId) {
            const merged = { ...slot };
            for (const f of SWAP_FIELDS) merged[f] = targetSlot[f] as never;
            return merged;
          }
          if (slot.id === targetSlotId) {
            const merged = { ...slot };
            for (const f of SWAP_FIELDS) merged[f] = sourceSlot[f] as never;
            return merged;
          }
          return slot;
        }),
      };
    });

    try {
      setPanel(await adapter.swapSlots(callsign, sourceSlotId, targetSlotId));
    } catch (err) {
      showError(err);
      void loadPanel();
    }
  }, [adapter, callsign, loadPanel, showError]);

  return {
    callsign,
    panel,
    panelLoading,
    visibleSlots,
    panelMode,
    setPanelMode,
    canIncreaseSlots: (panel?.slotCount ?? 0) < (panel?.maxSlotCount ?? DEFAULT_MAX_SLOT_COUNT),
    canDecreaseSlots: (panel?.slotCount ?? MIN_SLOT_COUNT) > MIN_SLOT_COUNT,
    loadPanel,
    updateSlotLocal,
    updateSlot,
    queueSlotUpdate,
    setRepeatIntervalSec,
    changeSlotCount,
    deleteSlot,
    swapSlots,
  };
}
