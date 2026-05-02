import { describe, expect, it } from 'vitest';
import {
  AudioDevicesResponseSchema,
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
  sampleRates: [44100, 48000],
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
      currentSettings: { inputDeviceName: 'USB Audio', inputSampleRate: 48000 },
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

  it('accepts device responses with backend-provided options', () => {
    const parsed = AudioDevicesResponseSchema.parse({
      inputDevices: [device],
      outputDevices: [{ ...device, id: 'output-1', type: 'output' }],
      inputBufferSizes: [128, 256, 512, 768, 1024],
      outputBufferSizes: [128, 256, 512, 768, 1024],
    });

    expect(parsed.inputDevices[0]?.sampleRates).toEqual([44100, 48000]);
    expect(parsed.inputBufferSizes).toContain(768);
  });

  it('accepts legacy and split audio settings', () => {
    expect(AudioDeviceSettingsResponseSchema.parse({
      success: true,
      currentSettings: { sampleRate: 48000, bufferSize: 1024 },
      deviceResolution: {
        input: {
          configuredDeviceName: null,
          configuredDevice: null,
          effectiveDevice: device,
          status: 'default',
        },
        output: {
          configuredDeviceName: null,
          configuredDevice: null,
          effectiveDevice: device,
          status: 'default',
        },
      },
    }).currentSettings.sampleRate).toBe(48000);

    expect(AudioDeviceSettingsResponseSchema.parse({
      success: true,
      currentSettings: {
        inputSampleRate: 16000,
        outputSampleRate: 48000,
        inputBufferSize: 256,
        outputBufferSize: 1024,
      },
      deviceResolution: {
        input: {
          configuredDeviceName: null,
          configuredDevice: null,
          effectiveDevice: device,
          status: 'default',
        },
        output: {
          configuredDeviceName: null,
          configuredDevice: null,
          effectiveDevice: device,
          status: 'default',
        },
      },
    }).currentSettings.outputBufferSize).toBe(1024);
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
