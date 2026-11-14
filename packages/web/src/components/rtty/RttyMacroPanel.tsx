import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from '@heroui/react';
import { faKeyboard } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import type { KeyboardMessageSlot, KeyboardPlaceholderValues } from '@tx5dr/contracts';
import { useRtty } from '../../hooks/useRtty';
import { useMacroPanel, type MacroPanelAdapter } from '../../hooks/useMacroPanel';
import { useSlotShortcuts } from '../../hooks/useSlotShortcuts';
import { useGlobalSlotHotkeys } from '../../hooks/useGlobalSlotHotkeys';
import { useRttyKeyboardFlow, type UseRttyKeyboardFlowOptions } from '../../hooks/useRttyKeyboardFlow';
import { useCurrentOperatorId, useOperators } from '../../store/radioStore';
import { useRttyQSODraft } from '../../store/rttyQsoDraftStore';
import { rttyKeyerShortcutPreferences } from '../../utils/rttyKeyerShortcutPreferences';
import { KeyboardMacroPanel, type MacroSlotPhase } from '../keyboard-mode/KeyboardMacroPanel';
import { useMessagePlaceholders } from '../keyboard-mode/useMessagePlaceholders';
import type { KeyboardModeI18n } from '../keyboard-mode/modeText';
import { RttyTxBuffer } from './RttyTxBuffer';
import { focusRttyTxBuffer } from './rttyFocus';

const RTTY_MACRO_I18N: KeyboardModeI18n = {
  prefix: 'radio:rtty.macro',
  defaults: {
    keyerTitle: 'RTTY Macros',
    modeTabs: 'RTTY macro mode',
    operateMode: 'Operate',
    placeholderMissingToast: 'Fill in {{placeholders}} before sending this RTTY message.',
    placeholderMissingTitle: 'Missing RTTY placeholder value',
  },
};

/** `{RX}` ends the transmission once everything before it has been sent. */
const RTTY_CONTROL_TOKENS = ['RX'] as const;

/** How long the transmit buffer shows "stopped" after the operator stops. */
const STOPPED_FLASH_MS = 2500;

const RTTY_MESSAGE_PANEL_ADAPTER: MacroPanelAdapter = {
  getPanel: async (callsign) => (await api.getRttyMessagePanel(callsign)).panel,
  updatePanel: async (callsign, update) => (await api.updateRttyMessagePanel(callsign, update)).panel,
  updateSlot: async (callsign, slotId, update) => (await api.updateRttyMessageSlot(callsign, slotId, update)).panel,
  deleteSlot: async (callsign, slotId) => (await api.deleteRttyMessageSlot(callsign, slotId)).panel,
  swapSlots: async (callsign, slotIdA, slotIdB) => (await api.swapRttyMessageSlots(callsign, slotIdA, slotIdB)).panel,
};

/** Bits per character on air: start + 5 data + stop bits. */
function estimateRttyDurationMs(text: string, baud: number, stopBits: number): number {
  return Math.round((text.length * (6 + stopBits) * 1000) / baud);
}

/**
 * Keyboard flow shortcuts, in their own component: they follow the receive
 * transcript, which changes many times a second, and must not re-render the panel.
 */
function RttyKeyboardFlow(props: UseRttyKeyboardFlowOptions): null {
  useRttyKeyboardFlow(props);
  return null;
}

interface RttyMacroPanelProps {
  embedded?: boolean;
}

/**
 * RTTY macro panel: the shared keyboard-mode macro panel in its compact grid
 * layout (F1–F12, per-slot repeat, edit tab, drag to reorder) with the RTTY
 * transmit buffer as its input area.
 *
 * Unlike CW, macros may be triggered while transmitting: the server buffers
 * the text after whatever is still unsent, so operators can chain macros.
 * A slot with repeat enabled loops (e.g. CQ) until a station answers, another
 * message is sent, or the operator stops it.
 */
