import os from 'node:os';
import type { EventEmitter } from 'node:events';
import Bonjour from 'bonjour-service';
import type { PluginDistribution, RemoteAccessPreset } from '@tx5dr/contracts';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StationDiscovery');

/** DNS-SD service type announced by TX-5DR stations on the local network. */
export const STATION_DISCOVERY_SERVICE_TYPE = 'tx5dr';
export const STATION_DISCOVERY_TXT_VERSION = '1';

/**
 * Runtimes that announce themselves unless told not to. Docker's default
 * bridge network does not carry multicast, Android needs a native multicast
 * lock, and development servers would only add noise.
 */
const DEFAULT_ON: ReadonlySet<PluginDistribution> = new Set(['electron', 'linux-service', 'generic-server']);

/** How often the advertiser checks whether the machine's addresses changed. */
const NETWORK_CHECK_INTERVAL_MS = 30_000;

export interface StationAdvertisement {
  name: string;
  type: string;
  port: number;
  /**
   * Host name the address records are published under. A name of our own keeps
   * the machine's host name (often the owner's name) off the network and never
   * competes with the operating system's own mDNS responder for it.
   */
  host: string;
  /** Only what a client needs to reach and verify the station; no callsign, host name or paths. */
  txt: { v: string; id: string; proto: 'http' | 'https' };
}

export interface DiscoveryDecisionInput {
  env: NodeJS.ProcessEnv;
  distribution: PluginDistribution;
  preset: RemoteAccessPreset;
  instanceId: string;
}

function parseFlag(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return null;
}

function parsePort(value: string | undefined): number | null {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Decides what, if anything, the station announces. A station whose remote
 * access preset is `local` is only reachable from its own machine and never
 * announces itself. A `public` station is usually a server on the internet,
 * where there is no local network to announce to, so it announces only when
 * `TX5DR_DISCOVERY` asks for it. The announced port is the browser-facing Web
 * entrypoint, not the internal API port.
 */
export function resolveStationAdvertisement(input: DiscoveryDecisionInput): StationAdvertisement | null {
  if (input.preset === 'local') return null;
  const flag = parseFlag(input.env.TX5DR_DISCOVERY);
  const enabled = flag ?? (input.preset === 'lan' && DEFAULT_ON.has(input.distribution));
  if (!enabled) return null;

  const httpsPort = parsePort(input.env.TX5DR_DISCOVERY_HTTPS_PORT);
  const httpPort = parsePort(input.env.TX5DR_DISCOVERY_PORT)
    ?? parsePort(input.env.WEB_PORT)
    ?? parsePort(input.env.TX5DR_HTTP_PORT);
  const port = httpsPort ?? httpPort;
  if (!port) return null;

  return {
    name: `TX-5DR ${input.instanceId.slice(0, 6)}`,
    type: STATION_DISCOVERY_SERVICE_TYPE,
    port,
    host: `tx5dr-${input.instanceId.slice(0, 8).toLowerCase()}.local`,
    txt: { v: STATION_DISCOVERY_TXT_VERSION, id: input.instanceId, proto: httpsPort ? 'https' : 'http' },
  };
}

export interface PublishedService {
  stop(callback?: () => void): void;
}

export interface DiscoveryPublisher {
  publish(advertisement: StationAdvertisement): PublishedService;
  destroy(): Promise<void>;
}

/**
 * bonjour-service reports a failed send (an interface going away, or macOS
 * withholding local network access) to its error callback, and leaves the
 * socket's own errors, a failed bind of UDP 5353, unhandled, which would
 * surface as an uncaught exception. The first are logged and the announcement
 * carries on; the second go to `onSocketError`.
 */
export function createBonjourPublisher(
  onSocketError: (error: unknown) => void,
  /** Socket options; tests bind an unused port without multicast. */
  socketOptions?: { port?: number; multicast?: boolean; bind?: string },
): DiscoveryPublisher {
  let sendErrorLogged = false;
  const bonjour = new Bonjour(socketOptions as ConstructorParameters<typeof Bonjour>[0], (error: unknown) => {
    if (sendErrorLogged) {
      logger.debug('local network announcement could not be sent', { error: errorMessage(error) });
      return;
    }
    sendErrorLogged = true;
    logger.warn('local network announcement could not be sent', { error: errorMessage(error) });
  });
  const socket = (bonjour as unknown as { server?: { mdns?: EventEmitter } }).server?.mdns;
  socket?.on('error', onSocketError);
  return {
    publish: (advertisement) => {
      const service = bonjour.publish({ ...advertisement, protocol: 'tcp' });
      return { stop: (callback?: () => void) => service.stop(callback) };
    },
    destroy: () => new Promise<void>((resolve) => {
      bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
    }),
  };
}

export interface StationDiscoveryAdvertiserOptions {
  env?: NodeJS.ProcessEnv;
  getDistribution: () => Promise<PluginDistribution>;
  getPreset: () => RemoteAccessPreset;
  getInstanceId: () => Promise<string>;
  createPublisher?: (onSocketError: (error: unknown) => void) => DiscoveryPublisher;
  /** Summary of the machine's addresses; a change republishes the address records. */
  getNetworkFingerprint?: () => string;
  networkCheckIntervalMs?: number;
}

function defaultNetworkFingerprint(): string {
  const addresses: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal) addresses.push(entry.address);
    }
  }
  return addresses.sort().join(',');
}

