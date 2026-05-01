import { createLogger } from './logger';

const logger = createLogger('ShortcutPreferences');

const STORAGE_KEY = 'tx5dr_shortcut_config_v1';

export const SHORTCUT_CONFIG_CHANGED_EVENT = 'tx5drShortcutConfigChanged';

export const SHORTCUT_ACTION_IDS = [
  'toggle-current-operator-tx',
  'halt-current-operator-tx',
  'select-tx-1',
  'select-tx-2',
  'select-tx-3',
  'select-tx-4',
  'select-tx-5',
  'select-tx-6',
  'start-monitoring',
  'stop-monitoring',
  'cycle-operator-next',
  'cycle-operator-previous',
  'reset-current-operator-to-cq',
  'force-stop-all-transmission',
  'run-tuner-tune',
  'toggle-tuner-switch',
] as const;

export type ShortcutActionId = typeof SHORTCUT_ACTION_IDS[number];

export interface ShortcutBinding {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  enabled: boolean;
  label: string;
}

export type ShortcutConfig = Record<ShortcutActionId, ShortcutBinding>;

export interface ShortcutConflict {
  signature: string;
  actionIds: ShortcutActionId[];
}

const ACTION_ID_SET = new Set<string>(SHORTCUT_ACTION_IDS);


const MODIFIER_KEY_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight',
]);

export function isModifierOnlyShortcutEvent(event: KeyboardEvent): boolean {
  return MODIFIER_KEY_CODES.has(event.code) || event.key === 'Alt' || event.key === 'Control' || event.key === 'Meta' || event.key === 'Shift';
}


export const DEFAULT_SHORTCUT_CONFIG: ShortcutConfig = {
  'toggle-current-operator-tx': createShortcutBinding({ code: 'KeyN', key: 'N', altKey: true }),
  'halt-current-operator-tx': createShortcutBinding({ code: 'KeyH', key: 'H', altKey: true }),
  'select-tx-1': createShortcutBinding({ code: 'Digit1', key: '1', altKey: true }),
  'select-tx-2': createShortcutBinding({ code: 'Digit2', key: '2', altKey: true }),
  'select-tx-3': createShortcutBinding({ code: 'Digit3', key: '3', altKey: true }),
  'select-tx-4': createShortcutBinding({ code: 'Digit4', key: '4', altKey: true }),
  'select-tx-5': createShortcutBinding({ code: 'Digit5', key: '5', altKey: true }),
  'select-tx-6': createShortcutBinding({ code: 'Digit6', key: '6', altKey: true }),
  'start-monitoring': createShortcutBinding({ code: 'KeyM', key: 'M', altKey: true }),
  'stop-monitoring': createShortcutBinding({ code: 'KeyS', key: 'S', altKey: true }),
  'cycle-operator-next': createShortcutBinding({ code: 'KeyO', key: 'O', altKey: true }),
  'cycle-operator-previous': createDisabledShortcutBinding(),
  'reset-current-operator-to-cq': createDisabledShortcutBinding(),
  'force-stop-all-transmission': createDisabledShortcutBinding(),
  'run-tuner-tune': createDisabledShortcutBinding(),
  'toggle-tuner-switch': createDisabledShortcutBinding(),
};

function getStorage(): Storage | null {
  if (typeof globalThis === 'undefined' || !('localStorage' in globalThis)) {
    return null;
  }

  return globalThis.localStorage ?? null;
}

function cloneDefaultConfig(): ShortcutConfig {
  return normalizeShortcutConfig(DEFAULT_SHORTCUT_CONFIG);
}

function isShortcutActionId(value: unknown): value is ShortcutActionId {
  return typeof value === 'string' && ACTION_ID_SET.has(value);
}

function normalizeKey(value: unknown, code: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.length === 1 ? value.toUpperCase() : value;
  }

  return getKeyFromCode(code);
}

function getKeyFromCode(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === 'Space') return 'Space';
  if (code === 'Backquote') return '`';
  if (code === 'Minus') return '-';
  if (code === 'Equal') return '=';
  if (code === 'BracketLeft') return '[';
  if (code === 'BracketRight') return ']';
  if (code === 'Backslash') return '\\';
  if (code === 'Semicolon') return ';';
  if (code === 'Quote') return "'";
  if (code === 'Comma') return ',';
  if (code === 'Period') return '.';
  if (code === 'Slash') return '/';
  return code;
}

export function formatShortcutBinding(binding: ShortcutBinding): string {
  if (!binding.enabled || !binding.code) return 'Disabled';

  const parts: string[] = [];
  if (binding.ctrlKey) parts.push('Ctrl');
  if (binding.metaKey) parts.push('Meta');
  if (binding.altKey) parts.push('Alt');
  if (binding.shiftKey) parts.push('Shift');
  parts.push(getKeyFromCode(binding.code));
  return parts.join('+');
}

