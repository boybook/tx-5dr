import fs from 'node:fs';
import path from 'node:path';
import type { AudioDevice } from '@tx5dr/contracts';

export type AudioDirection = 'input' | 'output';

export interface LinuxPcmEndpointState {
  device: number;
  direction: AudioDirection;
  busy: boolean;
  ownerPid?: number;
}

export interface LinuxUsbAudioIdentity {
  alsaCard: number;
  alsaCardId: string;
  productName: string;
  usbPath: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  relatedRadioLabel?: string;
  relatedSerials: string[];
  detail: string;
  endpoints: LinuxPcmEndpointState[];
}

export type RtAudioObservedDevice = AudioDevice & {
  nativeId?: string;
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
  return walkParents(startPath).find((candidate) => (
    readText(path.join(candidate, 'idVendor'))
    && readText(path.join(candidate, 'idProduct'))
  )) ?? null;
}

export function deriveRadioLabelFromSerial(serial: string): string | null {
  const normalized = serial.trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
  if (!normalized) return null;

  const portSuffix = normalized.match(/^(IC-\d+(?:\s+\S+)+)\s+[A-Z]$/i);
  if (portSuffix) return portSuffix[1].trim();

  const icom = normalized.match(/\b(IC-\d+(?:\s+\d+)?)\b/i);
  if (!icom) return normalized;
  return normalized.slice(icom.index).replace(/\s+[AB]$/i, '').trim() || icom[1];
}

export function deriveUniqueRadioLabelFromSerials(serials: string[]): string | undefined {
  const labels = Array.from(new Set(serials
    .map(deriveRadioLabelFromSerial)
    .filter((label): label is string => Boolean(label))));
  return labels.length === 1 ? labels[0] : undefined;
}

function collectSiblingRadioSerials(usbDeviceDir: string): string[] {
  let entries: fs.Dirent[];
  const parentDir = path.dirname(usbDeviceDir);
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const serials = entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const siblingDir = path.join(parentDir, entry.name);
    const vendorId = readText(path.join(siblingDir, 'idVendor'))?.toLowerCase();
    const serial = readText(path.join(siblingDir, 'serial'));
    return serial && (vendorId === SILABS_VENDOR_ID || /IC-\d+/i.test(serial)) ? [serial] : [];
  });
  return Array.from(new Set(serials)).sort((left, right) => left.localeCompare(right));
}

export function buildUsbAudioDetail(identity: {
  relatedRadioLabel?: string;
  productName?: string;
  vendorId?: string;
  productId?: string;
  usbPath?: string;
  serialNumber?: string;
}): string {
  const parts: string[] = [];
  if (identity.relatedRadioLabel) parts.push(identity.relatedRadioLabel);
  else if (identity.serialNumber) parts.push(`SN ${identity.serialNumber}`);
  if (identity.vendorId && identity.productId) parts.push(`VID:PID ${identity.vendorId}:${identity.productId}`);
  if (identity.usbPath) parts.push(`USB ${identity.usbPath}`);
  if (parts.length === 0 && identity.productName) parts.push(identity.productName);
  return parts.join(' · ');
}

function readPcmEndpointState(
  cardIndex: number,
  device: number,
  direction: AudioDirection,
): LinuxPcmEndpointState {
  const suffix = direction === 'input' ? 'c' : 'p';
  const pcmDir = `/proc/asound/card${cardIndex}/pcm${device}${suffix}`;
  let subdevices: fs.Dirent[];
  try {
    subdevices = fs.readdirSync(pcmDir, { withFileTypes: true });
  } catch {
    return { device, direction, busy: false };
  }

  for (const subdevice of subdevices) {
    if (!subdevice.isDirectory() || !/^sub\d+$/.test(subdevice.name)) continue;
    const status = readText(path.join(pcmDir, subdevice.name, 'status'));
    if (!status || /^closed$/i.test(status.split('\n')[0]?.trim() ?? '')) continue;
    const owner = status.match(/owner_pid\s*:\s*(\d+)/i);
    return {
      device,
      direction,
      busy: true,
      ...(owner ? { ownerPid: Number.parseInt(owner[1], 10) } : {}),
    };
  }
  return { device, direction, busy: false };
}

function discoverPcmEndpoints(cardIndex: number): LinuxPcmEndpointState[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(`/proc/asound/card${cardIndex}`, { withFileTypes: true });
  } catch {
    return [];
  }

  const endpoints: LinuxPcmEndpointState[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^pcm(\d+)([cp])$/);
    if (!match) continue;
    const direction: AudioDirection = match[2] === 'c' ? 'input' : 'output';
    endpoints.push(readPcmEndpointState(cardIndex, Number.parseInt(match[1], 10), direction));
  }
  return endpoints.sort((left, right) => left.device - right.device || left.direction.localeCompare(right.direction));
}

function parseProcAsoundCards(): Array<{ index: number; id: string; name: string }> {
  const content = readText('/proc/asound/cards');
  if (!content) return [];
  const lines = content.split('\n');
  const cards: Array<{ index: number; id: string; name: string }> = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+\[([^\]]+)\]:\s+\S+\s+-\s+(.+)$/);
    if (!match) continue;
    cards.push({
      index: Number.parseInt(match[1], 10),
      id: match[2].trim(),
      name: match[3].trim(),
    });
  }
  return cards;
}

