import net from 'node:net';

/**
 * Discovery of TX-5DR stations announced on the local network (`_tx5dr._tcp`).
 *
 * Announcements carry only a version, the station instance ID and the protocol.
 * A candidate is listed only after the station at that address answered with the
 * same instance ID, so a stale or forged announcement cannot point the user at
 * another host under a station's name.
 */

export const STATION_SERVICE_TYPE = 'tx5dr';
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AnnouncedService {
  name: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
}

export interface StationCandidate {
  instanceId: string;
  url: string;
  serviceName: string;
}

function txtValue(txt: Record<string, unknown> | undefined, key: string): string | null {
  const value = txt?.[key];
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return null;
}

function isUsableIpv4(address: string): boolean {
  return net.isIPv4(address) && !address.startsWith('169.254.') && !address.startsWith('127.') && address !== '0.0.0.0';
}

function isUsableIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return net.isIPv6(address) && !lower.startsWith('fe80:') && lower !== '::1';
}

/** Turns an announcement into a connectable candidate, or null when it is not usable. */
export function toStationCandidate(service: AnnouncedService): StationCandidate | null {
  if (txtValue(service.txt, 'v') !== '1') return null;
  const instanceId = txtValue(service.txt, 'id');
  const proto = txtValue(service.txt, 'proto');
  if (!instanceId || !INSTANCE_ID_PATTERN.test(instanceId)) return null;
  if (proto !== 'http' && proto !== 'https') return null;
  if (!Number.isInteger(service.port) || service.port <= 0 || service.port > 65535) return null;

  const addresses = service.addresses ?? [];
  const ipv4 = addresses.find(isUsableIpv4);
  const ipv6 = ipv4 ? undefined : addresses.find(isUsableIpv6);
  const host = ipv4 ?? (ipv6 ? `[${ipv6}]` : null);
  if (!host) return null;
  return { instanceId: instanceId.toLowerCase(), url: `${proto}://${host}:${service.port}`, serviceName: service.name };
}

export interface DiscoveredStation {
  instanceId: string;
  url: string;
  label: string;
  hostVersion: string | null;
}

export type CandidateDescription = { label: string; hostVersion: string | null } | null;

export interface ServiceBrowser {
  stop(): void;
}

export interface StationDiscoveryOptions {
  /** Starts browsing and reports announcements coming up and going away. */
  browse: (onUp: (service: AnnouncedService) => void, onDown: (service: AnnouncedService) => void) => ServiceBrowser;
  /** Verifies a candidate and names it; null drops it. */
  describe: (candidate: StationCandidate) => Promise<CandidateDescription>;
  onChange: () => void;
}

export class StationDiscovery {
  private browser: ServiceBrowser | null = null;
  private readonly stations = new Map<string, DiscoveredStation>();
  private readonly pending = new Map<string, string>();

  constructor(private readonly options: StationDiscoveryOptions) {}

  get running(): boolean {
    return this.browser !== null;
  }

  start(): void {
    if (this.browser) return;
    this.browser = this.options.browse(
      service => this.handleUp(service),
      service => this.handleDown(service),
    );
  }

  stop(): void {
    this.browser?.stop();
    this.browser = null;
    this.pending.clear();
    if (this.stations.size > 0) {
      this.stations.clear();
      this.options.onChange();
    }
  }

  list(): DiscoveredStation[] {
    return [...this.stations.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  private handleUp(service: AnnouncedService): void {
    const candidate = toStationCandidate(service);
    if (!candidate) return;
    const known = this.stations.get(candidate.instanceId);
    if (known?.url === candidate.url || this.pending.get(candidate.instanceId) === candidate.url) return;
    this.pending.set(candidate.instanceId, candidate.url);
    void this.options.describe(candidate).then((description) => {
      if (!this.browser || this.pending.get(candidate.instanceId) !== candidate.url) return;
      this.pending.delete(candidate.instanceId);
      if (!description) {
        if (this.stations.delete(candidate.instanceId)) this.options.onChange();
        return;
      }
      this.stations.set(candidate.instanceId, {
        instanceId: candidate.instanceId,
        url: candidate.url,
        label: description.label,
        hostVersion: description.hostVersion,
      });
      this.options.onChange();
    }).catch(() => {
      this.pending.delete(candidate.instanceId);
    });
  }

  private handleDown(service: AnnouncedService): void {
    const candidate = toStationCandidate(service);
    if (!candidate) return;
    this.pending.delete(candidate.instanceId);
    if (this.stations.delete(candidate.instanceId)) this.options.onChange();
  }
}
