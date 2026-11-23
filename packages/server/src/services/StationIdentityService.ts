import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  DESKTOP_BRIDGE_VERSION,
  STATION_IDENTITY_VERSION,
  StationIdentitySchema,
  type AuthStatus,
  type PluginDistribution,
  type StationIdentity,
} from '@tx5dr/contracts';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';
import { AuthManager } from '../auth/AuthManager.js';
import { resolvePluginDistribution } from '../plugin/runtime-info.js';
import { tx5drPaths } from '../utils/app-paths.js';
import { createLogger } from '../utils/logger.js';
import {
  JsonRecoveryError,
  SafeFileWriter,
  loadJsonWithRecovery,
  readOptionalFile,
} from '../utils/persistence/index.js';

const logger = createLogger('StationIdentityService');

export const STATION_INSTANCE_FILE_NAME = 'station-instance.json';

const StationInstanceFileSchema = z.object({
  instanceId: z.string().uuid(),
});

export interface StationIdentityServiceOptions {
  /** Directory that owns `station-instance.json` (the station config directory). */
  getConfigDir: () => Promise<string>;
  getAuthStatus: () => AuthStatus;
  getDistribution: () => Promise<PluginDistribution>;
  buildInfo?: Pick<typeof SERVER_BUILD_INFO, 'version' | 'commit' | 'channel'>;
  generateId?: () => string;
  writer?: SafeFileWriter;
}

/**
 * Owns the public station identity (`GET /api/station/identity`).
 *
 * The instance ID is a random UUID kept in its own file. It is independent of
 * telemetry identifiers so that LAN discovery and desktop shells never learn a
 * value that links to diagnostic uploads.
 */
export class StationIdentityService {
  private instanceIdPromise: Promise<string> | null = null;
  private readonly writer: SafeFileWriter;
  private readonly buildInfo: Pick<typeof SERVER_BUILD_INFO, 'version' | 'commit' | 'channel'>;
  private readonly generateId: () => string;

  constructor(private readonly options: StationIdentityServiceOptions) {
    this.writer = options.writer ?? new SafeFileWriter({ backups: 3 });
    this.buildInfo = options.buildInfo ?? SERVER_BUILD_INFO;
    this.generateId = options.generateId ?? randomUUID;
  }

  getInstanceId(): Promise<string> {
    if (!this.instanceIdPromise) {
      this.instanceIdPromise = this.loadInstanceId().catch((error) => {
        this.instanceIdPromise = null;
        throw error;
      });
    }
    return this.instanceIdPromise;
  }

  async getIdentity(): Promise<StationIdentity> {
    const [instanceId, distribution] = await Promise.all([
      this.getInstanceId(),
      this.options.getDistribution(),
    ]);
    return StationIdentitySchema.parse({
      identityVersion: STATION_IDENTITY_VERSION,
      product: 'tx5dr',
      instanceId,
      hostVersion: this.buildInfo.version,
      sourceSha: this.buildInfo.commit,
      channel: this.buildInfo.channel,
      distribution,
      auth: this.options.getAuthStatus(),
      desktopBridge: { minVersion: DESKTOP_BRIDGE_VERSION },
    });
  }

  private async loadInstanceId(): Promise<string> {
    const filePath = path.join(await this.options.getConfigDir(), STATION_INSTANCE_FILE_NAME);
    const load = () => loadJsonWithRecovery(filePath, {
      defaultValue: () => ({ instanceId: this.generateId() }),
      validate: value => StationInstanceFileSchema.parse(value),
      writer: this.writer,
    });

    try {
      return (await load()).value.instanceId;
    } catch (error) {
      if (!(error instanceof JsonRecoveryError)) throw error;
      // The ID carries no user data, so an unrecoverable file is archived and replaced.
      const raw = await readOptionalFile(filePath);
      if (raw !== null) {
        const digest = createHash('sha256').update(raw).digest('hex');
        await this.writer.writeFile(`${filePath}.corrupt-${digest}`, raw, { backups: 0 });
      }
      const instanceId = this.generateId();
      await this.writer.writeFile(filePath, `${JSON.stringify({ instanceId }, null, 2)}\n`, { backups: 0 });
      logger.warn('station instance file was unrecoverable; generated a new instance ID', {
        causes: error.causes,
      });
      return instanceId;
    }
  }
}

let defaultService: StationIdentityService | null = null;

/** Process-wide identity owner shared by the identity route and LAN discovery. */
export function getStationIdentityService(): StationIdentityService {
  if (!defaultService) {
    defaultService = new StationIdentityService({
      getConfigDir: () => tx5drPaths.getConfigDir(),
      getAuthStatus: () => AuthManager.getInstance().getAuthConfig(),
      getDistribution: async () => resolvePluginDistribution(await tx5drPaths.getDataDir()),
    });
  }
  return defaultService;
}
