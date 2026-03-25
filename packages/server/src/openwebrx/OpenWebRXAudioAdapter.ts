import { EventEmitter } from 'eventemitter3';
import { OpenWebRXClient } from '@openwebrx-js/api';
import type { ServerConfig, Profile } from '@openwebrx-js/api';
import type { OpenWebRXStationConfig } from '@tx5dr/contracts';
import { RingBufferAudioProvider } from '../audio/AudioBufferProvider.js';
import { createLogger } from '../utils/logger.js';
import { OpenWebRXProfileService } from './OpenWebRXProfileService.js';

const logger = createLogger('OpenWebRXAudioAdapter');

/** Internal sample rate matching TX-5DR pipeline (zero resample) */
const INTERNAL_SAMPLE_RATE = 12000;

/** Max retries when profile is hijacked by another user */
const PROFILE_RECLAIM_MAX_RETRIES = 3;

export interface OpenWebRXAudioAdapterEvents {
  'audioData': (samples: Float32Array) => void;
  'error': (error: Error) => void;
  'connected': () => void;
  'disconnected': (code: number, reason: string) => void;
  'profileChanged': (profileId: string) => void;
  'profileSelectRequired': (data: {
    requestId: string;
    targetFrequency: number;
    profiles: Array<{ id: string; name: string }>;
    currentProfileId: string | null;
  }) => void;
  'clientCountChanged': (count: number) => void;
  'cooldownWait': (data: { waitMs: number; profileId: string }) => void;
}

/**
 * OpenWebRX audio adapter for engine runtime.
 * Manages OpenWebRX client connection, profile selection, frequency tuning,
 * and feeds 12kHz audio into the TX-5DR audio pipeline.
 */
export class OpenWebRXAudioAdapter extends EventEmitter<OpenWebRXAudioAdapterEvents> {
  private client: OpenWebRXClient;
  private stationConfig: OpenWebRXStationConfig;
  private audioProvider: RingBufferAudioProvider;
  private isReceiving = false;
  private _isConnected = false;

  // Frequency and profile tracking
  private targetFrequency: number = 0;
  private currentProfileId: string | null = null;
  private currentConfig: ServerConfig | null = null;
  private profileReclaimRetries: number = 0;

  // Bound event handlers for proper cleanup
  private boundHandleAudio: (pcm: Int16Array) => void;
  private boundHandleConfig: (config: ServerConfig) => void;
  private boundHandleError: (err: Error) => void;
  private boundHandleDisconnected: (code: number, reason: string) => void;
  private boundHandleBackoff: (reason: string) => void;
  private boundHandleClientCount: (count: number) => void;

  constructor(stationConfig: OpenWebRXStationConfig) {
    super();
    this.stationConfig = stationConfig;
    this.client = new OpenWebRXClient({
      url: stationConfig.url,
      outputRate: INTERNAL_SAMPLE_RATE,
    });

    this.audioProvider = new RingBufferAudioProvider(INTERNAL_SAMPLE_RATE, INTERNAL_SAMPLE_RATE * 5);

    // Bind handlers
    this.boundHandleAudio = this.handleAudioFrame.bind(this);
    this.boundHandleConfig = this.handleConfigChange.bind(this);
    this.boundHandleError = this.handleError.bind(this);
    this.boundHandleDisconnected = this.handleDisconnected.bind(this);
    this.boundHandleBackoff = this.handleBackoff.bind(this);
    this.boundHandleClientCount = this.handleClientCount.bind(this);

    logger.info('Initialized', { station: stationConfig.name, url: stationConfig.url });
  }

