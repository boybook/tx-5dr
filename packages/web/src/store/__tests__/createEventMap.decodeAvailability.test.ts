import { afterEach, expect, it, vi } from 'vitest';
import { createRadioEventMap } from '../radio/createEventMap';
import { showErrorToast } from '../../utils/errorToast';
import i18n from '../../i18n/index';

vi.mock('../../utils/errorToast', () => ({
  showErrorToast: vi.fn(), createRetryAction: vi.fn(), createRefreshStatusAction: vi.fn(), isRetryableError: () => false,
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('localizes queue-stalled warnings and limits repeated warnings to once per minute', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  vi.spyOn(i18n, 'exists').mockReturnValue(true);
  vi.spyOn(i18n, 't').mockReturnValue('Decode queue is stalled');
  const dispatch = vi.fn();
  // Only error-event dependencies are used in this isolated handler test.
  const events = createRadioEventMap({
    radioDispatch: dispatch, radioServiceRef: { current: null },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Parameters<typeof createRadioEventMap>[0]);
  const error = { code: 'DECODE_WORKER_UNAVAILABLE', severity: 'warning',
    message: 'Decode queue stopped making progress',
    userMessageKey: 'errors:code.DECODE_WORKER_UNAVAILABLE.userMessage',
    context: { unavailableReason: 'queue-stalled', pendingJobs: 2, readyWorkers: 2 },
  };
  events.error(error); events.error(error);
  expect(showErrorToast).toHaveBeenCalledTimes(1);
  expect(showErrorToast).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'Decode queue is stalled', severity: 'warning' }));
  vi.advanceTimersByTime(59_999); events.error(error);
  expect(showErrorToast).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1); events.error(error);
  expect(showErrorToast).toHaveBeenCalledTimes(2);
});
