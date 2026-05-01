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
    'audio.default': '默认',
    'audio.channels': `${options?.count} 声道`,
    'audio.deviceUnavailable': '设备当前不可用，音频将自动重试',
    'audio.deviceVirtualSelected': '虚拟音频设备',
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
    expect(formatDeviceText(zh, defaultInput)).toBe('Built-in Mic (默认)');
    expect(formatDeviceText(en, defaultInput)).toBe('Built-in Mic (default)');
  });

  it('formats channel counts through i18n interpolation', () => {
    expect(formatChannelText(zh, 2)).toBe('2 声道');
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
    expect(getResolutionDescription(zh, missing)).toBe('设备当前不可用，音频将自动重试');
    expect(getResolutionTone(virtual)).toBe('virtual');
    expect(getResolutionDescription(en, virtual)).toBe('Virtual audio device');
  });
});
