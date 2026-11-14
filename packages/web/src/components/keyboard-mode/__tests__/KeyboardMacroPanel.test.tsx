// @vitest-environment jsdom
/**
 * Shared keyboard-mode macro panel driven by a fake adapter, the way a mode
 * (CW, RTTY) wires it: useMacroPanel + useSlotShortcuts + useMessagePlaceholders
 * + useGlobalSlotHotkeys around KeyboardMacroPanel.
 */
import React, { useCallback } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { faKeyboard } from '@fortawesome/free-solid-svg-icons';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyboardMessagePanel, KeyboardMessageSlot } from '@tx5dr/contracts';
import { createStorageStub } from '../../cw/__tests__/cwTestStorage';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@heroui/toast', () => ({ addToast: mocks.toast }));
vi.mock('../../../store/radioStore', () => ({
  useOperators: () => ({ operators: [{ id: 'op1', context: { myCall: 'K1ABC' } }] }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1', setCurrentOperatorId: vi.fn() }),
}));

import { KeyboardMacroPanel } from '../KeyboardMacroPanel';
import { useMessagePlaceholders } from '../useMessagePlaceholders';
import type { KeyboardModeI18n } from '../modeText';
import { useMacroPanel, type MacroPanelAdapter } from '../../../hooks/useMacroPanel';
import { useSlotShortcuts } from '../../../hooks/useSlotShortcuts';
import { useGlobalSlotHotkeys } from '../../../hooks/useGlobalSlotHotkeys';
import { createKeyerShortcutPreferences } from '../../../utils/keyerShortcutPreferences';

const STORAGE_KEY = 'tx5dr_test_keyer_shortcut_presets';
const preferences = createKeyerShortcutPreferences({ storageKey: STORAGE_KEY, eventName: 'testKeyerShortcutChanged' });
const I18N: KeyboardModeI18n = { prefix: 'radio:test' };
const CONTROL_TOKENS = ['RX'] as const;
const VALUES = { myCall: 'K1ABC', hisCall: 'JA1XYZ' };

function makePanel(): KeyboardMessagePanel {
  return {
    callsign: 'K1ABC',
    slotCount: 3,
    maxSlotCount: 12,
    slots: [
      { id: 'a', index: 1, label: 'CQ', text: 'CQ DE {MYCALL} {RX}', repeatEnabled: false, repeatIntervalSec: 5 },
      { id: 'b', index: 2, label: 'EXCH', text: '{HISCALL} UR {TRST}', repeatEnabled: false, repeatIntervalSec: 5 },
      { id: 'c', index: 3, label: 'TU', text: 'TU 73', repeatEnabled: false, repeatIntervalSec: 5 },
      { id: 'd', index: 4, label: 'Hidden', text: 'HIDDEN', repeatEnabled: false, repeatIntervalSec: 5 },
    ],
  };
}

const adapter = {
  getPanel: vi.fn<MacroPanelAdapter['getPanel']>(),
  updatePanel: vi.fn<MacroPanelAdapter['updatePanel']>(),
  updateSlot: vi.fn<MacroPanelAdapter['updateSlot']>(),
  deleteSlot: vi.fn<MacroPanelAdapter['deleteSlot']>(),
  swapSlots: vi.fn<MacroPanelAdapter['swapSlots']>(),
} satisfies MacroPanelAdapter;

function Harness({ onPlay, isActive = false, onStop = () => {}, layout, embedded, onToggleRepeat }: {
  onPlay: (slot: KeyboardMessageSlot) => void;
  isActive?: boolean;
  onStop?: () => void;
  layout?: 'list' | 'grid';
  embedded?: boolean;
  onToggleRepeat?: (slot: KeyboardMessageSlot) => void;
}) {
  const macro = useMacroPanel(adapter, 'K1ABC', { enabled: true });
  const shortcuts = useSlotShortcuts(preferences, 'K1ABC', macro.panel?.slots);
  const placeholders = useMessagePlaceholders({ values: VALUES, i18n: I18N, controlTokens: CONTROL_TOKENS });
  const { resolveForSend } = placeholders;
  const trigger = useCallback((slot: KeyboardMessageSlot) => {
    if (resolveForSend(slot.text)) onPlay(slot);
  }, [onPlay, resolveForSend]);
  useGlobalSlotHotkeys({
    enabled: macro.panelMode === 'operate',
    slots: macro.visibleSlots,
    shortcuts: shortcuts.shortcuts,
    isActive,
    onTrigger: trigger,
    onStop,
  });
  return (
    <KeyboardMacroPanel
      i18n={I18N}
      icon={faKeyboard}
      inputArea={<div data-testid="input-area" />}
      macro={macro}
      shortcuts={shortcuts}
      placeholders={placeholders}
      isBusy={isActive}
      activeSlotId={null}
      activeSlotPhase={null}
      onPlaySlot={trigger}
      layout={layout}
      embedded={embedded}
      repeat={onToggleRepeat ? { onToggle: onToggleRepeat, onIntervalChange: macro.setRepeatIntervalSec } : undefined}
    />
  );
}

const mount = (props: React.ComponentProps<typeof Harness>) => render(
  <HeroUIProvider disableAnimation><Harness {...props} /></HeroUIProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('localStorage', createStorageStub());
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  adapter.getPanel.mockImplementation(async () => makePanel());
  adapter.swapSlots.mockImplementation(async () => makePanel());
  adapter.updatePanel.mockImplementation(async (_callsign, { slotCount }) => ({ ...makePanel(), slotCount }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('KeyboardMacroPanel', () => {
  it('renders the visible slots with F-key badges, resolved placeholders and the input area', async () => {
    mount({ onPlay: vi.fn() });
    expect(await screen.findByRole('button', { name: /F1.*CQ DE K1ABC \{RX\}/ })).toBeTruthy();
    expect(adapter.getPanel).toHaveBeenCalledWith('K1ABC');
    expect(screen.getByRole('button', { name: /F3.*TU 73/ })).toBeTruthy();
    expect(screen.queryByText('HIDDEN')).toBeNull();
    expect(screen.getByTestId('input-area')).toBeTruthy();
    // No repeat options were given.
    expect(screen.queryByRole('button', { name: 'radio:test.repeatToggle' })).toBeNull();
  });

  it('F-keys trigger the matching slot, unresolved placeholders block it, and they are ignored while active', async () => {
    const onPlay = vi.fn();
    const view = mount({ onPlay });
    await screen.findByText('CQ', { selector: 'span' });
    await act(async () => {});

    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));

    // {TRST} has no value: warn instead of playing.
    fireEvent.keyDown(window, { key: 'F2', code: 'F2' });
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ color: 'warning', title: 'radio:test.placeholderMissingTitle' }));

    const onStop = vi.fn();
    view.rerender(<HeroUIProvider disableAnimation><Harness onPlay={onPlay} isActive onStop={onStop} /></HeroUIProvider>);
    fireEvent.keyDown(window, { key: 'F3', code: 'F3' });
    expect(onPlay).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('clicking a slot plays it', async () => {
    const onPlay = vi.fn();
    mount({ onPlay });
    fireEvent.click(await screen.findByRole('button', { name: /TU 73/ }));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });

  it('the edit tab disables F-keys, changes the slot count and swaps dragged slots with their shortcuts', async () => {
    const onPlay = vi.fn();
    const { container } = mount({ onPlay });
    await screen.findByText('CQ', { selector: 'span' });
    fireEvent.click(screen.getByRole('tab', { name: 'radio:test.editMode' }));
    await screen.findAllByLabelText('radio:test.messageText');

    fireEvent.keyDown(window, { key: 'F1', code: 'F1' });
    expect(onPlay).not.toHaveBeenCalled();

    // The {RX} control token is listed in the placeholder hint.
    expect(screen.getByText('{RX}')).toBeTruthy();

    const rows = screen.getAllByLabelText('radio:test.messageText').map(input => input.closest('[draggable]') as HTMLElement);
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(rows[0], { dataTransfer });
    fireEvent.dragOver(rows[2], { dataTransfer });
    fireEvent.drop(rows[2], { dataTransfer });
    await waitFor(() => expect(adapter.swapSlots).toHaveBeenCalledWith('K1ABC', 'a', 'c'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toEqual({ K1ABC: { a: 'F3', c: 'F1' } });

    const plus = container.querySelector('svg[data-icon="plus"]')?.closest('button') as HTMLButtonElement;
    fireEvent.click(plus);
    await waitFor(() => expect(adapter.updatePanel).toHaveBeenCalledWith('K1ABC', { slotCount: 4 }));
    await waitFor(() => expect(screen.getAllByLabelText('radio:test.messageText')).toHaveLength(4));
  });

  it('grid layout: one compact button per slot with label, preview and missing-placeholder flag', async () => {
    const onPlay = vi.fn();
    const onToggleRepeat = vi.fn();
    mount({ onPlay, layout: 'grid', embedded: true, onToggleRepeat });
    const grid = await screen.findByTestId('macro-grid');
    expect(grid.querySelectorAll('[data-missing]').length).toBe(1);
    const exch = screen.getByRole('button', { name: /F2.*EXCH.*JA1XYZ UR \{TRST\}/ });
    expect(exch.getAttribute('data-missing')).toBe('true');
    // No "Presets" heading in the operate grid; the list view keeps it.
    expect(screen.queryByText('radio:test.presetMessages')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /F3.*TU/ }));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'radio:test.repeatToggle' })[0]!);
    expect(onToggleRepeat).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('list layout stays the default (one row per slot under the Presets heading)', async () => {
    mount({ onPlay: vi.fn() });
    await screen.findByRole('button', { name: /F1.*CQ DE K1ABC/ });
    expect(screen.queryByTestId('macro-grid')).toBeNull();
    expect(screen.getByText('radio:test.presetMessages')).toBeTruthy();
  });
});
