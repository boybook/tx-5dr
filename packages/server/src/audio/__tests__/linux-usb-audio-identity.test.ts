import { describe, expect, it } from 'vitest';
import {
  assignBusyIdentitiesToActiveDevices,
  attachLinuxUsbAudioIdentities,
  buildSupplementalUsbAudioDevices,
  buildUsbAudioDetail,
  dedupeAudioDevicesByHardwareId,
  deriveRadioLabelFromSerial,
  type LinuxUsbAudioIdentity,
} from '../linux-usb-audio-identity.js';

describe('deriveRadioLabelFromSerial', () => {
  it('collapses Icom A/B port suffixes', () => {
    expect(deriveRadioLabelFromSerial('IC-9700 12010311 A')).toBe('IC-9700 12010311');
    expect(deriveRadioLabelFromSerial('IC-7610_11002034_B')).toBe('IC-7610 11002034');
  });
});

describe('buildUsbAudioDetail', () => {
  it('prefer radio label then USB metadata', () => {
    expect(buildUsbAudioDetail({
      relatedRadioLabel: 'IC-9700 12010311',
      vendorId: '08bb',
      productId: '2901',
      usbPath: '1-7.2.4',
    })).toBe('IC-9700 12010311 · VID:PID 08bb:2901 · USB 1-7.2.4');
  });
});

const identities: LinuxUsbAudioIdentity[] = [
  {
    hardwareId: 'usb:1-7.2.4',
    alsaCard: 0,
    alsaCardId: 'CODEC',
    productName: 'USB Audio CODEC',
    usbPath: '1-7.2.4',
    vendorId: '08bb',
    productId: '2901',
    relatedRadioLabel: 'IC-9700 12010311',
    relatedSerials: ['IC-9700 12010311 A', 'IC-9700 12010311 B'],
    detail: 'IC-9700 12010311 · VID:PID 08bb:2901 · USB 1-7.2.4',
    pcmBusy: true,
    ownerPid: 1234,
  },
  {
    hardwareId: 'usb:1-7.4.4',
    alsaCard: 2,
    alsaCardId: 'CODEC_1',
    productName: 'USB Audio CODEC',
    usbPath: '1-7.4.4',
    vendorId: '08bb',
    productId: '2901',
    relatedRadioLabel: 'IC-7610 11002034',
    relatedSerials: ['IC-7610 11002034 A', 'IC-7610 11002034 B'],
    detail: 'IC-7610 11002034 · VID:PID 08bb:2901 · USB 1-7.4.4',
    pcmBusy: false,
  },
];

describe('attachLinuxUsbAudioIdentities', () => {
  it('only attaches free cards when busy cards are absent from RtAudio', () => {
    const devices = [
      { id: 'input-134', name: 'USB Audio CODEC (USB Audio)' },
      { id: 'input-131', name: 'HDA Intel PCH (ALC897 Analog)' },
    ];

    const enriched = attachLinuxUsbAudioIdentities(devices, identities, 1234);
    expect(enriched[0]).toMatchObject({
      hardwareId: 'usb:1-7.4.4',
      serialNumber: 'IC-7610 11002034',
    });
    expect(enriched[1].hardwareId).toBeUndefined();
  });

  it('does not FIFO-label owned busy cards onto remaining enumerated USB devices', () => {
    // RtAudio often still lists the busy codec alongside the free peer. Claiming
    // owned identities first would mislabel the free peer as the open radio.
    const devices = [
      { id: 'output-130', name: 'USB Audio CODEC (USB Audio)' },
      { id: 'output-134', name: 'USB Audio CODEC (USB Audio)' },
    ];

    const enriched = attachLinuxUsbAudioIdentities(devices, identities, 1234);
    expect(enriched[0]).toMatchObject({
      hardwareId: 'usb:1-7.4.4',
      serialNumber: 'IC-7610 11002034',
    });
    // Busy IC-9700 must not be attached by listing order onto the second device.
    expect(enriched[1].hardwareId).toBeUndefined();
  });
});

describe('assignBusyIdentitiesToActiveDevices', () => {
  it('labels the active busy codec owned by this process as IC-9700', () => {
    const devices = [
      {
        id: 'input-130',
        name: 'USB Audio CODEC (USB Audio)',
        isActiveByTx5dr: true,
      },
      {
        id: 'input-134',
        name: 'USB Audio CODEC (USB Audio)',
        hardwareId: 'usb:1-7.4.4',
        isActiveByTx5dr: false,
      },
    ];

    const enriched = assignBusyIdentitiesToActiveDevices(devices, identities, 1234);
    expect(enriched[0]).toMatchObject({
      hardwareId: 'usb:1-7.2.4',
      serialNumber: 'IC-9700 12010311',
      detail: expect.stringContaining('IC-9700'),
    });
    expect(enriched[1].hardwareId).toBe('usb:1-7.4.4');
  });
});

describe('buildSupplementalUsbAudioDevices', () => {
  it('adds missing busy radios that RtAudio stopped enumerating', () => {
    const supplemental = buildSupplementalUsbAudioDevices(
      'input',
      new Set(['usb:1-7.4.4']),
      identities,
    );
    expect(supplemental).toHaveLength(1);
    expect(supplemental[0]).toMatchObject({
      id: 'input-usb:1-7.2.4',
      hardwareId: 'usb:1-7.2.4',
      availability: 'cached',
      detail: expect.stringContaining('IC-9700'),
    });
  });
});

describe('dedupeAudioDevicesByHardwareId', () => {
  it('keeps the active entry when hardware ids collide', () => {
    const devices = [
      {
        id: 'input-usb:1-7.2.4',
        hardwareId: 'usb:1-7.2.4',
        availability: 'cached',
      },
      {
        id: 'input-130',
        hardwareId: 'usb:1-7.2.4',
        availability: 'active',
        isActiveByTx5dr: true,
      },
      {
        id: 'input-134',
        hardwareId: 'usb:1-7.4.4',
        availability: 'available',
      },
    ];

    const deduped = dedupeAudioDevicesByHardwareId(devices);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((device) => device.id)).toEqual(['input-130', 'input-134']);
  });
});