  /**
   * Connect to the OpenWebRX server
   */
  async connect(): Promise<string> {
    logger.info('Connecting to OpenWebRX server', { url: this.stationConfig.url });

    // Register event handlers before connecting
    this.client.on('config', this.boundHandleConfig);
    this.client.on('error', this.boundHandleError);
    this.client.on('disconnected', this.boundHandleDisconnected);
    this.client.on('backoff', this.boundHandleBackoff);
    this.client.on('clients', this.boundHandleClientCount);

    const version = await this.client.connect();
    this._isConnected = true;

    // Wait for server to send profiles and initial config.
    // Without this, getProfiles() returns [] and setTargetFrequency() fails.
    await new Promise(resolve => setTimeout(resolve, 500));

    this.emit('connected');
    logger.info('Connected to OpenWebRX server', {
      version,
      station: this.stationConfig.name,
      profiles: this.client.getProfiles().length,
    });
    return version;
  }

  /**
   * Disconnect from the OpenWebRX server
   */
  disconnect(): void {
    logger.info('Disconnecting from OpenWebRX server');

    this.stopReceiving();

    // Remove event handlers
    this.client.off('config', this.boundHandleConfig);
    this.client.off('error', this.boundHandleError);
    this.client.off('disconnected', this.boundHandleDisconnected);
    this.client.off('backoff', this.boundHandleBackoff);
    this.client.off('clients', this.boundHandleClientCount);

    this.client.disconnect();
    this._isConnected = false;
    this.currentProfileId = null;
    this.currentConfig = null;

    logger.info('Disconnected from OpenWebRX server');
  }

  /**
   * Set the target frequency and auto-select appropriate profile
   */
  async setTargetFrequency(hz: number): Promise<void> {
    this.targetFrequency = hz;
    logger.info('Setting target frequency', { frequency: hz });

    if (!this._isConnected) {
      logger.warn('Not connected, frequency will be set on connect');
      return;
    }

    await this.tuneToFrequency(hz);
  }

  /**
   * Start receiving audio from the OpenWebRX client
   */
  startReceiving(): void {
    if (this.isReceiving) {
      logger.warn('Already receiving audio');
      return;
    }

    logger.info('Starting audio reception');
    this.client.on('audio', this.boundHandleAudio);
    this.client.startDsp();
    this.isReceiving = true;

    // The OpenWebRXClient library has internal logic: when pendingProfileSwitch
    // is true and dspStarted becomes true, the next config message from the
    // server triggers an auto-restart that resets the ADPCM decoder and
    // overrides modulation/frequency with profile defaults.
    // Re-apply our settings after a delay to recover from this.
    if (this.targetFrequency > 0) {
      setTimeout(() => {
        if (this.isReceiving && this._isConnected) {
          logger.debug('Re-applying DSP settings after startDsp', { frequency: this.targetFrequency });
          this.client.setFrequency(this.targetFrequency);
          this.client.setModulation('usb');
          this.client.setBandpass(0, 3000);
        }
      }, 1000);
    }

    logger.info('Audio reception started');
  }

  /**
   * Stop receiving audio
   */
  stopReceiving(): void {
    if (!this.isReceiving) return;

    logger.info('Stopping audio reception');
    this.client.off('audio', this.boundHandleAudio);
    this.isReceiving = false;
    logger.info('Audio reception stopped');
  }

  /**
   * Get the audio provider (RingBuffer) for AudioStreamManager integration
   */
  getAudioProvider(): RingBufferAudioProvider {
    return this.audioProvider;
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this._isConnected && this.client.isConnected();
  }

  /**
   * Get the sample rate (always 12kHz)
   */
  getSampleRate(): number {
    return INTERNAL_SAMPLE_RATE;
  }

  /**
   * Get the OpenWebRX client profiles
   */
  getProfiles(): Profile[] {
    return this.client.getProfiles();
  }

  /**
   * Get current server config
   */
  getServerConfig(): ServerConfig | null {
    return this.currentConfig;
  }

  /**
   * Clear audio buffer
   */
  clearBuffer(): void {
    this.audioProvider.clear();
  }

  /**
   * Check if receiving audio
   */
  isReceivingAudio(): boolean {
    return this.isReceiving;
  }

  // ===== Private methods =====

