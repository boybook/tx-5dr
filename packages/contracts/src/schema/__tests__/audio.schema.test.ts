import { describe, expect, it } from 'vitest';
import {
  AudioDevicesResponseSchema,
  AudioDeviceSchema,
  AudioDeviceResolutionSchema,
  AudioDeviceResolutionStatusSchema,
  AudioDeviceSettingsSchema,
  AudioDeviceSettingsResponseSchema,
  AudioOutputChannelModeSchema,
  AudioOutputSampleFormatSchema,
  AudioSettingsResolveRequestSchema,
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
  availability: 'available' as const,
  isActiveByTx5dr: false,
  lastSeenAt: 1_700_000_000_000,
};

describe('audio device resolution schemas', () => {
  it('accepts Android route identity, health, and fixed audio capabilities', () => {
    const parsed = AudioDeviceSchema.parse({
      ...device,
      backend: 'android',
      kind: 'wired-headset',
      routeKey: 'android:wired-headset:input',
      transport: 'analog',
      connector: '3.5mm',
      clientConnected: true,
      routeVerified: true,
      routeState: 'verified',
      capabilities: {
        sampleRates: [48000],
        bufferSizes: [960],
        channelCounts: [1],
        sampleFormats: ['int16'],
        channelModes: ['mono'],
        sampleRateConfigurable: false,
        bufferSizeConfigurable: false,
        sampleFormatConfigurable: false,
        channelModeConfigurable: false,
        outputRouteAck: true,
        fixedSampleRate: 48000,
        fixedBufferSize: 960,
        fixedChannelCount: 1,
      },
    });

    expect(parsed.routeKey).toBe('android:wired-headset:input');
    expect(parsed.capabilities?.fixedChannelCount).toBe(1);
    expect(parsed.capabilities?.outputRouteAck).toBe(true);
  });

  it('accepts route loss diagnostics without treating routeVerified as required', () => {
    expect(AudioDeviceSchema.parse({
      ...device,
      backend: 'android',
      routeState: 'lost',
      routeVerified: false,
      failureReason: 'The headset was unplugged',
    })).toMatchObject({
      routeState: 'lost',
      routeVerified: false,
    });

    expect(AudioDeviceSchema.parse({
      ...device,
      backend: 'android',
      routeState: 'idle',
      routeVerified: false,
    }).failureReason).toBeUndefined();
  });

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
    expect(parsed.inputDevices[0]?.availability).toBe('available');
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

  it('keeps stable route keys alongside legacy display names', () => {
    const parsed = AudioDeviceSettingsSchema.parse({
      inputDeviceName: 'Headset microphone',
      inputRouteKey: 'android:wired-headset:input',
      outputDeviceName: 'Headset headphones',
      outputRouteKey: 'android:wired-headset:output',
    });

    expect(parsed).toMatchObject({
      inputDeviceName: 'Headset microphone',
      inputRouteKey: 'android:wired-headset:input',
      outputDeviceName: 'Headset headphones',
      outputRouteKey: 'android:wired-headset:output',
    });
    expect(AudioDeviceSettingsSchema.parse({ inputDeviceName: 'Legacy USB Audio' })).toEqual({
      inputDeviceName: 'Legacy USB Audio',
    });
    expect(AudioDeviceSettingsSchema.parse({ inputRouteKey: null })).toEqual({ inputRouteKey: null });
    expect(() => AudioDeviceSettingsSchema.parse({ inputRouteKey: '' })).toThrow();
  });

  it('accepts and validates output diagnostic audio settings', () => {
    expect(AudioOutputSampleFormatSchema.parse('int16')).toBe('int16');
    expect(AudioOutputChannelModeSchema.parse('both')).toBe('both');
    expect(AudioDeviceSettingsSchema.parse({
      outputSampleFormat: 'int16',
      outputChannelMode: 'right',
    })).toMatchObject({
      outputSampleFormat: 'int16',
      outputChannelMode: 'right',
    });

    expect(() => AudioDeviceSettingsSchema.parse({ outputSampleFormat: 'int24' })).toThrow();
    expect(() => AudioDeviceSettingsSchema.parse({ outputChannelMode: 'stereo' })).toThrow();
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

  it('accepts TCI as a radio-audio resolution request context', () => {
    const parsed = AudioSettingsResolveRequestSchema.parse({
      radioType: 'tci',
      audio: {
        inputDeviceName: 'TCI Audio',
        outputDeviceName: 'TCI Audio',
      },
    });

    expect(parsed.radioType).toBe('tci');
  });
});
