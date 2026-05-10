import { describe, expect, it, vi } from 'vitest';

import {
  forwardPluginIframeKeyboardEvent,
  PLUGIN_IFRAME_KEYBOARD_EVENT,
  type PluginIframeKeyboardEvent,
  type PluginIframeKeyboardSourceEvent,
} from '../pluginIframeKeyboardEvents';

function createSourceEvent(
  overrides: Partial<PluginIframeKeyboardSourceEvent> = {},
): PluginIframeKeyboardSourceEvent {
  return {
    type: 'keydown',
    code: 'Space',
    key: ' ',
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  };
}

describe('plugin iframe keyboard events', () => {
  it('forwards keyboard metadata as a cancelable host event', () => {
    const target = new EventTarget();
    const sourceEvent = createSourceEvent({
      code: 'Backquote',
      key: '`',
      altKey: true,
      repeat: true,
    });
    const listener = vi.fn((event: Event) => {
      const forwardedEvent = event as PluginIframeKeyboardEvent;
      expect(forwardedEvent.cancelable).toBe(true);
      expect(forwardedEvent.detail).toMatchObject({
        type: 'keydown',
        code: 'Backquote',
        key: '`',
        repeat: true,
        altKey: true,
      });
    });

    target.addEventListener(PLUGIN_IFRAME_KEYBOARD_EVENT, listener);

    expect(forwardPluginIframeKeyboardEvent(sourceEvent, target)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sourceEvent.preventDefault).not.toHaveBeenCalled();
    expect(sourceEvent.stopPropagation).not.toHaveBeenCalled();
  });

  it('suppresses the iframe event when the host consumes the shortcut', () => {
    const target = new EventTarget();
    const sourceEvent = createSourceEvent();

    target.addEventListener(PLUGIN_IFRAME_KEYBOARD_EVENT, (event) => {
      event.preventDefault();
    });

    expect(forwardPluginIframeKeyboardEvent(sourceEvent, target)).toBe(true);
    expect(sourceEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(sourceEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(sourceEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);
  });

  it('preserves keyup details so host listeners can release repeat guards only', () => {
    const target = new EventTarget();
    const sourceEvent = createSourceEvent({
      type: 'keyup',
      code: 'Home',
      key: 'Home',
      shiftKey: true,
    });
    let detail: PluginIframeKeyboardEvent['detail'] | null = null;

    target.addEventListener(PLUGIN_IFRAME_KEYBOARD_EVENT, (event) => {
      detail = (event as PluginIframeKeyboardEvent).detail;
    });

    expect(forwardPluginIframeKeyboardEvent(sourceEvent, target)).toBe(false);
    expect(detail).toEqual({
      type: 'keyup',
      code: 'Home',
      key: 'Home',
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
    });
  });
});