export function RttyMacroPanel({ embedded = false }: RttyMacroPanelProps = {}) {
  const { t } = useTranslation('radio');
  const { txStatus, config, isRttyMode, canTransmit, playMessage, abort } = useRtty();
  const { operators } = useOperators();
  const { currentOperatorId } = useCurrentOperatorId();
  const { hisCallsign, trst, rrst } = useRttyQSODraft();
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);

  const myCallsign = operators.find(o => o.id === currentOperatorId)?.context?.myCall?.trim() || '';
  const placeholderValues = useMemo<KeyboardPlaceholderValues>(() => ({
    myCall: myCallsign || undefined,
    hisCall: hisCallsign || undefined,
    trst: trst || undefined,
    rrst: rrst || undefined,
  }), [hisCallsign, myCallsign, rrst, trst]);
  const isActive = txStatus?.active ?? false;
  const onAir = txStatus?.phase === 'on_air' || txStatus?.phase === 'draining';
  const repeat = txStatus?.repeat ?? null;
  // Only a repeating slot is "active" in the panel: plain macros chain instead of stopping.
  const activeSlotId = repeat?.messageId ?? null;
  const activeSlotPhase: MacroSlotPhase | null = repeat
    ? (repeat.nextRunAt !== null ? 'waiting' : 'transmitting')
    : null;

  const controlTokenLabels = useMemo(() => ({
    RX: t('rtty.macro.controlRx', 'End the transmission here and return to receive'),
  }), [t]);

  const macro = useMacroPanel(RTTY_MESSAGE_PANEL_ADAPTER, myCallsign, { enabled: isRttyMode });
  const { visibleSlots, updateSlot, updateSlotLocal } = macro;
  const shortcuts = useSlotShortcuts(rttyKeyerShortcutPreferences, myCallsign, macro.panel?.slots);
  const placeholders = useMessagePlaceholders({
    values: placeholderValues,
    i18n: RTTY_MACRO_I18N,
    controlTokens: RTTY_CONTROL_TOKENS,
    controlTokenLabels,
  });
  const { resolveForSend } = placeholders;

  useEffect(() => {
    if (stoppedAt === null) return undefined;
    const timer = window.setTimeout(() => setStoppedAt(null), STOPPED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [stoppedAt]);

  const stop = useCallback(() => {
    abort();
    setStoppedAt(Date.now());
  }, [abort]);

  /** Sends a slot (looping it when its repeat is on); returns whether it was sent. */
  const sendSlot = useCallback((slot: KeyboardMessageSlot): boolean => {
    if (!myCallsign || !slot.text || !canTransmit) return false;
    if (!resolveForSend(slot.text)) return false;
    if (slot.repeatEnabled) {
      playMessage(myCallsign, slot.id, placeholderValues, { repeat: true });
    } else {
      playMessage(myCallsign, slot.id, placeholderValues);
    }
    return true;
  }, [canTransmit, myCallsign, placeholderValues, playMessage, resolveForSend]);

  const handlePlay = useCallback((slot: KeyboardMessageSlot) => {
    if (repeat?.messageId === slot.id) {
      // The looping slot's button stops the loop (and its transmission, if on air).
      if (isActive) {
        stop();
      } else if (myCallsign) {
        playMessage(myCallsign, slot.id, placeholderValues, { repeat: false });
      }
      return;
    }
    sendSlot(slot);
  }, [isActive, myCallsign, placeholderValues, playMessage, repeat, sendSlot, stop]);

  /** A macro button pressed with the mouse returns the keyboard to the transmit buffer. */
  const handlePressSlot = useCallback((slot: KeyboardMessageSlot) => {
    handlePlay(slot);
    focusRttyTxBuffer();
  }, [handlePlay]);

  const handleRepeatToggle = useCallback(async (slot: KeyboardMessageSlot) => {
    const repeatEnabled = !slot.repeatEnabled;
    if (repeatEnabled && slot.text && !resolveForSend(slot.text)) return;
    updateSlotLocal(slot.id, { repeatEnabled });
    const updatedPanel = await updateSlot(slot.id, { repeatEnabled });
    if (!updatedPanel) {
      updateSlotLocal(slot.id, { repeatEnabled: slot.repeatEnabled });
      return;
    }
    if (!myCallsign) return;
    // Switching the loop on only arms the macro (a misclick must not key up);
    // playing it starts the loop. Switching it off stops a running loop.
    if (!repeatEnabled && repeat?.messageId === slot.id) {
      playMessage(myCallsign, slot.id, placeholderValues, { repeat: false });
    }
  }, [myCallsign, placeholderValues, playMessage, repeat, resolveForSend, updateSlot, updateSlotLocal]);

  const getSlotDurationMs = useCallback(
    (text: string) => estimateRttyDurationMs(text.replace(/\{RX\}/gi, ''), config?.baud ?? 45.45, config?.stopBits ?? 1.5),
    [config?.baud, config?.stopBits],
  );

  useGlobalSlotHotkeys({
    enabled: isRttyMode && Boolean(myCallsign) && macro.panelMode === 'operate',
    slots: visibleSlots,
    shortcuts: shortcuts.shortcuts,
    // Escape also cancels a repeat that is waiting between transmissions.
    isActive: isActive || Boolean(repeat),
    onTrigger: handlePlay,
    onStop: stop,
    escapeEnabled: isRttyMode,
    allowTriggerWhileActive: true,
    ignoreInDialogs: true,
    ignoreAutoRepeat: true,
  });

  if (!isRttyMode) return null;

  const repeatLabel = repeat ? (visibleSlots.find((slot) => slot.id === repeat.messageId)?.label || null) : null;
  const waitingRepeat = Boolean(repeat) && !isActive;

  return (
    <>
      <RttyKeyboardFlow
        enabled={isRttyMode && Boolean(myCallsign)}
        myCallsign={myCallsign}
        slots={visibleSlots}
        play={sendSlot}
      />
      <KeyboardMacroPanel
        embedded={embedded}
        layout="grid"
        i18n={RTTY_MACRO_I18N}
        icon={faKeyboard}
        statusChip={(isActive || waitingRepeat) && (
          <Chip size="sm" variant="flat" color={onAir ? 'danger' : 'warning'} className="h-5 text-[10px]">
            {onAir
              ? 'TX'
              : waitingRepeat
                ? t('rtty.macro.repeatChip', 'Repeat')
                : t(`rtty.tx.phase.${txStatus?.phase ?? 'idle'}`, txStatus?.phase ?? '')}
          </Chip>
        )}
        inputArea={(
          <RttyTxBuffer
            placeholderValues={placeholderValues}
            repeatLabel={repeatLabel}
            onStop={stop}
            stopped={stoppedAt !== null}
          />
        )}
        macro={macro}
        shortcuts={shortcuts}
        placeholders={placeholders}
        isBusy={false}
        activeSlotId={activeSlotId}
        activeSlotPhase={activeSlotPhase}
        onPlaySlot={handlePressSlot}
        repeat={{
          onToggle: (slot) => void handleRepeatToggle(slot),
          onIntervalChange: macro.setRepeatIntervalSec,
          nextRunAt: repeat?.nextRunAt ?? null,
        }}
        getSlotDurationMs={getSlotDurationMs}
      />
    </>
  );
}