/** Owns the station's DNS-SD announcement for the life of the server process. */
export class StationDiscoveryAdvertiser {
  private publisher: DiscoveryPublisher | null = null;
  private service: PublishedService | null = null;
  private current: StationAdvertisement | null = null;
  private network: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private networkTimer: NodeJS.Timeout | null = null;
  private failedPublisher: DiscoveryPublisher | null = null;

  constructor(private readonly options: StationDiscoveryAdvertiserOptions) {}

  /** Publishes, updates or withdraws the announcement to match current settings. */
  refresh(): Promise<void> {
    return this.enqueue(() => this.apply());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopNetworkWatch();
    await this.queue;
    await this.closePublisher();
  }

  get advertisement(): StationAdvertisement | null {
    return this.current;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error) => {
      logger.warn('failed to update local network announcement', { error: errorMessage(error) });
    });
    return this.queue;
  }

  private fingerprint(): string {
    return (this.options.getNetworkFingerprint ?? defaultNetworkFingerprint)();
  }

  private async apply(): Promise<void> {
    if (this.stopped) return;
    const next = resolveStationAdvertisement({
      env: this.options.env ?? process.env,
      distribution: await this.options.getDistribution(),
      preset: this.options.getPreset(),
      instanceId: await this.options.getInstanceId(),
    });
    if (!next) {
      if (this.publisher) logger.info('local network announcement is off');
      this.stopNetworkWatch();
      await this.closePublisher();
      return;
    }
    const network = this.fingerprint();
    if (JSON.stringify(next) === JSON.stringify(this.current) && network === this.network) return;
    await this.withdraw();
    this.publisher ??= (this.options.createPublisher ?? createBonjourPublisher)((error) => this.handleNetworkError(error));
    this.service = this.publisher.publish(next);
    this.current = next;
    this.network = network;
    this.startNetworkWatch();
    logger.info('announcing station on the local network', { port: next.port, proto: next.txt.proto });
  }

  /**
   * The mDNS socket failed, typically because UDP 5353 is unavailable. This
   * attempt ends and the socket is released; the next preset or address change
   * tries again.
   */
  private handleNetworkError(error: unknown): void {
    const publisher = this.publisher;
    // multicast-dns reports a failed bind more than once; the socket is closed once.
    if (!publisher || this.failedPublisher === publisher) return;
    this.failedPublisher = publisher;
    logger.warn('local network discovery is unavailable', { error: errorMessage(error) });
    void this.enqueue(async () => {
      if (this.publisher === publisher) await this.closePublisher();
    });
  }

  private startNetworkWatch(): void {
    if (this.networkTimer) return;
    this.networkTimer = setInterval(() => {
      if (this.fingerprint() !== this.network) void this.refresh();
    }, this.options.networkCheckIntervalMs ?? NETWORK_CHECK_INTERVAL_MS);
    this.networkTimer.unref?.();
  }

  private stopNetworkWatch(): void {
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.networkTimer = null;
  }

  /** Withdraws the announcement and releases the socket. */
  private async closePublisher(): Promise<void> {
    await this.withdraw();
    const publisher = this.publisher;
    this.publisher = null;
    if (publisher) await publisher.destroy();
  }

  private withdraw(): Promise<void> {
    const service = this.service;
    this.service = null;
    this.current = null;
    if (!service) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      service.stop(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
