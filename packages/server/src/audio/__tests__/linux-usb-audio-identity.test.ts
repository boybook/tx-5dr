import { describe, expect, it } from 'vitest';
import {
  assignBusyIdentitiesToActiveDevices,
  attachLinuxUsbAudioIdentities,
  buildSupplementalUsbAudioDevices,
  buildUsbAudioDetail,
  dedupeAudioDevicesByHardwareId,
  deriveRadioLabelFromSerial,
  findOwnedUsbAudioHardwareId,
  getPcmDirectionStatus,
  isPcmBusyForDirection,
  type LinuxUsbAudioIdentity,
  type PcmDirectionStatus,
} from '../linux-usb-audio-identity.js';

const TX5DR_PID = 1234;
const OTHER_PID = 5678;

function makeIdentity(
  overrides: Partial<Omit<LinuxUsbAudioIdentity, 'pcm'>> & {
    hardwareId: string;
    alsaCard: number;
    relatedRadioLabel: string;
    pcm?: { input?: PcmDirectionStatus; output?: PcmDirectionStatus };
  },
): LinuxUsbAudioIdentity {
  const { pcm, ...rest } = overrides;
  const usbPath = overrides.hardwareId.replace(/^usb:/, '');
  return {
    productName: 'USB Audio CODEC',
    usbPath,
    vendorId: '08bb',
    productId: '2901',
    relatedSerials: [`${overrides.relatedRadioLabel} A`, `${overrides.relatedRadioLabel} B`],
    serialNumber: overrides.relatedRadioLabel,
    detail: `${overrides.relatedRadioLabel} · VID:PID 08bb:2901 · USB ${usbPath}`,
    ...rest,
    pcm: {
      input: pcm?.input ?? { busy: false },
      output: pcm?.output ?? { busy: false },
    },
  };
}

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

// IC-9700 is busy in both directions (owned by us), IC-7610 is free.
const identities: LinuxUsbAudioIdentity[] = [
  makeIdentity({
    hardwareId: 'usb:1-7.2.4',
    alsaCard: 0,
    alsaCardId: 'CODEC',
    relatedRadioLabel: 'IC-9700 12010311',
    pcm: {
      input: { busy: true, ownerPid: TX5DR_PID },
      output: { busy: true, ownerPid: TX5DR_PID },
    },
  }),
  makeIdentity({
    hardwareId: 'usb:1-7.4.4',
    alsaCard: 2,
    alsaCardId: 'CODEC_1',
    relatedRadioLabel: 'IC-7610 11002034',
  }),
];

describe('attachLinuxUsbAudioIdentities', () => {
  it('only attaches free cards when busy cards are absent from RtAudio', () => {
    const devices = [
      { id: 'input-134', name: 'USB Audio CODEC (USB Audio)' },
      { id: 'input-131', name: 'HDA Intel PCH (ALC897 Analog)' },
    ];

    const enriched = attachLinuxUsbAudioIdentities(devices, 'input', identities);
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

    const enriched = attachLinuxUsbAudioIdentities(devices, 'output', identities);
    expect(enriched[0]).toMatchObject({
      hardwareId: 'usb:1-7.4.4',
      serialNumber: 'IC-7610 11002034',
    });
    // Busy IC-9700 must not be attached by listing order onto the second device.
    expect(enriched[1].hardwareId).toBeUndefined();
  });

  it('attaches a card that is busy on the opposite direction but free on this one', () => {
    // Capture is open on IC-9700, playback is free: attaching output devices must
    // still claim IC-9700 because the playback PCM is available.
    const captureOnly = [
      makeIdentity({
        hardwareId: 'usb:1-7.2.4',
        alsaCard: 0,
        relatedRadioLabel: 'IC-9700 12010311',
        pcm: { input: { busy: true, ownerPid: TX5DR_PID }, output: { busy: false } },
      }),
    ];
    const devices = [{ id: 'output-130', name: 'USB Audio CODEC (USB Audio)' }];

    const outputEnriched = attachLinuxUsbAudioIdentities(devices, 'output', captureOnly);
    expect(outputEnriched[0]).toMatchObject({ hardwareId: 'usb:1-7.2.4' });

    const inputEnriched = attachLinuxUsbAudioIdentities(
      [{ id: 'input-130', name: 'USB Audio CODEC (USB Audio)' }],
      'input',
      captureOnly,
    );
    expect(inputEnriched[0].hardwareId).toBeUndefined();
  });
});

