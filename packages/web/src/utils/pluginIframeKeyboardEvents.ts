export const PLUGIN_IFRAME_KEYBOARD_EVENT = 'tx5dr:plugin-iframe-keyboard';

export type PluginIframeKeyboardEventType = 'keydown' | 'keyup';

export interface PluginIframeKeyboardEventDetail {
  type: PluginIframeKeyboardEventType;
  code: string;
  key: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export type PluginIframeKeyboardEvent = CustomEvent<PluginIframeKeyboardEventDetail>;

export type PluginIframeKeyboardSourceEvent = Pick<
  KeyboardEvent,
  | 'type'
  | 'code'
  | 'key'
  | 'repeat'
  | 'altKey'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'preventDefault'
  | 'stopPropagation'
> & {
  stopImmediatePropagation?: () => void;
};

export function createPluginIframeKeyboardEvent(
  detail: PluginIframeKeyboardEventDetail,
): PluginIframeKeyboardEvent {
  return new CustomEvent<PluginIframeKeyboardEventDetail>(
    PLUGIN_IFRAME_KEYBOARD_EVENT,
    {
      detail,
      cancelable: true,
    },
  );
}

export function forwardPluginIframeKeyboardEvent(
  sourceEvent: PluginIframeKeyboardSourceEvent,
  target: EventTarget = window,
): boolean {
  const forwardedEvent = createPluginIframeKeyboardEvent({
    type: sourceEvent.type === 'keyup' ? 'keyup' : 'keydown',
    code: sourceEvent.code,
    key: sourceEvent.key,
    repeat: sourceEvent.repeat,
    altKey: sourceEvent.altKey,
    ctrlKey: sourceEvent.ctrlKey,
    metaKey: sourceEvent.metaKey,
    shiftKey: sourceEvent.shiftKey,
  });
  const consumed = !target.dispatchEvent(forwardedEvent);

  if (consumed) {
    sourceEvent.preventDefault();
    sourceEvent.stopPropagation();
    sourceEvent.stopImmediatePropagation?.();
  }

  return consumed;
}
