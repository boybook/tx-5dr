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

export interface StationAdvertisement {
  name: string;
  type: string;
  port: number;
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
 * announces itself. The announced port is the browser-facing Web entrypoint,
 * not the internal API port.
 */
export function resolveStationAdvertisement(input: DiscoveryDecisionInput): StationAdvertisement | null {
  const flag = parseFlag(input.env.TX5DR_DISCOVERY);
  const enabled = flag ?? DEFAULT_ON.has(input.distribution);
  if (!enabled || input.preset === 'local') return null;

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

export function createBonjourPublisher(): DiscoveryPublisher {
  const bonjour = new Bonjour(undefined, (error: unknown) => {
    logger.warn('local network discovery error', { error: error instanceof Error ? error.message : String(error) });
  });
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
  createPublisher?: () => DiscoveryPublisher;
}

/** Owns the station's DNS-SD announcement for the life of the server process. */
export class StationDiscoveryAdvertiser {
  private publisher: DiscoveryPublisher | null = null;
  private service: PublishedService | null = null;
  private current: StationAdvertisement | null = null;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly options: StationDiscoveryAdvertiserOptions) {}

  /** Publishes, updates or withdraws the announcement to match current settings. */
  refresh(): Promise<void> {
    this.queue = this.queue.then(() => this.apply()).catch((error) => {
      logger.warn('failed to update local network announcement', { error: error instanceof Error ? error.message : String(error) });
    });
    return this.queue;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.queue;
    await this.withdraw();
    const publisher = this.publisher;
    this.publisher = null;
    if (publisher) await publisher.destroy();
  }

  get advertisement(): StationAdvertisement | null {
    return this.current;
  }

  private async apply(): Promise<void> {
    if (this.stopped) return;
    const next = resolveStationAdvertisement({
      env: this.options.env ?? process.env,
      distribution: await this.options.getDistribution(),
      preset: this.options.getPreset(),
      instanceId: await this.options.getInstanceId(),
    });
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    await this.withdraw();
    if (!next) {
      logger.info('local network announcement is off');
      return;
    }
    this.publisher ??= (this.options.createPublisher ?? createBonjourPublisher)();
    this.service = this.publisher.publish(next);
    this.current = next;
    logger.info('announcing station on the local network', { port: next.port, proto: next.txt.proto });
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
