import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getPluginBridgeSdkScript } from '../bridge-sdk.js';

interface BridgeHarness {
  window: any;
  dispatch(data: Record<string, unknown>): void;
  styleValues: Record<string, string>;
}

function createBridgeHarness(search: string): BridgeHarness {
  const listeners: Array<(event: { data: unknown }) => void> = [];
  const styleValues: Record<string, string> = {};
  const window: any = {
    location: { search },
    parent: { postMessage: vi.fn() },
    __TX5DR_PAGE_SESSION_ID__: 'session-url',
    addEventListener(type: string, cb: (event: { data: unknown }) => void) {
      if (type === 'message') listeners.push(cb);
    },
  };

  const context = vm.createContext({
    window,
    document: {
      documentElement: {
        style: {
          setProperty(name: string, value: string) {
            styleValues[name] = value;
          },
        },
      },
    },
    URLSearchParams,
    Promise,
    Error,
    Object,
    Array,
    Uint8Array,
    Blob,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout,
  });

  vm.runInContext(getPluginBridgeSdkScript(), context);

  return {
    window,
    styleValues,
    dispatch(data: Record<string, unknown>) {
      for (const listener of listeners) {
        listener({ data });
      }
    },
  };
}

describe('plugin bridge SDK state', () => {
  it('bootstraps locale, theme and public params from the iframe URL', () => {
    const harness = createBridgeHarness('?_locale=zh-CN&_theme=light&callsign=BA1ABC&auth_token=secret');

    expect(harness.window.tx5dr.locale).toBe('zh-CN');
    expect(harness.window.tx5dr.theme).toBe('light');
    expect(harness.window.tx5dr.params).toEqual({ callsign: 'BA1ABC' });
    expect(harness.window.tx5dr.getState()).toEqual({
      params: { callsign: 'BA1ABC' },
      theme: 'light',
      locale: 'zh-CN',
      pageSessionId: 'session-url',
    });
    expect(harness.styleValues['--tx5dr-bg']).toBe('#ffffff');
  });

  it('updates state from init, notifies changed fields, and resolves ready', async () => {
    const harness = createBridgeHarness('?_locale=en&_theme=dark&callsign=OLD');
    const stateListener = vi.fn();
    const localeListener = vi.fn();
    const themeListener = vi.fn();

    harness.window.tx5dr.onStateChange(stateListener);
    harness.window.tx5dr.onLocaleChange(localeListener);
    harness.window.tx5dr.onThemeChange(themeListener);

    harness.dispatch({
      type: 'tx5dr:init',
      params: { callsign: 'BA1ABC' },
      theme: 'light',
      locale: 'zh-CN',
    });

    await expect(harness.window.tx5dr.ready).resolves.toEqual({
      params: { callsign: 'BA1ABC' },
      theme: 'light',
      locale: 'zh-CN',
      pageSessionId: 'session-url',
    });
    expect(harness.window.tx5dr.getState().params).toEqual({ callsign: 'BA1ABC' });
    expect(localeListener).toHaveBeenCalledTimes(1);
    expect(localeListener).toHaveBeenCalledWith('zh-CN');
    expect(themeListener).toHaveBeenCalledTimes(1);
    expect(themeListener).toHaveBeenCalledWith('light');
    expect(stateListener).toHaveBeenCalledTimes(1);
    expect(stateListener.mock.calls[0][0].previous.locale).toBe('en');
    expect(stateListener.mock.calls[0][0].current.locale).toBe('zh-CN');
  });

  it('does not emit duplicate changes for identical init payloads', () => {
    const harness = createBridgeHarness('?_locale=zh-CN&_theme=light&callsign=BA1ABC');
    const stateListener = vi.fn();
    const localeListener = vi.fn();
    const themeListener = vi.fn();

    harness.window.tx5dr.onStateChange(stateListener);
    harness.window.tx5dr.onLocaleChange(localeListener);
    harness.window.tx5dr.onThemeChange(themeListener);

    harness.dispatch({
      type: 'tx5dr:init',
      params: { callsign: 'BA1ABC' },
      theme: 'light',
      locale: 'zh-CN',
    });

    expect(stateListener).not.toHaveBeenCalled();
    expect(localeListener).not.toHaveBeenCalled();
    expect(themeListener).not.toHaveBeenCalled();
  });

  it('keeps old synchronous APIs compatible and supports unsubscribing theme listeners', () => {
    const harness = createBridgeHarness('?_locale=en&_theme=dark');
    const themeListener = vi.fn();
    const unsubscribe = harness.window.tx5dr.onThemeChange(themeListener);

    expect(harness.window.tx5dr.locale).toBe('en');
    expect(harness.window.tx5dr.theme).toBe('dark');
    expect(typeof unsubscribe).toBe('function');

    unsubscribe();
    harness.dispatch({ type: 'tx5dr:theme-changed', theme: 'light' });

    expect(harness.window.tx5dr.theme).toBe('light');
    expect(themeListener).not.toHaveBeenCalled();
  });
});
