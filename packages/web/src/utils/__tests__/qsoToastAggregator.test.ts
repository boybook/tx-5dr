import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerMessageKey } from '@tx5dr/contracts';
import i18n from '../../i18n/index';
import {
  QSO_TOAST_DRAIN_WINDOW_MS,
  QSO_TOAST_SUMMARY_TIMEOUT_MS,
  handleQsoToastAggregation,
  resetQsoToastAggregatorForTests,
  type ServerTextToastMessage,
} from '../qsoToastAggregator';

type Listener = () => void;

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installVisibilityHarness(initial: { visible: boolean; focused: boolean }) {
  let visible = initial.visible;
  let focused = initial.focused;
  const documentListeners = new Map<string, Set<Listener>>();
  const windowListeners = new Map<string, Set<Listener>>();

  const addListener = (map: Map<string, Set<Listener>>, event: string, listener: Listener) => {
    const listeners = map.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    map.set(event, listeners);
  };

  const removeListener = (map: Map<string, Set<Listener>>, event: string, listener: Listener) => {
    map.get(event)?.delete(listener);
  };

  const fakeDocument = {
    get visibilityState() {
      return visible ? 'visible' : 'hidden';
    },
    hasFocus: () => focused,
    addEventListener: (event: string, listener: Listener) => addListener(documentListeners, event, listener),
    removeEventListener: (event: string, listener: Listener) => removeListener(documentListeners, event, listener),
  };

  const fakeWindow = {
    setTimeout,
    clearTimeout,
    addEventListener: (event: string, listener: Listener) => addListener(windowListeners, event, listener),
    removeEventListener: (event: string, listener: Listener) => removeListener(windowListeners, event, listener),
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });

  return {
    setVisibility(next: { visible: boolean; focused: boolean }) {
      visible = next.visible;
      focused = next.focused;
    },
    emitDocument(event: string) {
      documentListeners.get(event)?.forEach(listener => listener());
    },
    emitWindow(event: string) {
      windowListeners.get(event)?.forEach(listener => listener());
    },
  };
}

function restoreGlobal(name: 'document' | 'window', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }

  delete (globalThis as Record<string, unknown>)[name];
}

function qsoToast(overrides: Partial<ServerTextToastMessage> = {}): ServerTextToastMessage {
  return {
    title: 'QSO Logged',
    description: 'BG5DRB - PM00 - 14.074 MHz - FT8',
    color: 'success',
    timeout: 3500,
    key: ServerMessageKey.QSO_LOGGED,
    params: { summary: 'BG5DRB - PM00 - 14.074 MHz - FT8' },
    createdAtMs: Date.now(),
    ...overrides,
  };
}

describe('qsoToastAggregator', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T00:00:00.000Z'));
    resetQsoToastAggregatorForTests();
    await i18n.changeLanguage('en');
  });

  afterEach(() => {
    resetQsoToastAggregatorForTests();
    vi.useRealTimers();
    restoreGlobal('document', originalDocument);
    restoreGlobal('window', originalWindow);
  });

  it('lets fresh visible QSO toasts display normally', () => {
    installVisibilityHarness({ visible: true, focused: true });
    const showToast = vi.fn();

    expect(handleQsoToastAggregation(qsoToast(), showToast)).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('aggregates multiple logged QSO toasts received in the background', () => {
    const visibility = installVisibilityHarness({ visible: false, focused: false });
    const showToast = vi.fn();

    expect(handleQsoToastAggregation(qsoToast({ params: { summary: 'A1AAA - FT8' } }), showToast)).toBe(true);
    expect(handleQsoToastAggregation(qsoToast({ params: { summary: 'B2BBB - FT8' } }), showToast)).toBe(true);
    expect(showToast).not.toHaveBeenCalled();

    visibility.setVisibility({ visible: true, focused: true });
    visibility.emitDocument('visibilitychange');

    vi.advanceTimersByTime(QSO_TOAST_DRAIN_WINDOW_MS - 1);
    expect(showToast).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      color: 'success',
      timeout: QSO_TOAST_SUMMARY_TIMEOUT_MS,
      description: expect.stringContaining('2 QSO'),
    }));
    expect(showToast.mock.calls[0]?.[0].description).toContain('B2BBB');
  });

  it('aggregates logged and updated QSO toasts into one summary', () => {
    const visibility = installVisibilityHarness({ visible: false, focused: false });
    const showToast = vi.fn();

    handleQsoToastAggregation(qsoToast({ params: { summary: 'A1AAA - FT8' } }), showToast);
    handleQsoToastAggregation(qsoToast({
      title: 'QSO Updated',
      key: ServerMessageKey.QSO_UPDATED,
      params: { summary: 'B2BBB - FT8' },
    }), showToast);

    visibility.setVisibility({ visible: true, focused: true });
    visibility.emitWindow('focus');
    vi.advanceTimersByTime(QSO_TOAST_DRAIN_WINDOW_MS);

    expect(showToast).toHaveBeenCalledTimes(1);
    const description = showToast.mock.calls[0]?.[0].description ?? '';
    expect(description).toContain('1 QSO');
    expect(description).toContain('updated');
    expect(description).toContain('B2BBB');
  });

  it('aggregates delayed packets created before the current foreground session', () => {
    const visibility = installVisibilityHarness({ visible: false, focused: false });
    const showToast = vi.fn();

    handleQsoToastAggregation(qsoToast({ createdAtMs: Date.now() }), showToast);
    visibility.setVisibility({ visible: true, focused: true });
    visibility.emitDocument('visibilitychange');
    vi.advanceTimersByTime(QSO_TOAST_DRAIN_WINDOW_MS);
    showToast.mockClear();

    const beforeForegroundMs = Date.now() - QSO_TOAST_DRAIN_WINDOW_MS - 1;
    expect(handleQsoToastAggregation(qsoToast({
      createdAtMs: beforeForegroundMs,
      params: { summary: 'LATE1 - FT8' },
    }), showToast)).toBe(true);

    vi.advanceTimersByTime(QSO_TOAST_DRAIN_WINDOW_MS);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast.mock.calls[0]?.[0].description).toContain('LATE1');
  });

  it('does not handle non-QSO text toasts', () => {
    installVisibilityHarness({ visible: false, focused: false });
    const showToast = vi.fn();

    expect(handleQsoToastAggregation({
      title: 'Timing Alert',
      description: 'Operator auto-decision may be late',
      color: 'warning',
      timeout: 3000,
      key: ServerMessageKey.TIMING_ALERT,
    }, showToast)).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });
});
