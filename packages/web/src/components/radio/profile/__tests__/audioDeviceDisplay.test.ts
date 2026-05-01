import { describe, expect, it } from 'vitest';
import type { AudioDeviceResolution } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';
import {
  formatChannelText,
  formatDeviceText,
  getResolutionDescription,
  getResolutionTone,
} from '../audioDeviceDisplay';

const zh = ((key: string, options?: Record<string, unknown>) => {
  const values: Record<string, string> = {
    'audio.default': '\u9ed8\u8ba4',
    'audio.channels': `${options?.count} \u58f0\u9053`,
    'audio.deviceUnavailable': '\u8bbe\u5907\u5f53\u524d\u4e0d\u53ef\u7528\uff0c\u97f3\u9891\u5c06\u81ea\u52a8\u91cd\u8bd5',
    'audio.deviceVirtualSelected': '\u865a\u62df\u97f3\u9891\u8bbe\u5907',
  };
  return values[key] ?? key;
}) as unknown as TFunction;

const en = ((key: string, options?: Record<string, unknown>) => {
  const values: Record<string, string> = {
    'audio.default': 'default',
    'audio.channels': `${options?.count} ch`,
    'audio.deviceUnavailable': 'Device currently unavailable; audio will retry automatically',
    'audio.deviceVirtualSelected': 'Virtual audio device',
  };
  return values[key] ?? key;
}) as unknown as TFunction;

const defaultInput = {
  id: 'input-1',
  name: 'Built-in Mic',
  isDefault: true,
  channels: 2,
  sampleRate: 48000,
  type: 'input' as const,
};

describe('audio device display helpers', () => {
  it('formats default suffix without duplicate parentheses', () => {
    expect(formatDeviceText(zh, defaultInput)).toBe('Built-in Mic (\u9ed8\u8ba4)');
    expect(formatDeviceText(en, defaultInput)).toBe('Built-in Mic (default)');
  });

  it('formats channel counts through i18n interpolation', () => {
    expect(formatChannelText(zh, 2)).toBe('2 \u58f0\u9053');
    expect(formatChannelText(en, 2)).toBe('2 ch');
  });

  it('describes missing and virtual resolutions', () => {
    const missing: AudioDeviceResolution = {
      configuredDeviceName: 'Missing USB',
      configuredDevice: null,
      effectiveDevice: null,
      status: 'missing',
    };
    const virtual: AudioDeviceResolution = {
      configuredDeviceName: 'ICOM WLAN',
      configuredDevice: null,
      effectiveDevice: null,
      status: 'virtual-selected',
    };

    expect(getResolutionTone(missing)).toBe('warning');
    expect(getResolutionDescription(zh, missing)).toBe('\u8bbe\u5907\u5f53\u524d\u4e0d\u53ef\u7528\uff0c\u97f3\u9891\u5c06\u81ea\u52a8\u91cd\u8bd5');
    expect(getResolutionTone(virtual)).toBe('virtual');
    expect(getResolutionDescription(en, virtual)).toBe('Virtual audio device');
  });
});
