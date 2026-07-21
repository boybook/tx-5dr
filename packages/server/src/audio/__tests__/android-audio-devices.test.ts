import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  androidDescriptorToAudioDevice,
  getAndroidAudioDevices,
  getAndroidAudioStartFailure,
  resolveAndroidAudioDevice,
  type AndroidAudioDeviceDescriptor,
} from '../android-audio-devices.js';

function writeManifest(
  inputDevices: unknown[],
  outputDevices: unknown[] = [],
  manifestFields: Record<string, unknown> = {},
): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx5dr-android-manifest-'));
  const file = join(directory, 'devices.json');
  writeFileSync(file, JSON.stringify({ ...manifestFields, inputDevices, outputDevices }));
  return file;
}

function device(overrides: Partial<AndroidAudioDeviceDescriptor> = {}): AndroidAudioDeviceDescriptor {
  return {
    id: 'android-input-7',
    androidDeviceId: 7,
    name: '[Android] Wired headset',
    direction: 'input',
    kind: 'wiredHeadset',
    channels: 1,
    sampleRate: 48000,
    sampleRates: [48000],
    format: 's16le',
    socketPath: '/tmp/audio-input-7.sock',
    available: true,
    isDefault: true,
    routeKey: 'android:wired-headset:input',
    transport: 'wired',
    connector: 'analog',
    routeState: 'idle',
    routeVerified: false,
    ...overrides,
  };
}

describe('Android audio manifest compatibility and stable resolution', () => {
  beforeEach(() => {
    process.env.TX5DR_RUNTIME_FLAVOR = 'android-bridge';
  });

  afterEach(() => {
    delete process.env.TX5DR_RUNTIME_FLAVOR;
    delete process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE;
  });

  it('accepts the minimal legacy manifest and supplies safe public defaults', () => {
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest([{
      id: 'android-input-1',
      name: '[Android] Legacy microphone',
      direction: 'input',
      format: 's16le',
      socketPath: '/tmp/legacy-input.sock',
    }]);

    const descriptors = getAndroidAudioDevices('input');
    expect(descriptors).toHaveLength(1);
    expect(androidDescriptorToAudioDevice(descriptors[0]!)).toMatchObject({
      id: 'android-input-1',
      backend: 'android',
      kind: 'unknown',
      transport: 'unknown',
      connector: 'unknown',
      channels: 1,
      sampleRate: 48000,
      availability: 'available',
    });
  });

  it('normalizes analog endpoint metadata for the public contract', () => {
    const publicDevice = androidDescriptorToAudioDevice(device({
      clientConnected: true,
      routeVerified: true,
      routeState: 'verified',
      capabilities: { sampleFormats: ['s16le', 'f32le'], outputRouteAck: true },
    }));

    expect(publicDevice).toMatchObject({
      backend: 'android',
      kind: 'wired-headset',
      routeKey: 'android:wired-headset:input',
      transport: 'analog',
      connector: '3.5mm',
      clientConnected: true,
      routeVerified: true,
      routeState: 'verified',
      availability: 'active',
      capabilities: {
        sampleFormats: ['int16', 'float32'],
        outputRouteAck: true,
      },
    });
  });

  it('resolves by stable route key before a stale numeric Android ID or duplicate name', () => {
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest([
      device({ id: 'android-input-41', androidDeviceId: 41, routeKey: 'android:wired-headset:input:a' }),
      device({ id: 'android-input-99', androidDeviceId: 99, routeKey: 'android:wired-headset:input:b' }),
    ]);

    expect(resolveAndroidAudioDevice(
      'input',
      '[Android] Wired headset',
      'android-input-41',
      'android:wired-headset:input:b',
    )?.id).toBe('android-input-99');
  });

  it('keeps legacy USB selections on USB when an analog endpoint is the system default', () => {
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest([
      device({ id: 'android-input-7', kind: 'wiredHeadset', isDefault: true }),
      device({ id: 'android-input-22', kind: 'usb', isDefault: false, name: '[Android] USB codec' }),
    ]);

    expect(resolveAndroidAudioDevice('input', 'TX5DRAndroidUsbInput')?.id).toBe('android-input-22');
  });

  it('recovers a changed USB numeric ID only when its stable route key still matches', () => {
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest([
      device({ id: 'android-input-wired-headset', kind: 'wiredHeadset', isDefault: true }),
      device({
        id: 'android-input-41',
        androidDeviceId: 41,
        kind: 'usb',
        name: '[Android] USB codec',
        routeKey: 'android:usb:input:card-2-device-0',
        isDefault: false,
      }),
    ]);

    expect(resolveAndroidAudioDevice(
      'input',
      '[Android] USB codec',
      'android-input-7',
      'android:usb:input:card-2-device-0',
    )?.id).toBe('android-input-41');
  });

  it('does not switch to a same-named USB endpoint when the saved route key is gone', () => {
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest([
      device({
        id: 'android-input-41',
        androidDeviceId: 41,
        kind: 'usb',
        name: '[Android] USB codec',
        routeKey: 'android:usb:input:replacement',
      }),
    ]);

    expect(resolveAndroidAudioDevice(
      'input',
      '[Android] USB codec',
      'android-input-7',
      'android:usb:input:original',
    )).toBeNull();
  });

  it('retries historical route failures while rejecting endpoints that are still unavailable', () => {
    expect(getAndroidAudioStartFailure(device({ routeState: 'idle', routeVerified: false }))).toBeNull();
    expect(getAndroidAudioStartFailure(device({ routeState: 'lost', failureReason: 'route lost' }))).toBeNull();
    expect(getAndroidAudioStartFailure(device({ routeState: 'failed', failureReason: 'HAL refused route' }))).toBeNull();
    expect(getAndroidAudioStartFailure(device({
      available: false,
      routeState: 'unavailable',
      failureReason: 'headset unplugged',
    }))).toBe('headset unplugged');
  });

  it('rejects unsupported manifest versions and tolerates malformed optional capabilities', () => {
    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest(
      [device()],
      [],
      { schemaVersion: 3 },
    );
    expect(getAndroidAudioDevices('input')).toEqual([]);

    process.env.TX5DR_ANDROID_AUDIO_DEVICES_FILE = writeManifest([device({
      capabilities: {
        sampleFormats: 's16le',
        channelModes: { mono: true },
        outputRouteAck: 'yes',
      } as unknown as AndroidAudioDeviceDescriptor['capabilities'],
    })], [], { schemaVersion: 2 });
    const parsed = androidDescriptorToAudioDevice(getAndroidAudioDevices('input')[0]!);
    expect(parsed.capabilities).toMatchObject({ sampleFormats: ['int16'] });
    expect(parsed.capabilities?.channelModes).toBeUndefined();
    expect(parsed.capabilities?.outputRouteAck).toBeUndefined();
  });
});
