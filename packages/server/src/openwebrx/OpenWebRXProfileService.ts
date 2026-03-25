import type { OpenWebRXClient, ServerConfig } from '@openwebrx-js/api';
import type { OpenWebRXStationConfig } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('OpenWebRXProfileService');

/** Thrown when a pending profile switch is cancelled by a newer request */
export class ProfileSwitchCancelledError extends Error {
  constructor() {
    super('Profile switch cancelled by newer request');
    this.name = 'ProfileSwitchCancelledError';
  }
}

/**
 * OpenWebRX bot detection parameters (from owrx/connection.py):
 *   robotScore = 10 - secondsSinceLastSwitch
 *   robotAlert += robotScore  (resets to 0 when score < 0)
 *   robotAlert >= 30 → 12-hour IP ban
 *
 * With 11s interval each switch scores -1, resetting robotAlert to 0.
 */
const COOLDOWN_MS = 11000;

/** Timeout for waiting config after profile switch */
const CONFIG_WAIT_TIMEOUT_MS = 5000;

/**
 * After receiving the first matching config, wait this long for subsequent
 * config updates to settle. OpenWebRX sends multiple config events when
 * switching profiles: first with the new profile_id but stale center_freq,
 * then the real config after the SDR hardware reconfigures and DSP restarts.
 * The gap can be 500ms–2s+ depending on network latency and SDR hardware.
 */
const CONFIG_SETTLE_MS = 2000;

export interface ProfileConfig {
  centerFreq: number;
  sampRate: number;
}

export interface SwitchProfileOptions {
  /** Skip cooldown wait (for user-initiated manual selections) */
  bypassCooldown?: boolean;
  /** Called when cooldown is active and the switch is queued. Receives remaining wait in ms. */
  onCooldownWait?: (waitMs: number) => void;
}

/**
 * Singleton service managing OpenWebRX SDR profile operations.
 *
 * Centralizes:
 * - Global cooldown (shared across all connections to avoid bot detection)
 * - Profile config cache (persisted to ConfigManager)
 * - Promise-based profile switching (listens for config event, not blind setTimeout)
 * - Frequency coverage checking
 *
 * Used by both OpenWebRXAudioAdapter (engine runtime) and
 * OpenWebRXStationManager (settings UI listen preview).
 */
export class OpenWebRXProfileService {
  private static instance: OpenWebRXProfileService;

  /** Global cooldown timestamp — shared across all connections on this IP */
  private lastSwitchTime = 0;

  /** Abort controller for the currently pending (cooldown-waiting) switch */
  private pendingSwitchAbort: AbortController | null = null;

  /** In-memory cache: `${serverUrl}::${profileId}` → {centerFreq, sampRate} */
  private configCache = new Map<string, ProfileConfig>();

  private constructor() {
    this.loadPersistedCache();
    logger.info('Profile service initialized', { cachedEntries: this.configCache.size });
  }

  static getInstance(): OpenWebRXProfileService {
    if (!OpenWebRXProfileService.instance) {
      OpenWebRXProfileService.instance = new OpenWebRXProfileService();
    }
    return OpenWebRXProfileService.instance;
  }

  // ===== Profile Switching =====

  /**
   * Switch to a profile and wait for config to arrive (Promise-based).
   *
   * - Respects global cooldown (unless bypassCooldown is set for manual operations)
   * - Always updates lastSwitchTime (even when bypassed, to protect subsequent auto-switches)
   * - Listens for the `config` event instead of blind setTimeout
   * - Caches the result on success
   */
  async switchProfile(
    client: OpenWebRXClient,
    serverUrl: string,
    profileId: string,
    options?: SwitchProfileOptions
  ): Promise<ProfileConfig> {
    // 1. Cancel any previous pending switch (new request supersedes old one)
    if (this.pendingSwitchAbort) {
      logger.info('Cancelling previous pending profile switch', { newProfileId: profileId });
      this.pendingSwitchAbort.abort();
      this.pendingSwitchAbort = null;
    }

    // 2. Cooldown — queue the switch and notify caller
    if (!options?.bypassCooldown) {
      const elapsed = Date.now() - this.lastSwitchTime;
      if (elapsed < COOLDOWN_MS) {
        const waitMs = COOLDOWN_MS - elapsed;
        logger.info('Profile switch queued, waiting for cooldown', { waitMs, profileId });
        options?.onCooldownWait?.(waitMs);

        const abortController = new AbortController();
        this.pendingSwitchAbort = abortController;

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this.pendingSwitchAbort === abortController) {
              this.pendingSwitchAbort = null;
            }
            resolve();
          }, waitMs);