describe('per-direction PCM busy modeling', () => {
  it('marks only the capture side busy when playback is free (capture-only busy)', () => {
    const captureOnly = makeIdentity({
      hardwareId: 'usb:1-7.2.4',
      alsaCard: 0,
      relatedRadioLabel: 'IC-9700 12010311',
      pcm: { input: { busy: true, ownerPid: TX5DR_PID }, output: { busy: false } },
    });

    expect(isPcmBusyForDirection(captureOnly, 'input')).toBe(true);
    expect(isPcmBusyForDirection(captureOnly, 'output')).toBe(false);

    const inputSupplemental = buildSupplementalUsbAudioDevices('input', new Set(), [captureOnly]);
    expect(inputSupplemental[0]).toMatchObject({ availability: 'cached' });

    const outputSupplemental = buildSupplementalUsbAudioDevices('output', new Set(), [captureOnly]);
    expect(outputSupplemental[0]).toMatchObject({ availability: 'available' });
  });

  it('marks only the playback side busy when capture is free (playback-only busy)', () => {
    const playbackOnly = makeIdentity({
      hardwareId: 'usb:1-7.2.4',
      alsaCard: 0,
      relatedRadioLabel: 'IC-9700 12010311',
      pcm: { input: { busy: false }, output: { busy: true, ownerPid: TX5DR_PID } },
    });

    expect(getPcmDirectionStatus(playbackOnly, 'output').busy).toBe(true);
    expect(getPcmDirectionStatus(playbackOnly, 'input').busy).toBe(false);

    const outputSupplemental = buildSupplementalUsbAudioDevices('output', new Set(), [playbackOnly]);
    expect(outputSupplemental[0]).toMatchObject({ availability: 'cached' });

    const inputSupplemental = buildSupplementalUsbAudioDevices('input', new Set(), [playbackOnly]);
    expect(inputSupplemental[0]).toMatchObject({ availability: 'available' });
  });

  it('resolves capture ownership without matching a playback owned by another PID', () => {
    const splitOwners = makeIdentity({
      hardwareId: 'usb:1-7.2.4',
      alsaCard: 0,
      relatedRadioLabel: 'IC-9700 12010311',
      pcm: {
        input: { busy: true, ownerPid: TX5DR_PID },
        output: { busy: true, ownerPid: OTHER_PID },
      },
    });

    expect(findOwnedUsbAudioHardwareId('input', [splitOwners], TX5DR_PID)).toBe('usb:1-7.2.4');
    // Playback belongs to another process, so we must not claim it as ours.
    expect(findOwnedUsbAudioHardwareId('output', [splitOwners], TX5DR_PID)).toBeUndefined();

    const activeOutput = [
      { id: 'output-130', name: 'USB Audio CODEC (USB Audio)', isActiveByTx5dr: true },
    ];
    const outputEnriched = assignBusyIdentitiesToActiveDevices(activeOutput, 'output', [splitOwners], TX5DR_PID);
    expect(outputEnriched[0].hardwareId).toBeUndefined();

    const activeInput = [
      { id: 'input-130', name: 'USB Audio CODEC (USB Audio)', isActiveByTx5dr: true },
    ];
    const inputEnriched = assignBusyIdentitiesToActiveDevices(activeInput, 'input', [splitOwners], TX5DR_PID);
    expect(inputEnriched[0]).toMatchObject({ hardwareId: 'usb:1-7.2.4' });
  });

  it('resolves playback ownership when capture is closed', () => {
    const playbackOwned = makeIdentity({
      hardwareId: 'usb:1-7.2.4',
      alsaCard: 0,
      relatedRadioLabel: 'IC-9700 12010311',
      pcm: { input: { busy: false }, output: { busy: true, ownerPid: TX5DR_PID } },
    });

    expect(findOwnedUsbAudioHardwareId('output', [playbackOwned], TX5DR_PID)).toBe('usb:1-7.2.4');
    expect(findOwnedUsbAudioHardwareId('input', [playbackOwned], TX5DR_PID)).toBeUndefined();

    const activeOutput = [
      { id: 'output-130', name: 'USB Audio CODEC (USB Audio)', isActiveByTx5dr: true },
    ];
    const outputEnriched = assignBusyIdentitiesToActiveDevices(activeOutput, 'output', [playbackOwned], TX5DR_PID);
    expect(outputEnriched[0]).toMatchObject({ hardwareId: 'usb:1-7.2.4' });
  });

  it('does not let different per-direction owners impersonate each other across cards', () => {
    // Capture is owned by us on card A, playback is owned by us on card B.
    const captureCard = makeIdentity({
      hardwareId: 'usb:1-7.2.4',
      alsaCard: 0,
      relatedRadioLabel: 'IC-9700 12010311',
      pcm: {
        input: { busy: true, ownerPid: TX5DR_PID },
        output: { busy: true, ownerPid: OTHER_PID },
      },
    });
    const playbackCard = makeIdentity({
      hardwareId: 'usb:1-7.4.4',
      alsaCard: 2,
      relatedRadioLabel: 'IC-7610 11002034',
      pcm: {
        input: { busy: true, ownerPid: OTHER_PID },
        output: { busy: true, ownerPid: TX5DR_PID },
      },
    });
    const both = [captureCard, playbackCard];

    // Each direction resolves to its own card, never the peer.
    expect(findOwnedUsbAudioHardwareId('input', both, TX5DR_PID)).toBe('usb:1-7.2.4');
    expect(findOwnedUsbAudioHardwareId('output', both, TX5DR_PID)).toBe('usb:1-7.4.4');

    const activeInput = [
      { id: 'input-130', name: 'USB Audio CODEC (USB Audio)', isActiveByTx5dr: true },
    ];
    const inputEnriched = assignBusyIdentitiesToActiveDevices(activeInput, 'input', both, TX5DR_PID);
    expect(inputEnriched[0]).toMatchObject({ hardwareId: 'usb:1-7.2.4' });

    const activeOutput = [
      { id: 'output-130', name: 'USB Audio CODEC (USB Audio)', isActiveByTx5dr: true },
    ];
    const outputEnriched = assignBusyIdentitiesToActiveDevices(activeOutput, 'output', both, TX5DR_PID);
    expect(outputEnriched[0]).toMatchObject({ hardwareId: 'usb:1-7.4.4' });
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

    const enriched = assignBusyIdentitiesToActiveDevices(devices, 'input', identities, TX5DR_PID);
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
