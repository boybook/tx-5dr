import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('LinuxUsbAudioIdentity');

export type PcmDirection = 'input' | 'output';

/** Per-direction ALSA PCM open state for a single USB sound card. */
export type PcmDirectionStatus = {
  busy: boolean;
  /** PID holding the PCM substream when busy, if known. */
  ownerPid?: number;
};

export type LinuxUsbAudioIdentity = {
  /** Stable key, e.g. usb:1-7.2.4 */
  hardwareId: string;
  alsaCard: number;
  alsaCardId?: string;
  /** ALSA card name, usually "USB Audio CODEC" */
  productName: string;
  usbPath: string;
  vendorId?: string;
  productId?: string;
  /** Own USB iSerial when present (often empty for Icom PCM codecs). */
  serialNumber?: string;
  /**
   * Best radio-facing label derived from sibling CP210 serials under the same hub,
   * e.g. "IC-9700 12010311".
   */
  relatedRadioLabel?: string;
  /** Raw sibling serial strings (A/B ports). */
  relatedSerials: string[];
  /** One-line detail for UI, similar to serial-port metadata. */
  detail: string;
  /**
   * ALSA capture/playback PCM state modeled per direction. Capture (pcm0c) and
   * playback (pcm0p) open independently, so one direction being busy must not
   * mark the other unavailable or let one owner impersonate the other.
   */
  pcm: {
    input: PcmDirectionStatus;
    output: PcmDirectionStatus;
  };
};

/** Read the per-direction PCM busy/owner state for an identity. */
export function getPcmDirectionStatus(
  identity: LinuxUsbAudioIdentity,
  direction: PcmDirection,
): PcmDirectionStatus {
  return identity.pcm[direction];
}

/** Whether the identity's PCM is open in the given direction. */
export function isPcmBusyForDirection(
  identity: LinuxUsbAudioIdentity,
  direction: PcmDirection,
): boolean {
  return identity.pcm[direction].busy;
}

export type AudioDeviceIdentityFields = {
  hardwareId?: string;
  detail?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  usbPath?: string;
  alsaCard?: number;
  alsaCardId?: string;
};

const SILABS_VENDOR_ID = '10c4';