export function createShortcutBinding(input: Partial<ShortcutBinding> & { code: string }): ShortcutBinding {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  const binding: ShortcutBinding = {
    code,
    key: normalizeKey(input.key, code),
    altKey: Boolean(input.altKey),
    ctrlKey: Boolean(input.ctrlKey),
    metaKey: Boolean(input.metaKey),
    shiftKey: Boolean(input.shiftKey),
    enabled: input.enabled !== false,
    label: '',
  };

  return {
    ...binding,
    label: formatShortcutBinding(binding),
  };
}

export function createDisabledShortcutBinding(): ShortcutBinding {
  return {
    code: '',
    key: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    enabled: false,
    label: 'Disabled',
  };
}


export function createShortcutBindingFromKeyboardEvent(event: KeyboardEvent): ShortcutBinding | null {
  if (!event.code || isModifierOnlyShortcutEvent(event)) return null;
  if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    return null;
  }

  return createShortcutBinding({
    code: event.code,
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
}

function normalizeShortcutBinding(value: unknown, fallback: ShortcutBinding): ShortcutBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createShortcutBinding(fallback);
  }

  const raw = value as Partial<ShortcutBinding>;
  if (raw.enabled === false || raw.code === '') {
    return createDisabledShortcutBinding();
  }

  if (typeof raw.code !== 'string' || raw.code.trim() === '') {
    return createShortcutBinding(fallback);
  }

  return createShortcutBinding(raw as Partial<ShortcutBinding> & { code: string });
}

export function normalizeShortcutConfig(value: unknown): ShortcutConfig {
  const defaults = DEFAULT_SHORTCUT_CONFIG;
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return SHORTCUT_ACTION_IDS.reduce((config, actionId) => {
    config[actionId] = normalizeShortcutBinding(source[actionId], defaults[actionId]);
    return config;
  }, {} as ShortcutConfig);
}

export function getShortcutConfig(): ShortcutConfig {
  const storage = getStorage();
  if (!storage) return cloneDefaultConfig();

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return cloneDefaultConfig();
    return normalizeShortcutConfig(JSON.parse(raw));
  } catch (error) {
    logger.warn('Failed to read shortcut config', error);
    return cloneDefaultConfig();
  }
}

export function saveShortcutConfig(config: ShortcutConfig): ShortcutConfig {
  const normalized = normalizeShortcutConfig(config);
  const storage = getStorage();

  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
      logger.error('Failed to save shortcut config', error);
    }
  }

  dispatchShortcutConfigChanged(normalized);
  return normalized;
}

export function resetShortcutConfig(): ShortcutConfig {
  const normalized = cloneDefaultConfig();
  const storage = getStorage();

  if (storage) {
    try {
      storage.removeItem(STORAGE_KEY);
    } catch (error) {
      logger.error('Failed to reset shortcut config', error);
    }
  }

  dispatchShortcutConfigChanged(normalized);
  return normalized;
}

export function dispatchShortcutConfigChanged(config: ShortcutConfig): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ShortcutConfig>(SHORTCUT_CONFIG_CHANGED_EVENT, { detail: config }));
}

export function getShortcutSignature(binding: ShortcutBinding): string | null {
  if (!binding.enabled || !binding.code) return null;

  return [
    binding.ctrlKey ? 'Ctrl' : '',
    binding.metaKey ? 'Meta' : '',
    binding.altKey ? 'Alt' : '',
    binding.shiftKey ? 'Shift' : '',
    binding.code,
  ].filter(Boolean).join('+');
}

export function findShortcutConflicts(config: ShortcutConfig): ShortcutConflict[] {
  const bySignature = new Map<string, ShortcutActionId[]>();

  for (const actionId of SHORTCUT_ACTION_IDS) {
    const signature = getShortcutSignature(config[actionId]);
    if (!signature) continue;
    const actionIds = bySignature.get(signature) ?? [];
    actionIds.push(actionId);
    bySignature.set(signature, actionIds);
  }

  return Array.from(bySignature.entries())
    .filter(([, actionIds]) => actionIds.length > 1)
    .map(([signature, actionIds]) => ({ signature, actionIds }));
}

export function matchesShortcutEvent(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  if (!binding.enabled || !binding.code) return false;
  return event.code === binding.code
    && event.altKey === binding.altKey
    && event.ctrlKey === binding.ctrlKey
    && event.metaKey === binding.metaKey
    && event.shiftKey === binding.shiftKey;
}

export function isTypingShortcutTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;

  const tagName = element.tagName;
  return tagName === 'INPUT'
    || tagName === 'TEXTAREA'
    || tagName === 'SELECT'
    || element.isContentEditable
    || Boolean(element.closest('[contenteditable="true"]'));
}

export function isKnownShortcutActionId(value: unknown): value is ShortcutActionId {
  return isShortcutActionId(value);
}
