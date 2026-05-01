import { describe, expect, it } from 'vitest';
import {
  AudioDeviceResolutionSchema,
  AudioDeviceResolutionStatusSchema,
  AudioDeviceSettingsResponseSchema,
  AudioSettingsResolveResponseSchema,
} from '../audio.schema.js';

const device = {
  id: 'input-1',
  name: 'USB Audio',
  isDefault: true,
  channels: 2,
  sampleRate: 48000,
  type: 'input' as const,
};

describe('audio device resolution schemas', () => {
  it('accepts every resolution status', () => {
    for (const status of ['selected', 'default', 'virtual-selected', 'missing']) {
      expect(AudioDeviceResolutionStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects removed fallback-default resolution status', () => {
    expect(() => AudioDeviceResolutionStatusSchema.parse('fallback-default')).toThrow();
  });

  it('describes configured and effective devices', () => {
    expect(AudioDeviceResolutionSchema.parse({
      configuredDeviceName: 'USB Audio',
      configuredDevice: device,
      effectiveDevice: device,
      status: 'selected',
      reason: null,
    }).effectiveDevice?.name).toBe('USB Audio');
  });

  it('requires resolution details on settings responses', () => {
    const parsed = AudioDeviceSettingsResponseSchema.parse({
      success: true,
      currentSettings: { inputDeviceName: 'USB Audio', sampleRate: 48000 },
      deviceResolution: {
        input: {
          configuredDeviceName: 'USB Audio',
          configuredDevice: device,
          effectiveDevice: device,
          status: 'selected',
        },
        output: {
          configuredDeviceName: null,
          configuredDevice: null,
          effectiveDevice: null,
          status: 'default',
        },
      },
    });

    expect(parsed.deviceResolution.input.status).toBe('selected');
  });

  it('accepts resolve responses with every supported status', () => {
    for (const status of ['selected', 'default', 'virtual-selected', 'missing'] as const) {
      expect(AudioSettingsResolveResponseSchema.parse({
        success: true,
        deviceResolution: {
          input: {
            configuredDeviceName: status === 'default' ? null : 'USB Audio',
            configuredDevice: status === 'selected' ? device : null,
            effectiveDevice: status === 'missing' ? null : device,
            status,
          },
          output: {
            configuredDeviceName: null,
            configuredDevice: null,
            effectiveDevice: device,
            status: 'default',
          },
        },
      }).deviceResolution.input.status).toBe(status);
    }
  });
});