function readText(filePath: string): string | null {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function walkParents(startPath: string): string[] {
  const parents: string[] = [];
  let current = startPath;
  while (current && current !== '/') {
    parents.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return parents;
}

function findUsbDeviceDir(startPath: string): string | null {
  for (const candidate of walkParents(startPath)) {
    if (readText(path.join(candidate, 'idVendor')) && readText(path.join(candidate, 'idProduct'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * Collapse "IC-9700 12010311 A" / "IC-7610_11002034_B" into a radio-level label.
 */
export function deriveRadioLabelFromSerial(serial: string): string | null {
  const normalized = serial.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (!normalized) return null;

  const withPortSuffix = normalized.match(/^(IC-\d+(?:\s+\S+)+)\s+[A-Z]$/i);
  if (withPortSuffix) {
    return withPortSuffix[1].trim();
  }

  const icomMatch = normalized.match(/\b(IC-\d+(?:\s+\d+)?)\b/i);
  if (icomMatch) {
    const rest = normalized.slice(icomMatch.index!).trim();
    const simplified = rest.replace(/\s+[AB]$/i, '').trim();
    return simplified || icomMatch[1];
  }

  return normalized;
}

export function buildUsbAudioDetail(identity: {
  relatedRadioLabel?: string;
  productName?: string;
  vendorId?: string;
  productId?: string;
  usbPath?: string;
  relatedSerials?: string[];
}): string {
  const parts: string[] = [];
  if (identity.relatedRadioLabel) {
    parts.push(identity.relatedRadioLabel);
  }
  if (identity.vendorId && identity.productId) {
    parts.push(`VID:PID ${identity.vendorId}:${identity.productId}`);
  }
  if (identity.usbPath) {
    parts.push(`USB ${identity.usbPath}`);
  }
  if (!identity.relatedRadioLabel && identity.relatedSerials?.[0]) {
    parts.push(`SN ${identity.relatedSerials[0]}`);
  }
  if (parts.length === 0 && identity.productName) {
    parts.push(identity.productName);
  }
  return parts.join(' · ');
}

function collectSiblingRadioSerials(usbDeviceDir: string): string[] {
  const parentDir = path.dirname(usbDeviceDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const serials: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const siblingDir = path.join(parentDir, entry.name);
    const vendorId = readText(path.join(siblingDir, 'idVendor'))?.toLowerCase();
    const serial = readText(path.join(siblingDir, 'serial'));
    if (!serial) continue;
    if (vendorId === SILABS_VENDOR_ID || /IC-\d+/i.test(serial)) {
      serials.push(serial);
    }
  }

  return Array.from(new Set(serials)).sort((a, b) => a.localeCompare(b));
}

/** Read the capture (pcm0c) or playback (pcm0p) PCM status for a single card.
 * Simplification: only pcm0{c,p}/sub0 is inspected. Multi-PCM or higher
 * substream occupancy is not reported as busy.
 */
function readPcmDirectionStatus(cardIndex: number, direction: PcmDirection): PcmDirectionStatus {
  const stream = direction === 'input' ? 'pcm0c' : 'pcm0p';
  const statusPath = `/proc/asound/card${cardIndex}/${stream}/sub0/status`;
  const status = readText(statusPath);
  if (!status) return { busy: false };
  const firstLine = status.split('\n')[0]?.trim() || '';
  if (/^closed$/i.test(firstLine)) return { busy: false };
  const ownerMatch = status.match(/owner_pid\s*:\s*(\d+)/i);
  return {
    busy: true,
    ownerPid: ownerMatch ? Number.parseInt(ownerMatch[1], 10) : undefined,
  };
}

/**
 * After opening an RtAudio stream, map the ALSA card actually owned by this
 * process (in the given direction) back to the USB/radio hardwareId (sibling
 * Silabs serial on the hub). Capture and playback owners are tracked separately,
 * so an input open never resolves via a playback owner and vice versa.
 */
export function findOwnedUsbAudioHardwareId(
  direction: PcmDirection,
  identities: LinuxUsbAudioIdentity[] = discoverLinuxUsbAudioIdentities(),
  ownerPid: number = process.pid,
): string | undefined {
  for (const identity of identities) {
    const status = identity.pcm[direction];
    if (status.busy && status.ownerPid === ownerPid) {
      return identity.hardwareId;
    }
  }
  return undefined;
}

function parseProcAsoundCards(): Array<{ index: number; id: string; name: string; longName: string }> {
  const content = readText('/proc/asound/cards');
  if (!content) return [];

  const cards: Array<{ index: number; id: string; name: string; longName: string }> = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(/^\s*(\d+)\s+\[([^\]]+)\]:\s+\S+\s+-\s+(.+)$/);
    if (!header) continue;
    const longName = (lines[i + 1] || '').trim();
    cards.push({
      index: Number.parseInt(header[1], 10),
      id: header[2].trim(),
      name: header[3].trim(),
      longName,
    });
  }
  return cards;
}

/**
 * Discover USB sound cards on Linux and correlate them with sibling UART/radio serials.
 * Returns an empty list on non-Linux hosts or when sysfs is unavailable.
 */
export function discoverLinuxUsbAudioIdentities(): LinuxUsbAudioIdentity[] {
  if (process.platform !== 'linux') {
    return [];
  }

  const cards = parseProcAsoundCards();
  const identities: LinuxUsbAudioIdentity[] = [];

  for (const card of cards) {
    const cardSysfs = `/sys/class/sound/card${card.index}`;
    let devicePath: string;
    try {
      devicePath = fs.realpathSync(path.join(cardSysfs, 'device'));
    } catch {
      continue;
    }

    const usbDeviceDir = findUsbDeviceDir(devicePath);
    if (!usbDeviceDir) {
      continue;
    }

    const vendorId = readText(path.join(usbDeviceDir, 'idVendor'))?.toLowerCase() || undefined;
    const productId = readText(path.join(usbDeviceDir, 'idProduct'))?.toLowerCase() || undefined;
    const productName = readText(path.join(usbDeviceDir, 'product')) || card.name;
    const ownSerial = readText(path.join(usbDeviceDir, 'serial')) || undefined;
    const usbPath = path.basename(usbDeviceDir);
    const relatedSerials = collectSiblingRadioSerials(usbDeviceDir);
    const relatedRadioLabel = relatedSerials
      .map((serial) => deriveRadioLabelFromSerial(serial))
      .find((label): label is string => Boolean(label));
    const pcm = {
      input: readPcmDirectionStatus(card.index, 'input'),
      output: readPcmDirectionStatus(card.index, 'output'),
    };

    const identity: LinuxUsbAudioIdentity = {
      hardwareId: `usb:${usbPath}`,
      alsaCard: card.index,
      alsaCardId: card.id,
      productName,
      usbPath,
      vendorId,
      productId,
      serialNumber: ownSerial || relatedRadioLabel,
      relatedRadioLabel,
      relatedSerials,
      detail: buildUsbAudioDetail({
        relatedRadioLabel,
        productName,
        vendorId,
        productId,
        usbPath,
        relatedSerials,
      }),
      pcm,
    };

    identities.push(identity);
  }

  identities.sort((left, right) => left.alsaCard - right.alsaCard);
  if (identities.length > 0) {
    logger.debug('Discovered USB audio identities', {
      count: identities.length,
      labels: identities.map((item) => ({
        card: item.alsaCard,
        hardwareId: item.hardwareId,
        relatedRadioLabel: item.relatedRadioLabel,
        inputBusy: item.pcm.input.busy,
        inputOwnerPid: item.pcm.input.ownerPid,
        outputBusy: item.pcm.output.busy,
        outputOwnerPid: item.pcm.output.ownerPid,
      })),
    });
  }
  return identities;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function looksLikeUsbAudioDeviceName(name: string): boolean {
  const normalized = normalizeName(name);
  return (
    normalized.includes('usb audio')
    || normalized.includes('usb audio codec')
    || normalized.includes('pcm290')
    || normalized.includes('burr brown')
    || normalized.includes('burrbrown')
  );
}

/** Drop USB/radio identity fields that must not stick to non-USB RtAudio devices. */
export function stripUsbIdentityFields<T extends AudioDeviceIdentityFields>(device: T): T {
  if (!device.hardwareId?.startsWith('usb:') && !device.usbPath && !device.alsaCardId) {
    return device;
  }
  if (looksLikeUsbAudioDeviceName((device as { name?: string }).name ?? '')) {
    return device;
  }
  const {
    hardwareId: _hardwareId,
    detail: _detail,
    vendorId: _vendorId,
    productId: _productId,
    serialNumber: _serialNumber,
    usbPath: _usbPath,
    alsaCard: _alsaCard,
    alsaCardId: _alsaCardId,
    ...rest
  } = device;
  return rest as T;
}

function namesLikelyMatch(deviceName: string, identity: LinuxUsbAudioIdentity): boolean {
  const deviceNorm = normalizeName(deviceName);
  const productNorm = normalizeName(identity.productName);
  if (!deviceNorm || !productNorm) return false;
  if (deviceNorm.includes(productNorm) || productNorm.includes(deviceNorm.split(' ')[0] || '')) {
    return true;
  }
  return looksLikeUsbAudioDeviceName(deviceName) && looksLikeUsbAudioDeviceName(identity.productName);
}

export function identityToFields(identity: LinuxUsbAudioIdentity): AudioDeviceIdentityFields {
  return {
    hardwareId: identity.hardwareId,
    detail: identity.detail,
    vendorId: identity.vendorId,
    productId: identity.productId,
    serialNumber: identity.serialNumber ?? identity.relatedRadioLabel,
    usbPath: identity.usbPath,
    alsaCard: identity.alsaCard,
    alsaCardId: identity.alsaCardId,
  };
}

/**
 * Attach Linux USB/radio identity metadata onto enumerated RtAudio devices.
 *
 * Directional tradeoff (not a restoration of owned-first claiming): only cards
 * FREE in this direction are claimed onto live RtAudio entries. Busy cards that
 * this process already opened must NOT be FIFO-matched onto the remaining
 * enumerated USB devices — RtAudio listing order is unrelated to which card we
 * opened, and attaching "owned" identities first mislabels the free peer
 * (e.g. labels the IC-9700 device as IC-7610). Busy is evaluated per direction
 * so a capture-only open never hides the free playback side and vice versa.
 *
 * Matching remains heuristic (enumeration order ≈ alsaCard ascending); crossed
 * order can still mis-attach when only free cards remain. Busy radios are rebound
 * via {@link assignBusyIdentitiesToActiveDevices},
 * {@link findOwnedUsbAudioHardwareId}, or verified registry/hardwareId fallbacks
 * when opening the opposite stream direction.
 */
export function attachLinuxUsbAudioIdentities<T extends { name: string; hardwareId?: string }>(
  devices: T[],
  direction: PcmDirection,
  identities: LinuxUsbAudioIdentity[] = discoverLinuxUsbAudioIdentities(),
): Array<T & AudioDeviceIdentityFields> {
  if (identities.length === 0 || devices.length === 0) {
    return devices.map((device) => ({ ...device }));
  }

  const usedHardwareIds = new Set<string>(
    devices.map((device) => device.hardwareId).filter((id): id is string => Boolean(id)),
  );

  const free = identities.filter((identity) => !identity.pcm[direction].busy);

  return devices.map((device) => {
    if (device.hardwareId) {
      const known = identities.find((identity) => identity.hardwareId === device.hardwareId);
      return known ? { ...device, ...identityToFields(known) } : { ...device };
    }
    if (!looksLikeUsbAudioDeviceName(device.name)) {
      return { ...device };
    }
    const match = free.find((identity) => {
      if (usedHardwareIds.has(identity.hardwareId)) return false;
      return namesLikelyMatch(device.name, identity);
    });
    if (!match) {
      return { ...device };
    }
    usedHardwareIds.add(match.hardwareId);
    return { ...device, ...identityToFields(match) };
  });
}

/**
 * Prefer identities occupied by this process (in the given direction) for
 * already-active TX5DR streams that lost their hardwareId (RtAudio stops listing
 * busy cards). Ownership is matched per direction so a playback stream is never
 * relabeled from a capture owner (or another PID) and vice versa.
 */
export function assignBusyIdentitiesToActiveDevices<T extends {
  name: string;
  hardwareId?: string;
  isActiveByTx5dr?: boolean;
}>(
  devices: T[],
  direction: PcmDirection,
  identities: LinuxUsbAudioIdentity[],
  ownerPid: number = process.pid,
): Array<T & AudioDeviceIdentityFields> {
  const cleanedDevices = devices.map((device) => stripUsbIdentityFields(device));
  const usedHardwareIds = new Set(
    cleanedDevices.map((device) => device.hardwareId).filter((id): id is string => Boolean(id)),
  );
  const ownedBusy = identities.filter((identity) => {
    const status = identity.pcm[direction];
    return status.busy && status.ownerPid === ownerPid && !usedHardwareIds.has(identity.hardwareId);
  });

  return cleanedDevices.map((device) => {
    if (!looksLikeUsbAudioDeviceName(device.name)) {
      return { ...device };
    }
    if (device.hardwareId) {
      const known = identities.find((identity) => identity.hardwareId === device.hardwareId);
      return known ? { ...device, ...identityToFields(known) } : { ...device };
    }
    if (!device.isActiveByTx5dr || ownedBusy.length === 0) {
      return { ...device };
    }

    const match = ownedBusy.shift();
    if (!match) return { ...device };
    usedHardwareIds.add(match.hardwareId);
    return {
      ...device,
      ...identityToFields(match),
    };
  });
}

/**
 * Build placeholder devices for USB sound cards missing from RtAudio enumeration
 * (typically busy cards). Keys are stable hardwareId-based ids.
 */
export function buildSupplementalUsbAudioDevices(
  direction: 'input' | 'output',
  existingHardwareIds: Set<string>,
  identities: LinuxUsbAudioIdentity[] = discoverLinuxUsbAudioIdentities(),
): Array<{
  id: string;
  name: string;
  isDefault: false;
  channels: number;
  sampleRate: number;
  sampleRates: number[];
  type: 'input' | 'output';
  availability: 'available' | 'cached';
  isActiveByTx5dr: false;
} & AudioDeviceIdentityFields> {
  return identities
    .filter((identity) => !existingHardwareIds.has(identity.hardwareId))
    .map((identity) => ({
      id: `${direction}-${identity.hardwareId}`,
      name: identity.productName.includes('(')
        ? identity.productName
        : `${identity.productName} (USB Audio)`,
      isDefault: false as const,
      channels: 2,
      sampleRate: 48000,
      sampleRates: [44100, 48000],
      type: direction,
      availability: identity.pcm[direction].busy ? 'cached' as const : 'available' as const,
      isActiveByTx5dr: false as const,
      ...identityToFields(identity),
    }));
}

/**
 * Collapse devices that share a hardwareId, preferring active then available then cached.
 */
export function dedupeAudioDevicesByHardwareId<T extends {
  id: string;
  hardwareId?: string;
  availability?: string;
  isActiveByTx5dr?: boolean;
}>(devices: T[]): T[] {
  const result: T[] = [];
  const indexByHardwareId = new Map<string, number>();

  const rank = (device: T): number => {
    if (device.isActiveByTx5dr || device.availability === 'active') return 3;
    if (device.availability === 'available') return 2;
    if (device.availability === 'cached') return 1;
    return 0;
  };

  for (const device of devices) {
    if (!device.hardwareId) {
      result.push(device);
      continue;
    }
    const existingIndex = indexByHardwareId.get(device.hardwareId);
    if (existingIndex === undefined) {
      indexByHardwareId.set(device.hardwareId, result.length);
      result.push(device);
      continue;
    }
    if (rank(device) > rank(result[existingIndex])) {
      result[existingIndex] = device;
    }
  }

  return result;
}
