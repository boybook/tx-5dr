// @vitest-environment jsdom
/**
 * Characterization tests for the CW recent-QSO list: initial query, live WS
 * updates (digital modes filtered out) and selection callbacks.
 */
import React from 'react';
import { EventEmitter } from 'node:events';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QSORecord } from '@tx5dr/contracts';

const mocks = vi.hoisted(() => ({
  bus: null as unknown as import('node:events').EventEmitter,
  service: null as unknown,
  operators: [{ id: 'op1', context: { myCall: 'BG5DRB' } }],
  getLogBookQSOs: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tx5dr/core', async original => ({ ...await original<object>(), api: { getLogBookQSOs: mocks.getLogBookQSOs } }));
vi.mock('../../../store/radioStore', () => ({
  useConnection: () => ({ state: { radioService: mocks.service } }),
  useOperators: () => ({ operators: mocks.operators }),
  useCurrentOperatorId: () => ({ currentOperatorId: 'op1' }),
}));

import { CWRecentQSOList } from '../CWRecentQSOList';

function qso(id: string, callsign: string, mode: string, overrides: Partial<QSORecord> = {}): QSORecord {
  return {
    id,
    callsign,
    mode,
    frequency: 14_025_000,
    startTime: Date.now(),
    reportSent: '599',
    reportReceived: '579',
    messages: [],
    ...overrides,
  } as unknown as QSORecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  const bus = new EventEmitter();
  mocks.bus = bus;
  mocks.service = { wsClientInstance: { onWSEvent: bus.on.bind(bus), offWSEvent: bus.off.bind(bus) } };
  mocks.getLogBookQSOs.mockResolvedValue({ success: true, data: [qso('q1', 'K1ABC', 'CW')] });
});

afterEach(cleanup);

describe('CWRecentQSOList', () => {
  it('loads the 50 most recent non-digital QSOs of the current operator logbook', async () => {
    render(<CWRecentQSOList />);
    await screen.findByText('K1ABC');
    expect(mocks.getLogBookQSOs).toHaveBeenCalledWith('BG5DRB', {
      excludeModes: 'FT8,FT4,JS8,WSPR,JT65,JT9,MSK144,FST4,FST4W',
      limit: 50,
      offset: 0,
    });
    expect(screen.getByText('14.025')).toBeTruthy();
    expect(screen.getByText('599/579')).toBeTruthy();
  });

  it('prepends live CW QSOs and ignores digital-mode QSOs', async () => {
    render(<CWRecentQSOList />);
    await screen.findByText('K1ABC');
    act(() => {
      mocks.bus.emit('qsoRecordAdded', { qsoRecord: qso('q2', 'JA1ABC', 'CW') });
      mocks.bus.emit('qsoRecordAdded', { qsoRecord: qso('q3', 'DL1XYZ', 'FT8') });
    });
    expect(screen.queryByText('DL1XYZ')).toBeNull();
    const callsigns = screen.getAllByText(/^(K1ABC|JA1ABC)$/).map(node => node.textContent);
    expect(callsigns).toEqual(['JA1ABC', 'K1ABC']);
  });

  it('reports selection and deselection of a row', async () => {
    const onSelectQSO = vi.fn();
    const onDeselectQSO = vi.fn();
    const view = render(<CWRecentQSOList onSelectQSO={onSelectQSO} onDeselectQSO={onDeselectQSO} />);
    fireEvent.click(await screen.findByText('K1ABC'));
    expect(onSelectQSO).toHaveBeenCalledWith(expect.objectContaining({ id: 'q1' }));
    view.rerender(<CWRecentQSOList selectedQSOId="q1" onSelectQSO={onSelectQSO} onDeselectQSO={onDeselectQSO} />);
    fireEvent.click(screen.getByText('K1ABC'));
    expect(onDeselectQSO).toHaveBeenCalledTimes(1);
  });

  it('applies edits and deletions pushed from the log card', async () => {
    const view = render(<CWRecentQSOList />);
    await screen.findByText('K1ABC');
    view.rerender(<CWRecentQSOList lastUpdatedQSO={qso('q1', 'K1XYZ', 'CW')} />);
    await waitFor(() => expect(screen.getByText('K1XYZ')).toBeTruthy());
    view.rerender(<CWRecentQSOList lastDeletedId="q1" />);
    await waitFor(() => expect(screen.queryByText('K1XYZ')).toBeNull());
    expect(screen.getByText('cw.recentQSO.empty')).toBeTruthy();
  });
});
