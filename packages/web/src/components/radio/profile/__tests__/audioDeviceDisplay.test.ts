import { describe, expect, it } from 'vitest';
import type { AudioDeviceResolution } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';
import {
  formatChannelText,
  formatDeviceText,
  getAudioDeviceCategory,
  getAudioDeviceStatusBadges,
  getResolutionDescription,
  getResolutionTone,
} from '../audioDeviceDisplay';

const zh = ((key: string, options?: Record<string, unknown>) => {
  const values: Record<string, string> = {
    'audio.default': '\u9ed8\u8ba4',
    'audio.channels': `${options?.count} \u58f0\u9053`,
    'audio.deviceMissingPreserved': '\u5df2\u4fdd\u5b58\u6b64\u8bbe\u5907\u914d\u7f6e\uff0c\u4f46\u5f53\u524d\u672a\u8fde\u63a5\u6216\u672a\u679a\u4e3e\u5230\uff1b\u4fdd\u5b58\u4e0d\u4f1a\u6e05\u7a7a\u8be5\u8bbe\u5907\uff0c\u8fde\u63a5\u540e\u4f1a\u81ea\u52a8\u91cd\u8bd5\u3002',
    'audio.deviceVirtualSelected': '\u865a\u62df\u97f3\u9891\u8bbe\u5907',
  };
  return values[key] ?? key;
}) as unknown as TFunction;

const en = ((key: string, options?: Record<string, unknown>) => {
  const values: Record<string, string> = {
    'audio.default': 'default',
    'audio.channels': `${options?.count} ch`,
    'audio.deviceMissingPreserved': 'This saved device is not connected or is not currently enumerated. Saving will keep this device; audio will retry when it reconnects.',
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
    expect(getResolutionDescription(zh, missing)).toBe('\u5df2\u4fdd\u5b58\u6b64\u8bbe\u5907\u914d\u7f6e\uff0c\u4f46\u5f53\u524d\u672a\u8fde\u63a5\u6216\u672a\u679a\u4e3e\u5230\uff1b\u4fdd\u5b58\u4e0d\u4f1a\u6e05\u7a7a\u8be5\u8bbe\u5907\uff0c\u8fde\u63a5\u540e\u4f1a\u81ea\u52a8\u91cd\u8bd5\u3002');
    expect(getResolutionTone(virtual)).toBe('virtual');
    expect(getResolutionDescription(en, virtual)).toBe('Virtual audio device');
  });

  it('classifies USB, 3.5 mm, built-in, and network endpoints', () => {
    expect(getAudioDeviceCategory({ ...defaultInput, kind: 'usb' })).toBe('usb');
    expect(getAudioDeviceCategory({
      ...defaultInput,
      kind: 'wired-headset',
      connector: '3.5mm',
    })).toBe('analog');
    expect(getAudioDeviceCategory({ ...defaultInput, kind: 'builtin-mic' })).toBe('builtin');
    expect(getAudioDeviceCategory({
      ...defaultInput,
      backend: 'openwebrx',
      kind: 'network',
    })).toBe('network');
  });

  it('shows verified and lost route health without treating an idle route as failed', () => {
    expect(getAudioDeviceStatusBadges({
      ...defaultInput,
      backend: 'android',
      availability: 'active',
      routeState: 'verified',
      routeVerified: true,
      clientConnected: true,
    }).map((badge) => badge.key)).toEqual(['active', 'clientConnected', 'routeVerified']);

    expect(getAudioDeviceStatusBadges({
      ...defaultInput,
      backend: 'android',
      availability: 'available',
      routeState: 'idle',
      routeVerified: false,
    }).map((badge) => badge.key)).toEqual(['available']);

    expect(getAudioDeviceStatusBadges({
      ...defaultInput,
      backend: 'android',
      availability: 'cached',
      routeState: 'lost',
      routeVerified: false,
      failureReason: 'unplugged',
    }).map((badge) => badge.key)).toEqual(['routeLost']);
  });
});
