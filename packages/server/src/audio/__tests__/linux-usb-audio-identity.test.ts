import { describe, expect, it } from 'vitest';
import {
  buildAlsaRouteKey,
  buildUnavailableAlsaEndpoints,
  deriveRadioLabelFromSerial,
  deriveUniqueRadioLabelFromSerials,
  enrichAlsaAudioDevices,
  enrichPulseAudioDevices,
  parseAlsaNativeLocator,
  type LinuxUsbAudioIdentity,
  type RtAudioObservedDevice,
} from '../linux-usb-audio-identity.js';

const identities: LinuxUsbAudioIdentity[] = [
  {
    alsaCard: 0,
    alsaCardId: 'CODEC',
    productName: 'USB Audio CODEC',
    usbPath: '1-7.2.4',
    vendorId: '08bb',
    productId: '2901',
    relatedRadioLabel: 'IC-9700 12010311',
    relatedSerials: ['IC-9700 12010311 A', 'IC-9700 12010311 B'],
    detail: 'IC-9700 12010311 · VID:PID 08bb:2901 · USB 1-7.2.4',
    endpoints: [
      { device: 0, direction: 'input', busy: false },
      { device: 0, direction: 'output', busy: true, ownerPid: 4000 },
    ],
  },
  {
    alsaCard: 2,
    alsaCardId: 'CODEC_1',
    productName: 'USB Audio CODEC',
    usbPath: '1-7.4.4',
    vendorId: '08bb',
    productId: '2901',
    relatedRadioLabel: 'IC-7610 11002034',
    relatedSerials: ['IC-7610 11002034 A', 'IC-7610 11002034 B'],
    detail: 'IC-7610 11002034 · VID:PID 08bb:2901 · USB 1-7.4.4',
    endpoints: [
      { device: 0, direction: 'input', busy: true, ownerPid: 1234 },
      { device: 0, direction: 'output', busy: false },
    ],
  },
];

function observed(id: string, nativeId?: string): RtAudioObservedDevice {
  return {
    id,
    name: 'USB Audio CODEC (USB Audio)',
    isDefault: false,
    channels: 2,
    sampleRate: 48000,
    type: 'input',
    backend: 'rtaudio',
    ...(nativeId ? { nativeId } : {}),
  };
}

describe('Linux USB audio identity', () => {
  it('normalizes Icom A/B serial-port labels to a radio identity', () => {
    expect(deriveRadioLabelFromSerial('IC-9700 12010311 A')).toBe('IC-9700 12010311');
    expect(deriveRadioLabelFromSerial('IC-7610_11002034_B')).toBe('IC-7610 11002034');
  });

  it('does not guess a radio when a parent hub exposes multiple radio labels', () => {
    expect(deriveUniqueRadioLabelFromSerials([
      'IC-9700 12010311 A',
      'IC-9700 12010311 B',
    ])).toBe('IC-9700 12010311');
    expect(deriveUniqueRadioLabelFromSerials([
      'IC-9700 12010311 A',
      'IC-7610 11002034 A',
    ])).toBeUndefined();
  });

  it('parses only explicit ALSA hardware locators', () => {
    expect(parseAlsaNativeLocator('hw:CODEC_1,0')).toEqual({ cardId: 'CODEC_1', device: 0 });
    expect(parseAlsaNativeLocator('pulse')).toBeNull();
    expect(parseAlsaNativeLocator(undefined)).toBeNull();
  });

  it('maps identical codec names by exact ALSA native locator rather than list order', () => {
    const devices = enrichAlsaAudioDevices([
      observed('input-130', 'hw:CODEC_1,0'),
      observed('input-134', 'hw:CODEC,0'),
    ], 'input', identities);

    expect(devices[0]).toMatchObject({
      id: 'input-130',
      serialNumber: 'IC-7610 11002034',
      alsaCardId: 'CODEC_1',
    });
    expect(devices[1]).toMatchObject({
      id: 'input-134',
      serialNumber: 'IC-9700 12010311',
      alsaCardId: 'CODEC',
    });
    expect(devices[0].routeKey).not.toBe(devices[1].routeKey);
  });

  it('fails closed when a backend does not expose a native locator', () => {
    const [device] = enrichAlsaAudioDevices([observed('input-7')], 'input', identities);
    expect(device.routeKey).toBeUndefined();
    expect(device.serialNumber).toBeUndefined();
  });

  it('uses the Pulse source or sink node as a stable backend route without ALSA enrichment', () => {
    const devices = enrichPulseAudioDevices([
      observed('input-11', 'alsa_input.usb-Burr-Brown_USB_Audio_CODEC-00.analog-stereo'),
      observed('input-12', 'alsa_input.usb-Burr-Brown_USB_Audio_CODEC-01.analog-stereo'),
    ], 'input');
    expect(devices[0]).toMatchObject({
      routeKey: 'rtaudio:pulse:alsa_input.usb-Burr-Brown_USB_Audio_CODEC-00.analog-stereo:input',
      detail: 'PulseAudio node alsa_input.usb-Burr-Brown_USB_Audio_CODEC-00.analog-stereo',
    });
    expect(devices[0].routeKey).not.toBe(devices[1].routeKey);
    expect(devices[0].serialNumber).toBeUndefined();
    expect(devices[0].alsaCardId).toBeUndefined();
  });

  it('keeps the route key stable across ALSA card index and card-id changes', () => {
    const before = buildAlsaRouteKey(identities[0], 0, 'input');
    const after = buildAlsaRouteKey({
      ...identities[0],
      alsaCard: 9,
      alsaCardId: 'CODEC_4',
    }, 0, 'input');
    expect(after).toBe(before);
  });

  it('models capture and playback busy state independently', () => {
    const input = buildUnavailableAlsaEndpoints('input', new Set(), identities, 1234);
    const output = buildUnavailableAlsaEndpoints('output', new Set(), identities, 1234);

    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      serialNumber: 'IC-7610 11002034',
      availability: 'active',
      isActiveByTx5dr: true,
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      serialNumber: 'IC-9700 12010311',
      availability: 'cached',
      routeState: 'unavailable',
      isActiveByTx5dr: false,
    });
  });
});
