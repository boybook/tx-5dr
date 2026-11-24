// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveTargetCard, { AUTO_CALL_WINDOW_MS, type LiveTargeting } from './LiveTargetCard';
import { HighlightType } from '../../utils/displayNotificationSettings';
import type { LiveStation } from '../../utils/liveDecodes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}${options?.callsign ? `:${options.callsign}` : ''}` }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const station: LiveStation = {
  callsign: 'JA1ABC',
  decode: { callsign: 'JA1ABC', message: 'CQ JA1ABC PM95', messageType: 'cq', snr: -8, dt: 0.1, freq: 1200, location: { lat: 35.7, lng: 139.7, precision: 'grid' }, analysis: { grid: 'PM95' } },
  slotStartMs: 1_700_000_010_000, ageSlots: 0, isCq: true, highlight: HighlightType.NEW_PREFIX, color: '#22d3ee', tier: 1, lat: 35.7, lng: 139.7, approximate: false,
};

function targeting(overrides: Partial<LiveTargeting> = {}): LiveTargeting {
  return {
    supported: true,
    operators: [{ id: 'op-1', label: 'BG5DRB' }],
    defaultOperatorId: 'op-1',
    select: vi.fn(async () => ({ requestId: 'r', operatorId: 'op-1', callsign: 'JA1ABC', status: 'called' as const })),
    ...overrides,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof LiveTargetCard>> = {}) {
  return render(
    <LiveTargetCard station={station} home={null} anchor={{ x: 100, y: 100 }} bounds={{ width: 800, height: 500 }}
      targeting={targeting()} autoCall={false} onClose={() => {}} {...props} />,
  );
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('LiveTargetCard', () => {
  it('calls the station with the chosen operator and confirms, then closes', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const target = targeting();
    const view = renderCard({ targeting: target, onClose });
    await act(async () => { fireEvent.click(view.getByText('globe.callAction:JA1ABC')); });
    expect(target.select).toHaveBeenCalledWith('op-1', station);
    expect(view.getByRole('status').textContent).toBe('globe.callSent:JA1ABC');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the server's reason when the call is refused", async () => {
    const target = targeting({
      select: vi.fn(async () => ({ requestId: 'r', operatorId: 'op-1', callsign: 'JA1ABC', status: 'rejected' as const, reason: 'saving', userMessageKey: 'radio:operator.callRejection.saving' })),
    });
    const view = renderCard({ targeting: target });
    await act(async () => { fireEvent.click(view.getByText('globe.callAction:JA1ABC')); });
    expect(view.getByRole('status').textContent).toBe('radio:operator.callRejection.saving');
  });

  it('asks which operator when several share the logbook, and stays disabled on old servers', async () => {
    const target = targeting({ operators: [{ id: 'op-1', label: 'BG5DRB' }, { id: 'op-2', label: 'BG5CCB' }], defaultOperatorId: undefined });
    const view = renderCard({ targeting: target });
    expect(view.getByRole('status').textContent).toBe('globe.callPickOperator');
    await act(async () => { fireEvent.click(view.getByText('BG5CCB')); });
    await act(async () => { fireEvent.click(view.getByText('globe.callAction:JA1ABC')); });
    expect(target.select).toHaveBeenCalledWith('op-2', station);
    cleanup();

    const old = renderCard({ targeting: targeting({ supported: false }) });
    expect(old.getByRole('status').textContent).toBe('globe.callUnsupported');
    expect(old.getByText('globe.callAction:JA1ABC').closest('button')?.disabled).toBe(true);
  });

  it('calls once at open after a double click', async () => {
    const target = targeting();
    const view = renderCard({ targeting: target, autoCall: true });
    await act(async () => {});
    expect(target.select).toHaveBeenCalledTimes(1);
    view.rerender(<LiveTargetCard station={station} home={null} anchor={{ x: 100, y: 100 }} bounds={{ width: 800, height: 500 }} targeting={target} autoCall onClose={() => {}} />);
    await act(async () => {});
    expect(target.select).toHaveBeenCalledTimes(1);
  });

  // Regression: a double click on a page that could not call yet (operators
  // still loading) called whenever it later could, keying the transmitter
  // at a moment the user did not choose.
  it('does not call later when a double click could not call at once', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const waiting = targeting({ defaultOperatorId: undefined, operators: [] });
    const view = renderCard({ targeting: waiting, autoCall: true });
    await act(async () => {});
    expect(waiting.select).not.toHaveBeenCalled();

    now.mockReturnValue(1000 + AUTO_CALL_WINDOW_MS + 1);
    const ready = targeting();
    view.rerender(<LiveTargetCard station={station} home={null} anchor={{ x: 100, y: 100 }} bounds={{ width: 800, height: 500 }} targeting={ready} autoCall onClose={() => {}} />);
    await act(async () => {});
    expect(ready.select).not.toHaveBeenCalled();
    expect(view.getByText('globe.callAction:JA1ABC').closest('button')?.disabled).toBe(false);
    now.mockRestore();
  });
});
