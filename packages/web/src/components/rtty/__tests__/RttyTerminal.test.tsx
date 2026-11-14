// @vitest-environment jsdom
/**
 * RTTY receive terminal: word grouping, clickable callsigns and reports, TX
 * echo styling and the clear action. The RTTY context is a controllable object.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HeroUIProvider } from '@heroui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RttyTranscript } from '../../../hooks/useRtty';
import { chars, rttyConfig } from './rttyTestFixtures';

const mocks = vi.hoisted(() => ({
  worked: {} as Record<string, 'new' | 'worked' | 'dupe' | undefined>,
  canControl: true,
  scan: null as unknown,
  rtty: {
    transcript: { sessionId: 's1', segments: [], lastSequence: -1 } as RttyTranscript,
    decoderStatus: null,
    config: null as unknown,
    txStatus: null as unknown,
    clearTranscript: vi.fn(),
    updateConfig: vi.fn(async () => {}),
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../store/authStore', () => ({ useCan: () => mocks.canControl }));
vi.mock('../../../hooks/useRtty', () => ({ useRtty: () => mocks.rtty, useRttyTranscript: () => mocks.rtty, useRttyScan: () => mocks.scan }));
vi.mock('../../../store/radioStore', () => ({
  useOperators: () => ({ operators: [{ id: 'op1', context: { myCall: 'BG5DRB' } }] }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1' }),
}));
vi.mock('../useWorkedCallsigns', () => ({
  useWorkedCallsignContext: () => {},
  useWorkedStatus: (callsign: string) => mocks.worked[callsign],
}));

import { RttyTerminal, groupReceivedWords } from '../RttyTerminal';

function setTranscript(segments: RttyTranscript['segments']) {
  mocks.rtty.transcript = { sessionId: 's1', segments, lastSequence: 0 };
}

const mount = (props: React.ComponentProps<typeof RttyTerminal> = {}) => render(
  <HeroUIProvider disableAnimation><RttyTerminal {...props} /></HeroUIProvider>,
);

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  mocks.canControl = true;
  mocks.rtty.config = rttyConfig();
  mocks.rtty.clearTranscript.mockResolvedValue(undefined);
  setTranscript([]);
});

afterEach(() => {
  cleanup();
});

describe('groupReceivedWords', () => {
  it('splits words, keeps whitespace runs and averages confidence per word', () => {
    const characters = [
      ...chars(' '),
      ...chars('CQ', 0.8),
      ...chars('  '),
      { ch: 'D', confidence: 1, at: 0 },
      { ch: 'E', confidence: 0.5, at: 0 },
      ...chars('\n'),
    ];
    const words = groupReceivedWords(characters);
    expect(words.map(({ text, whitespace }) => [text, whitespace])).toEqual([
      ['', ' '],
      ['CQ', '  '],
      ['DE', '\n'],
    ]);
    expect(words[1]!.confidence).toBeCloseTo(0.8);
    expect(words[2]!.confidence).toBeCloseTo(0.75);
    expect(groupReceivedWords([])).toEqual([]);
  });
});

describe('RttyTerminal', () => {
  it('makes confident callsigns and reports clickable', () => {
    const onCallsign = vi.fn();
    const onReport = vi.fn();
    setTranscript([{ kind: 'rx', id: 'r1', characters: [...chars('CQ DE JA1XYZ/P UR 599 '), ...chars('K1ABC', 0.3)] }]);
    mount({ onCallsign, onReport });

    fireEvent.click(screen.getByRole('button', { name: 'JA1XYZ/P' }));
    expect(onCallsign).toHaveBeenCalledWith('JA1XYZ/P');
    fireEvent.click(screen.getByRole('button', { name: '599' }));
    expect(onReport).toHaveBeenCalledWith('599');

    // Low confidence callsign and plain words stay text.
    expect(screen.queryByRole('button', { name: 'K1ABC' })).toBeNull();
    expect(screen.getByText('K1ABC')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'CQ' })).toBeNull();
  });

  it('renders words as plain text when no handlers are given', () => {
    setTranscript([{ kind: 'rx', id: 'r1', characters: chars('JA1XYZ 599') }]);
    mount();
    expect(screen.queryByRole('button', { name: 'JA1XYZ' })).toBeNull();
    expect(screen.queryByRole('button', { name: '599' })).toBeNull();
    expect(screen.getByRole('log').textContent).toBe('JA1XYZ 599');
  });

  it('shows TX echo segments separately between received text', () => {
    setTranscript([
      { kind: 'rx', id: 'r1', characters: chars('CQ ') },
      { kind: 'tx', id: 't1', sessionId: 'tx1', text: 'K1ABC DE JA1XYZ', startedAt: 1 },
      { kind: 'rx', id: 'r2', characters: chars('R R') },
    ]);
    const { container } = mount();
    const segments = Array.from(container.querySelectorAll('[data-rtty-segment]'))
      .map(element => [element.getAttribute('data-rtty-segment'), element.textContent]);
    expect(segments).toEqual([['rx', 'CQ '], ['tx', 'K1ABC DE JA1XYZ'], ['rx', 'R R']]);
  });

  it('clear is enabled only with text and clears this view for any viewer', () => {
    mocks.canControl = false;
    const view = mount();
    expect(screen.getByText('rtty.terminal.empty')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'rtty.terminal.clear' }) as HTMLButtonElement).disabled).toBe(true);

    setTranscript([{ kind: 'rx', id: 'r1', characters: chars('RYRY') }]);
    view.rerender(<HeroUIProvider disableAnimation><RttyTerminal /></HeroUIProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'rtty.terminal.clear' }));
    expect(mocks.rtty.clearTranscript).toHaveBeenCalledTimes(1);
    mocks.canControl = true;
  });

  it('opens settings from the modem parameters and from the labelled toolbar button', () => {
    const onOpenSettings = vi.fn();
    const view = mount({ onOpenSettings });
    const pill = screen.getByTestId('rtty-profile-settings') as HTMLButtonElement;
    expect(pill.textContent).toContain('45.45 Bd · 170 Hz · LSB');
    fireEvent.click(pill);
    const toolbar = screen.getByRole('button', { name: 'rtty.settings.title' });
    expect(toolbar.textContent).toContain('rtty.terminal.settings');
    fireEvent.click(toolbar);
    expect(onOpenSettings).toHaveBeenCalledTimes(2);

    // Without permission both stay visible but disabled; without a handler the parameters are plain text.
    mocks.canControl = false;
    view.rerender(<HeroUIProvider disableAnimation><RttyTerminal onOpenSettings={onOpenSettings} /></HeroUIProvider>);
    expect((screen.getByTestId('rtty-profile-settings') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'rtty.settings.title' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<HeroUIProvider disableAnimation><RttyTerminal /></HeroUIProvider>);
    expect(screen.queryByTestId('rtty-profile-settings')).toBeNull();
    expect(screen.getByText('45.45 Bd · 170 Hz · LSB')).toBeTruthy();
    mocks.canControl = true;
  });

  it('does not link my own callsign or a word still being received', () => {
    setTranscript([{ kind: 'rx', id: 'r1', characters: chars('BG5DRB DE JA1AAA K1AB', 0.9) }]);
    mount({ onCallsign: vi.fn() });
    expect(screen.queryByRole('button', { name: 'BG5DRB' })).toBeNull();
    expect(screen.getByRole('button', { name: 'JA1AAA' })).toBeTruthy();
    // "K1AB" has no trailing space yet: it may still grow.
    expect(screen.queryByRole('button', { name: 'K1AB' })).toBeNull();
  });

  it('shows REV and an AFC align button that re-centres on the signal', () => {
    mocks.rtty.decoderStatus = {
      state: 'listening', enabled: true, sessionId: 's1', error: null, updatedAt: 0,
      signal: { locked: false, snrDb: 10, markDb: 20, spaceDb: 18, frequencyOffsetHz: -30, reversed: true, afcLimited: false, quality: 0.8 },
    } as never;
    mount();
    expect(screen.getByTestId('rtty-rev').textContent).toBe('rtty.receive.reverseAutoLabel');
    fireEvent.click(screen.getByTestId('rtty-afc-align'));
    expect(mocks.rtty.updateConfig).toHaveBeenCalledWith({ centerHz: 2_180 });
    fireEvent.click(screen.getByTestId('rtty-rev'));
    expect(mocks.rtty.updateConfig).toHaveBeenCalledWith({ reverse: true });
    mocks.rtty.decoderStatus = null;
  });

  it('lists detected signals; a row tunes there and the callsign button also fills the draft', () => {
    mocks.scan = {
      enabled: true,
      updatedAt: 0,
      channels: [
        { id: 1, centerHz: 1_000, shiftHz: 170, score: 0.9, snrDb: 12, reversed: false, locked: true, preview: 'CQ CQ DE JA1AAA JA1AAA K', lastHeardAt: 0 },
        { id: 2, centerHz: 2_210, shiftHz: 170, score: 0.9, snrDb: 15, reversed: false, locked: true, preview: 'BG5DRB DE W1AW', lastHeardAt: 0 },
      ],
    };
    const onCallsign = vi.fn();
    mount({ onCallsign });
    const browser = screen.getByTestId('rtty-signal-browser');
    expect(browser.textContent).toContain('1000');
    fireEvent.click(screen.getByTitle('rtty.browser.tune'));
    expect(mocks.rtty.updateConfig).toHaveBeenCalledWith({ centerHz: 1_000 });
    fireEvent.click(screen.getAllByRole('button', { name: 'JA1AAA' }).at(-1)!);
    expect(onCallsign).toHaveBeenCalledWith('JA1AAA');
    mocks.scan = null;
  });

  it('marks callsigns already in the log', () => {
    mocks.worked = { JA1XYZ: 'dupe', K1ABC: 'worked', W1AW: 'new' };
    setTranscript([{ kind: 'rx', id: 'r1', characters: chars('JA1XYZ K1ABC W1AW ', 0.9) }]);
    mount({ onCallsign: vi.fn() });
    expect(screen.getByRole('button', { name: 'JA1XYZ' }).getAttribute('data-worked')).toBe('dupe');
    expect(screen.getByRole('button', { name: 'JA1XYZ' }).className).toContain('line-through');
    expect(screen.getByRole('button', { name: 'K1ABC' }).getAttribute('data-worked')).toBe('worked');
    expect(screen.getByRole('button', { name: 'W1AW' }).getAttribute('data-worked')).toBe('new');
    mocks.worked = {};
  });
});