export function discoverLinuxUsbAudioIdentities(): LinuxUsbAudioIdentity[] {
  if (process.platform !== 'linux') return [];

  const identities: LinuxUsbAudioIdentity[] = [];
  for (const card of parseProcAsoundCards()) {
    let devicePath: string;
    try {
      devicePath = fs.realpathSync(`/sys/class/sound/card${card.index}/device`);
    } catch {
      continue;
    }
    const usbDeviceDir = findUsbDeviceDir(devicePath);
    if (!usbDeviceDir) continue;

    const relatedSerials = collectSiblingRadioSerials(usbDeviceDir);
    const relatedRadioLabel = deriveUniqueRadioLabelFromSerials(relatedSerials);
    const identity = {
      alsaCard: card.index,
      alsaCardId: card.id,
      productName: readText(path.join(usbDeviceDir, 'product')) || card.name,
      usbPath: path.basename(usbDeviceDir),
      vendorId: readText(path.join(usbDeviceDir, 'idVendor'))?.toLowerCase() || undefined,
      productId: readText(path.join(usbDeviceDir, 'idProduct'))?.toLowerCase() || undefined,
      serialNumber: readText(path.join(usbDeviceDir, 'serial')) || undefined,
      relatedRadioLabel,
      relatedSerials,
      endpoints: discoverPcmEndpoints(card.index),
    };
    identities.push({
      ...identity,
      detail: buildUsbAudioDetail(identity),
    });
  }
  return identities.sort((left, right) => left.alsaCard - right.alsaCard);
}

export function parseAlsaNativeLocator(nativeId: string | undefined): {
  cardId: string;
  device: number;
} | null {
  if (!nativeId) return null;
  const match = nativeId.match(/^hw:([^,]+),(\d+)$/);
  if (!match) return null;
  return { cardId: match[1], device: Number.parseInt(match[2], 10) };
}

function stablePhysicalSegment(identity: LinuxUsbAudioIdentity): string {
  const value = identity.relatedRadioLabel
    ? `radio:${identity.relatedRadioLabel}`
    : identity.serialNumber
      ? `serial:${identity.vendorId ?? 'unknown'}:${identity.productId ?? 'unknown'}:${identity.serialNumber}`
      : `port:${identity.vendorId ?? 'unknown'}:${identity.productId ?? 'unknown'}:${identity.usbPath}`;
  return encodeURIComponent(value.toLowerCase().replace(/\s+/g, '-'));
}

export function buildAlsaRouteKey(
  identity: LinuxUsbAudioIdentity,
  device: number,
  direction: AudioDirection,
): string {
  return `rtaudio:alsa:${stablePhysicalSegment(identity)}:pcm${device}:${direction}`;
}

function identityFields(identity: LinuxUsbAudioIdentity): Pick<AudioDevice,
  'detail' | 'vendorId' | 'productId' | 'serialNumber' | 'usbPath' | 'alsaCard' | 'alsaCardId'
> {
  return {
    detail: identity.detail,
    ...(identity.vendorId ? { vendorId: identity.vendorId } : {}),
    ...(identity.productId ? { productId: identity.productId } : {}),
    ...(identity.relatedRadioLabel || identity.serialNumber
      ? { serialNumber: identity.relatedRadioLabel ?? identity.serialNumber }
      : {}),
    usbPath: identity.usbPath,
    alsaCard: identity.alsaCard,
    alsaCardId: identity.alsaCardId,
  };
}

export function enrichAlsaAudioDevices(
  devices: RtAudioObservedDevice[],
  direction: AudioDirection,
  identities: LinuxUsbAudioIdentity[] = discoverLinuxUsbAudioIdentities(),
): RtAudioObservedDevice[] {
  return devices.map((device) => {
    const locator = parseAlsaNativeLocator(device.nativeId);
    if (!locator) return { ...device };
    const identity = identities.find((candidate) => candidate.alsaCardId === locator.cardId);
    if (!identity) return { ...device };
    return {
      ...device,
      backend: 'rtaudio',
      kind: 'usb',
      transport: 'usb',
      connector: 'usb',
      routeKey: buildAlsaRouteKey(identity, locator.device, direction),
      ...identityFields(identity),
    };
  });
}

export function enrichPulseAudioDevices(
  devices: RtAudioObservedDevice[],
  direction: AudioDirection,
): RtAudioObservedDevice[] {
  return devices.map((device) => {
    if (!device.nativeId) return { ...device };
    return {
      ...device,
      backend: 'rtaudio',
      routeKey: `rtaudio:pulse:${encodeURIComponent(device.nativeId)}:${direction}`,
      detail: `PulseAudio node ${device.nativeId}`,
    };
  });
}

export function buildUnavailableAlsaEndpoints(
  direction: AudioDirection,
  existingRouteKeys: Set<string>,
  identities: LinuxUsbAudioIdentity[] = discoverLinuxUsbAudioIdentities(),
  ownerPid = process.pid,
): AudioDevice[] {
  return identities.flatMap((identity) => identity.endpoints
    .filter((endpoint) => endpoint.direction === direction && endpoint.busy)
    .flatMap((endpoint) => {
      const routeKey = buildAlsaRouteKey(identity, endpoint.device, direction);
      if (existingRouteKeys.has(routeKey)) return [];
      const owned = endpoint.ownerPid === ownerPid;
      return [{
        id: `${direction}-unavailable-${routeKey}`,
        name: identity.productName,
        isDefault: false,
        channels: 0,
        sampleRate: 0,
        type: direction,
        backend: 'rtaudio' as const,
        kind: 'usb' as const,
        transport: 'usb' as const,
        connector: 'usb' as const,
        routeKey,
        availability: owned ? 'active' as const : 'cached' as const,
        isActiveByTx5dr: owned,
        routeState: owned ? 'verified' as const : 'unavailable' as const,
        ...(!owned ? { failureReason: 'Audio endpoint is currently in use by another process' } : {}),
        ...identityFields(identity),
      }];
    }));
}