  /**
   * Tune to the specified frequency, switching profile if needed.
   *
   * Strategy:
   * 1. Current profile covers → tune directly (instant).
   * 2. Cached profile covers → switch via ProfileService + tune.
   * 3. No match → emit profileSelectRequired for manual admin selection.
   */
  private async tuneToFrequency(hz: number): Promise<void> {
    const svc = OpenWebRXProfileService.getInstance();

    // 1. Current profile covers → tune directly
    if (this.currentConfig) {
      const cc = this.currentConfig.center_freq ?? 0;
      const sr = this.currentConfig.samp_rate ?? 0;
      if (svc.isFrequencyCovered(hz, cc, sr)) {
        this.applyTuning(hz);
        logger.info('Tuned within current profile', { frequency: hz, centerFreq: cc });
        return;
      }
    }

    // 2. Cached profile covers the frequency
    const cachedId = svc.findCoveringProfileFromCache(this.stationConfig.url, hz);
    if (cachedId && cachedId !== this.currentProfileId) {
      logger.info('Found covering profile in cache', { profileId: cachedId, frequency: hz });
      this.currentProfileId = cachedId;
      this.profileReclaimRetries = 0;
      await svc.switchProfile(this.client, this.stationConfig.url, cachedId, {
        onCooldownWait: (waitMs) => this.emit('cooldownWait', { waitMs, profileId: cachedId }),
      });
      this.currentConfig = this.client.getConfig();
      this.applyTuning(hz);
      return;
    }

    // 3. No match → request manual profile selection from admin
    logger.warn('No profile covers target frequency, requesting manual selection', { frequency: hz });
    this.emit('profileSelectRequired', {
      requestId: `psr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      targetFrequency: hz,
      profiles: this.client.getProfiles().map(p => ({ id: p.id, name: p.name })),
      currentProfileId: this.currentProfileId,
    });
  }

  /**
   * Apply frequency, modulation, and bandpass settings.
   */
  private applyTuning(hz: number): void {
    this.client.setFrequency(hz);
    this.client.setModulation('usb');
    this.client.setBandpass(0, 3000);
  }

  /**
   * Verify that a profile covers the target frequency, switch to it, and apply tuning.
   * Used for user-initiated manual profile selection (bypasses cooldown).
   */
  async verifyAndApplyProfile(profileId: string, targetFrequency: number): Promise<{
    success: boolean;
    centerFreq?: number;
    sampRate?: number;
    error?: string;
  }> {
    // Update currentProfileId BEFORE switching so handleConfigChange
    // doesn't treat this as an external hijack and attempt to reclaim.
    this.currentProfileId = profileId;
    this.profileReclaimRetries = 0;

    const svc = OpenWebRXProfileService.getInstance();
    const config = await svc.switchProfile(
      this.client, this.stationConfig.url, profileId, { bypassCooldown: true }
    );
    this.currentConfig = this.client.getConfig();

    if (svc.isFrequencyCovered(targetFrequency, config.centerFreq, config.sampRate)) {
      this.applyTuning(targetFrequency);
      logger.info('Manual profile verified and applied', { profileId, targetFrequency });
      return { success: true, ...config };
    }
    logger.warn('Manual profile does not cover target', { profileId, targetFrequency, ...config });
    return { success: false, ...config, error: 'frequency_not_covered' };
  }

  /**
   * Handle audio frame from OpenWebRX (Int16Array at 12kHz)
   */
  private handleAudioFrame(pcm16: Int16Array): void {
    try {
      // Convert Int16Array to Float32Array (same as IcomWlanAudioAdapter)
      const samples = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        samples[i] = pcm16[i] / 32768.0;
      }

      // Write to ring buffer
      this.audioProvider.writeAudio(samples);

      // Emit event
      this.emit('audioData', samples);
    } catch (error) {
      logger.error('Failed to process audio frame', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Handle config change from server (detect profile hijacking)
   */
  private handleConfigChange(config: ServerConfig): void {
    this.currentConfig = config;

    const serverProfileId = config.sdr_id && config.profile_id
      ? `${config.sdr_id}|${config.profile_id}`
      : null;

    // Update global cache
    if (serverProfileId && config.center_freq && config.samp_rate) {
      const profileName = this.client.getProfiles().find(p => p.id === serverProfileId)?.name ?? serverProfileId;
      OpenWebRXProfileService.getInstance().cacheConfig(
        this.stationConfig.url, serverProfileId, profileName,
        config.center_freq, config.samp_rate
      );
    }

    // Detect profile hijacking (another user switched the profile)
    if (this.currentProfileId && serverProfileId && serverProfileId !== this.currentProfileId) {
      logger.warn('Profile was switched externally', {
        expected: this.currentProfileId,
        actual: serverProfileId,
      });

      if (this.profileReclaimRetries < PROFILE_RECLAIM_MAX_RETRIES) {
        this.profileReclaimRetries++;
        logger.info('Attempting to reclaim profile', {
          attempt: this.profileReclaimRetries,
          maxRetries: PROFILE_RECLAIM_MAX_RETRIES,
        });

        // Delay before reclaiming to avoid rapid switching
        setTimeout(() => {
          if (this._isConnected && this.currentProfileId) {
            const reclaimProfileId = this.currentProfileId;
            OpenWebRXProfileService.getInstance().switchProfile(
              this.client, this.stationConfig.url, reclaimProfileId, {
                onCooldownWait: (waitMs) => this.emit('cooldownWait', { waitMs, profileId: reclaimProfileId }),
              }
            ).catch(err => {
              if (err?.name === 'ProfileSwitchCancelledError') {
                logger.debug('Profile reclaim cancelled by newer request');
              } else {
                logger.error('Failed to reclaim profile', err);
              }
            });
            // Re-tune after profile switch
            if (this.targetFrequency > 0) {
              setTimeout(() => {
                this.client.setFrequency(this.targetFrequency);
                this.client.setModulation('usb');
                this.client.setBandpass(0, 3000);
              }, 1000);
            }
          }
        }, 2000);
      } else {
        logger.error('Profile reclaim retries exhausted', {
          station: this.stationConfig.name,
          profileId: this.currentProfileId,
        });
        this.emit('error', new Error(
          `SDR profile was switched by another user and could not be reclaimed after ${PROFILE_RECLAIM_MAX_RETRIES} attempts`
        ));
      }
    } else if (serverProfileId) {
      this.currentProfileId = serverProfileId;
      this.profileReclaimRetries = 0;
    }

    logger.debug('Config updated', {
      centerFreq: config.center_freq,
      sampRate: config.samp_rate,
      profileId: serverProfileId,
    });
  }

  /**
   * Handle error from OpenWebRX client
   */
  private handleError(err: Error): void {
    logger.error('OpenWebRX client error', err);
    this.emit('error', err);
  }

  /**
   * Handle disconnection from OpenWebRX server
   */
  private handleDisconnected(code: number, reason: string): void {
    logger.warn('Disconnected from OpenWebRX server', { code, reason });
    this._isConnected = false;
    this.isReceiving = false;
    this.emit('disconnected', code, reason);
  }

  /**
   * Handle client count change from OpenWebRX server
   */
  private handleClientCount(count: number): void {
    logger.debug('OpenWebRX client count changed', { count });
    this.emit('clientCountChanged', count);
  }

  /**
   * Get current client count on the OpenWebRX server
   */
  getClientCount(): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.client as any).getClientCount?.() ?? 0;
  }

  /**
   * Handle backoff signal from server (bot detection / too many clients)
   */
  private handleBackoff(reason: string): void {
    logger.error('Server requested backoff', { reason, station: this.stationConfig.name });
    this._isConnected = false;
    this.isReceiving = false;

    const isBan = reason.toLowerCase().includes('ban');
    const error = new Error(
      isBan
        ? `OpenWebRX server banned this IP: ${reason}. The ban typically lasts 12 hours. ` +
          `This is caused by rapid profile switching triggering bot detection.`
        : `OpenWebRX server rejected connection: ${reason}`
    );
    this.emit('error', error);
  }
}