          abortController.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ProfileSwitchCancelledError());
          }, { once: true });
        });
      }
    }

    // 3. Register config listener BEFORE sending switch command to avoid race
    logger.info('Switching profile', { profileId, bypass: !!options?.bypassCooldown });

    // Parse expected sdr_id and profile_id from composite profileId (format: "sdrId|profileId")
    const [expectedSdrId, expectedProfileId] = profileId.includes('|')
      ? profileId.split('|', 2)
      : [undefined, undefined];

    // OpenWebRX sends multiple config events when switching profiles:
    //   1) Config with new profile_id but STALE center_freq (immediate)
    //   2) Client library auto-restarts DSP (pendingProfileSwitch)
    //   3) Config with REAL center_freq after SDR hardware reconfigures
    // We use a debounce: each matching config resets a timer. We resolve
    // with the LAST config received after no new events for CONFIG_SETTLE_MS.
    const config = await new Promise<ServerConfig>((resolve, reject) => {
      let latestConfig: ServerConfig | null = null;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      let matchCount = 0;

      const overallTimeout = setTimeout(() => {
        cleanup();
        if (latestConfig) {
          logger.debug('Config resolved by overall timeout', {
            centerFreq: latestConfig.center_freq,
            sampRate: latestConfig.samp_rate,
            matchCount,
          });
          resolve(latestConfig);
        } else {
          reject(new Error(`Profile config timeout after ${CONFIG_WAIT_TIMEOUT_MS}ms`));
        }
      }, CONFIG_WAIT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(overallTimeout);
        if (settleTimer) clearTimeout(settleTimer);
        client.off('config', handler);
      };

      const handler = (cfg: ServerConfig) => {
        if (!cfg.sdr_id || !cfg.profile_id) return;

        if (expectedSdrId && expectedProfileId) {
          if (cfg.sdr_id !== expectedSdrId || cfg.profile_id !== expectedProfileId) {
            logger.debug('Ignoring config for different profile', {
              expected: profileId,
              received: `${cfg.sdr_id}|${cfg.profile_id}`,
            });
            return;
          }
        }

        matchCount++;
        latestConfig = cfg;
        logger.debug('Matching config received', {
          matchCount,
          centerFreq: cfg.center_freq,
          sampRate: cfg.samp_rate,
        });

        // Reset settle timer on each matching event (debounce).
        // Resolves CONFIG_SETTLE_MS after the LAST matching event.
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          cleanup();
          logger.debug('Config settled', {
            centerFreq: latestConfig!.center_freq,
            sampRate: latestConfig!.samp_rate,
            matchCount,
          });
          resolve(latestConfig!);
        }, CONFIG_SETTLE_MS);
      };

      // Register listener first, then send command
      client.on('config', handler);
      client.selectProfile(profileId);
      this.lastSwitchTime = Date.now();
    });

    // 4. Cache and return
    const result: ProfileConfig = {
      centerFreq: config.center_freq ?? 0,
      sampRate: config.samp_rate ?? 0,
    };

    const profileName = client.getProfiles().find(p => p.id === profileId)?.name ?? profileId;
    this.cacheConfig(serverUrl, profileId, profileName, result.centerFreq, result.sampRate);

    logger.info('Profile switched successfully', {
      profileId,
      centerFreq: result.centerFreq,
      sampRate: result.sampRate,
    });

    return result;
  }

  // ===== Frequency Coverage =====

  /**
   * Check if a frequency falls within center ± sampRate/2.
   */
  isFrequencyCovered(hz: number, centerFreq: number, sampRate: number): boolean {
    return hz >= centerFreq - sampRate / 2 && hz <= centerFreq + sampRate / 2;
  }

  /**
   * Find a profile covering the frequency from the persisted cache.
   * Returns profile ID or null.
   */
  findCoveringProfileFromCache(serverUrl: string, frequencyHz: number): string | null {
    for (const [key, cfg] of this.configCache) {
      if (!key.startsWith(`${serverUrl}::`)) continue;
      if (this.isFrequencyCovered(frequencyHz, cfg.centerFreq, cfg.sampRate)) {
        return key.substring(serverUrl.length + 2); // strip "url::" prefix
      }
    }
    return null;
  }

  // ===== Cache Management =====

  /**
   * Update both in-memory cache and persisted config.
   * Called on every config event to keep cache fresh.
   */
  cacheConfig(
    serverUrl: string,
    profileId: string,
    profileName: string,
    centerFreq: number,
    sampRate: number
  ): void {
    // In-memory
    this.configCache.set(`${serverUrl}::${profileId}`, { centerFreq, sampRate });

    // Persist to station config
    const configManager = ConfigManager.getInstance();
    const station = this.findStationByUrl(configManager, serverUrl);
    if (!station) return;

    const coverages = [...(station.profileCoverages ?? [])];
    const entry = {
      profileId,
      profileName,
      centerFreq,
      sampRate,
      lastUpdated: Date.now(),
    };

    const idx = coverages.findIndex(c => c.profileId === profileId);
    if (idx >= 0) {
      coverages[idx] = entry;
    } else {
      coverages.push(entry);
    }

    configManager.updateOpenWebRXStation(station.id, { profileCoverages: coverages }).catch(err => {
      logger.error('Failed to persist profile coverage', err);
    });
  }

  /**
   * Get cached config for a specific profile (or null).
   */
  getCachedConfig(serverUrl: string, profileId: string): ProfileConfig | null {
    return this.configCache.get(`${serverUrl}::${profileId}`) ?? null;
  }

  /**
   * Get remaining cooldown milliseconds (for UI display).
   */
  getCooldownRemaining(): number {
    const elapsed = Date.now() - this.lastSwitchTime;
    return Math.max(0, COOLDOWN_MS - elapsed);
  }

  // ===== Private =====

  /**
   * Load persisted profile coverages from all stations into memory cache.
   */
  private loadPersistedCache(): void {
    try {
      const stations = ConfigManager.getInstance().getOpenWebRXStations();
      for (const station of stations) {
        if (!station.profileCoverages) continue;
        for (const coverage of station.profileCoverages) {
          this.configCache.set(
            `${station.url}::${coverage.profileId}`,
            { centerFreq: coverage.centerFreq, sampRate: coverage.sampRate }
          );
        }
      }
    } catch (err) {
      logger.warn('Failed to load persisted profile cache', err);
    }
  }

  /**
   * Find a station config by URL (for persisting cache back).
   */
  private findStationByUrl(
    configManager: ConfigManager,
    serverUrl: string
  ): OpenWebRXStationConfig | undefined {
    const normalized = serverUrl.replace(/\/$/, '');
    return configManager.getOpenWebRXStations().find(
      s => s.url.replace(/\/$/, '') === normalized
    );
  }
}
