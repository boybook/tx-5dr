import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OperatorQueueTable } from './OperatorQueueTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => ({
      'operator.queue.title': 'QSO queue',
      'operator.queue.callsign': 'Callsign',
      'operator.queue.status': 'Status',
      'operator.queue.remove': 'Remove',
      'operator.queue.interruptAndRemove': 'Interrupt and remove',
      'operator.queue.retry': 'Retry call',
      'operator.queue.clear': 'Clear queue',
      'operator.queueStatus.no-response': 'Inactive',
      'operator.queueStatus.noResponseCycles': 'Inactive · no reply for 5 cycles',
      'operator.queuePauseReason.stale': 'Not heard',
      'operator.queueMeta.cyclesAgo': '2 cycles ago',
      'operator.queue.emptyHint': 'Double-click a callsign on the left to add it',
    }[key] ?? key),
  }),
}));

vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({
    state: {
      radioService: null,
    },
  }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'operator-1' }),
  useOperators: () => ({
    operators: [{ id: 'operator-1', context: { myGrid: 'OL32' } }],
  }),
  useStationInfo: () => null,
}));

vi.mock('framer-motion', () => ({
  Reorder: {
    Group: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  },
}));

describe('OperatorQueueTable', () => {
  it('renders a compact empty-state hint inside the fixed queue body', () => {
    const html = renderToStaticMarkup(
      <OperatorQueueTable
        operatorId="operator-1"
        queue={{ version: 1, rows: [] }}
      />,
    );

    expect(html).toContain('aria-label="QSO queue"');
    expect(html).toContain('height:84px');
    expect(html).not.toContain('>Callsign<');
    expect(html).not.toContain('>Status<');
    expect(html).toContain('Double-click a callsign on the left to add it');
    expect(html).toContain('aria-label="Clear queue"');
    expect(html).toContain('disabled=""');
  });

  it('renders queue rows as a compact list with the status at the trailing edge', () => {
    const html = renderToStaticMarkup(
      <OperatorQueueTable
        operatorId="operator-1"
        queue={{
          version: 1,
          rows: [{
            entryId: 'entry-1',
            callsign: 'JA1AAA',
            order: 0,
            draggable: true,
            displayState: 'TX1',
            tone: 'neutral',
            icon: 'circle',
            targetGrid: 'PM95',
            lastSnr: -12,
            lastHeardCyclesAgo: 2,
          }],
        }}
      />,
    );

    expect(html).toContain('role="list"');
    expect(html).toContain('role="listitem"');
    expect(html).toContain('JA1AAA');
    expect(html).toContain('TX1');
    expect(html).toContain('km');
    expect(html).toContain('-12 dB');
    expect(html).toContain('2 cycles ago');
    expect(html).toContain('ml-auto flex min-w-0');
    expect(html).toContain('aria-label="Remove"');
  });

  it('shows retry only for an unanswered active attempt, not passive inactivity', () => {
    const html = renderToStaticMarkup(
      <OperatorQueueTable
        operatorId="operator-1"
        queue={{
          version: 2,
          activeEntryId: 'entry-1',
          rows: [{
            entryId: 'entry-1',
            callsign: 'JA1AAA',
            order: 0,
            draggable: false,
            displayState: 'engaged',
            tone: 'success',
            icon: 'check-circle',
          }, {
            entryId: 'entry-2',
            callsign: 'JA2BBB',
            order: 1,
            draggable: true,
            displayState: 'no-response',
            tone: 'warning',
            icon: 'clock',
            noResponseCycles: 5,
          }, {
            entryId: 'entry-3',
            callsign: 'JA3CCC',
            order: 2,
            draggable: true,
            displayState: 'no-response',
            tone: 'warning',
            icon: 'clock',
          }],
        }}
      />,
    );

    expect(html).toContain('aria-label="Interrupt and remove"');
    expect(html.match(/aria-label="Remove"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Retry call"/g)).toHaveLength(1);
    expect(html.match(/data-icon="grip-vertical"/g)).toHaveLength(3);
    expect(html).toContain('cursor-not-allowed opacity-30');
    expect(html).toContain('Inactive · no reply for 5 cycles');
  });

  it('renders stale pause as a quiet note while the left metadata owns the cycle count', () => {
    const html = renderToStaticMarkup(
      <OperatorQueueTable
        operatorId="operator-1"
        queue={{
          version: 3,
          rows: [{
            entryId: 'entry-1',
            callsign: 'JA1AAA',
            order: 0,
            draggable: true,
            displayState: 'paused',
            tone: 'neutral',
            icon: 'pause',
            pauseReason: 'stale',
            lastHeardCyclesAgo: 2,
          }],
        }}
      />,
    );

    expect(html).toContain('Not heard');
    expect(html).toContain('2 cycles ago');
    expect(html).not.toContain('Not heard 2');
  });
});
