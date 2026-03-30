import { EventEmitter } from 'eventemitter3';
import { OpenWebRXClient } from '@openwebrx-js/api';
import type { ServerConfig } from '@openwebrx-js/api';
import type { OpenWebRXStationConfig, OpenWebRXListenStatus, OpenWebRXTestResult } from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import { RingBufferAudioProvider } from '../audio/AudioBufferProvider.js';
import { AudioMonitorService } from '../audio/AudioMonitorService.js';
import { OpenWebRXProfileService } from './OpenWebRXProfileService.js';
import { createLogger } from '../utils/logger.js';
import { randomUUID } from 'crypto';

const logger = createLogger('OpenWebRXStationManager');

/** Connection test timeout (ms) */
const TEST_TIMEOUT_MS = 10000;

/** Internal sample rate from OpenWebRX (matches TX-5DR pipeline) */
const OPENWEBRX_SAMPLE_RATE = 12000;

export interface OpenWebRXStationManagerEvents {
  'listenStatusChanged': (status: OpenWebRXListenStatus) => void;
}

interface ListenSession {
  previewSessionId: string;
  client: OpenWebRXClient;
  stationId: string;
  status: OpenWebRXListenStatus;
  smeterInterval: ReturnType<typeof setInterval> | null;
  audioProvider: RingBufferAudioProvider;
  audioMonitorService: AudioMonitorService;
}

/**
 * Manages OpenWebRX station configurations and listen/test sessions.
 * This is independent of the engine - used for settings UI testing.
 *
 * Audio pipeline:
 *   OpenWebRXClient audio event (12kHz Int16Array)
 *     → Float32Array conversion
 *     → RingBufferAudioProvider (12kHz ring buffer)
 *     → AudioMonitorService (20ms chunking, resample to 48kHz, sequence numbers)
 *     → LiveKit bridge (WebRTC audio room)
 */
export class OpenWebRXStationManager extends EventEmitter<OpenWebRXStationManagerEvents> {
  private static instance: OpenWebRXStationManager | null = null;
  private activeSession: ListenSession | null = null;

  private constructor() {
    super();
  }

  static getInstance(): OpenWebRXStationManager {
    if (!OpenWebRXStationManager.instance) {
      OpenWebRXStationManager.instance = new OpenWebRXStationManager();
    }
    return OpenWebRXStationManager.instance;
  }

  // ===== Station CRUD =====

  getStations(): OpenWebRXStationConfig[] {
    return ConfigManager.getInstance().getOpenWebRXStations();
  }

  getStationById(id: string): OpenWebRXStationConfig | undefined {
    return ConfigManager.getInstance().getOpenWebRXStationById(id);
  }

  async addStation(config: Omit<OpenWebRXStationConfig, 'id'>): Promise<OpenWebRXStationConfig> {
    const station: OpenWebRXStationConfig = {
      id: randomUUID(),
      ...config,
    };
    await ConfigManager.getInstance().addOpenWebRXStation(station);
    logger.info('Station added', { id: station.id, name: station.name });
    return station;
  }

  async updateStation(id: string, updates: Partial<Omit<OpenWebRXStationConfig, 'id'>>): Promise<void> {
    await ConfigManager.getInstance().updateOpenWebRXStation(id, updates);
    logger.info('Station updated', { id });
  }

  async removeStation(id: string): Promise<void> {
    if (this.activeSession?.stationId === id) {
      await this.stopListen();
    }
    await ConfigManager.getInstance().removeOpenWebRXStation(id);
    logger.info('Station removed', { id });
  }

  // ===== Connection Test =====

  async testConnection(url: string): Promise<OpenWebRXTestResult> {
    logger.info('Testing connection', { url });
    const client = new OpenWebRXClient({ url, outputRate: OPENWEBRX_SAMPLE_RATE });

    try {
      const version = await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Connection timeout')), TEST_TIMEOUT_MS)
        ),
      ]);

      // Wait a moment for profiles to arrive
      await new Promise(resolve => setTimeout(resolve, 500));

      const profiles = client.getProfiles();
      client.disconnect();

      logger.info('Connection test succeeded', { version, profileCount: profiles.length });
      return {
        success: true,
        serverVersion: version,
        profiles: profiles.map(p => ({ id: p.id, name: p.name })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Connection test failed', { url, error: message });
      try { client.disconnect(); } catch { /* ignore */ }
      return { success: false, error: message };
    }
  }

  // ===== Listen Session =====

  /**
   * Get the AudioMonitorService for the active listen session.
   * Used by WSServer to route audio data to the dedicated binary WS.
   */
  getAudioMonitorService(): AudioMonitorService | null {
    return this.activeSession?.audioMonitorService ?? null;
  }

  async startListen(options: {
    stationId: string;
    profileId?: string;
    frequency?: number;
    modulation?: string;
  }): Promise<OpenWebRXListenStatus> {
    if (this.activeSession) {
      await this.stopListen();
    }

    const station = this.getStationById(options.stationId);
    if (!station) {
      throw new Error(`Station not found: ${options.stationId}`);
    }

    logger.info('Starting listen session', { station: station.name, ...options });

    const client = new OpenWebRXClient({
      url: station.url,
      outputRate: OPENWEBRX_SAMPLE_RATE,
    });

    const status: OpenWebRXListenStatus = {
      previewSessionId: randomUUID(),
      stationId: options.stationId,
      connected: false,
      profiles: [],
      isListening: false,
    };

    // Create audio pipeline: RingBuffer → AudioMonitorService
    const audioProvider = new RingBufferAudioProvider(OPENWEBRX_SAMPLE_RATE, OPENWEBRX_SAMPLE_RATE * 5);
    const audioMonitorService = new AudioMonitorService(audioProvider);

    const session: ListenSession = {
      previewSessionId: status.previewSessionId!,
      client,
      stationId: options.stationId,
      status,
      smeterInterval: null,
      audioProvider,
      audioMonitorService,
    };

    this.activeSession = session;

    try {
      const version = await client.connect();
      status.connected = true;
      status.serverVersion = version;
      this.emitStatus();

      // Wait for profiles
      await new Promise(resolve => setTimeout(resolve, 500));
      status.profiles = client.getProfiles().map(p => ({ id: p.id, name: p.name }));
      this.emitStatus();

      // Select profile (user-initiated, bypass cooldown)
      const profileService = OpenWebRXProfileService.getInstance();
      if (options.profileId) {
        await profileService.switchProfile(client, station.url, options.profileId, { bypassCooldown: true });
        status.currentProfileId = options.profileId;
      } else if (status.profiles.length > 0) {
        await profileService.switchProfile(client, station.url, status.profiles[0].id, { bypassCooldown: true });
        status.currentProfileId = status.profiles[0].id;
      }

      // Debug: monitor raw WS binary messages from OpenWebRX server
      let rawBinaryCount = 0;
      let rawTextCount = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ws = (client as any).ws;
      if (ws && typeof ws.on === 'function') {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            rawBinaryCount++;
            if (rawBinaryCount <= 3) {
              const opcode = data[0];
              logger.debug('Raw binary message from OpenWebRX', {
                count: rawBinaryCount,
                opcode,
                length: data.length,
              });
            }
          } else {
            rawTextCount++;
            if (rawTextCount <= 5) {
              const text = data.toString().substring(0, 200);
              logger.debug('Raw text message from OpenWebRX', {
                count: rawTextCount,
                text,
              });
            }
          }
        });
        logger.info('Attached raw WS message monitor');
      } else {
        logger.warn('Could not access OpenWebRXClient internal WS for monitoring');
      }

      // Config listener
      client.on('config', (config: ServerConfig) => {
        status.centerFreq = config.center_freq;
        status.sampleRate = config.samp_rate;
        if (config.sdr_id && config.profile_id) {
          status.currentProfileId = `${config.sdr_id}|${config.profile_id}`;
          // Update global profile cache
          const profileName = client.getProfiles().find(
            p => p.id === status.currentProfileId
          )?.name ?? status.currentProfileId!;
          OpenWebRXProfileService.getInstance().cacheConfig(
            station.url, status.currentProfileId!, profileName,
            config.center_freq ?? 0, config.samp_rate ?? 0
          );
        }
        this.emitStatus();
      });

      // S-meter listener
      client.on('smeter', (level: number) => {
        status.smeterDb = level > 0 ? 10 * Math.log10(level) : -100;
      });

      // Audio listener: write to RingBuffer (AudioMonitorService handles the rest)
      let audioChunkCount = 0;
      client.on('audio', (pcm: Int16Array) => {
        audioChunkCount++;
        if (audioChunkCount <= 3 || audioChunkCount % 100 === 0) {
          logger.debug('OpenWebRX audio chunk received', {
            chunk: audioChunkCount,
            samples: pcm.length,
            firstSample: pcm[0],
          });
        }
        const float32 = new Float32Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          float32[i] = pcm[i] / 32768.0;
        }
        audioProvider.writeAudio(float32);
      });

      // Error listener
      client.on('error', (err: Error) => {
        logger.error('Listen session error', err);
        status.error = err.message;
        this.emitStatus();
      });

      // Disconnected listener
      client.on('disconnected', (_code: number, reason: string) => {
        logger.warn('Listen session disconnected', { reason });
        status.connected = false;
        status.isListening = false;
        this.emitStatus();
      });

      // Set modulation and frequency
      if (options.modulation) {
        client.setModulation(options.modulation);
        status.modulation = options.modulation;
      } else {
        client.setModulation('usb');
        status.modulation = 'usb';
      }

      if (options.frequency) {
        client.setFrequency(options.frequency);
        status.frequency = options.frequency;
      }

      client.setBandpass(0, 3000);

      // Start DSP
      logger.info('Sending startDsp command to OpenWebRX server');
      client.startDsp();
      status.isListening = true;
      status.error = undefined;
      this.emitStatus();

      // Log client state for debugging
      const currentConfig = client.getConfig();
      logger.info('OpenWebRX client state after startDsp', {
        audioCompression: (currentConfig as Record<string, unknown>).audio_compression ?? 'unknown',
        centerFreq: currentConfig.center_freq,
      });

      // Delayed check: verify audio is flowing after 3 seconds
      setTimeout(() => {
        if (!this.activeSession || this.activeSession.client !== client) return;
        const bufferMs = audioProvider.getAvailableMs();
        logger.info('OpenWebRX audio flow check (3s after startDsp)', {
          audioChunksReceived: audioChunkCount,
          bufferMs: bufferMs.toFixed(1),
          isConnected: client.isConnected(),
        });
        if (audioChunkCount === 0) {
          logger.warn('No audio data received from OpenWebRX server after 3 seconds');
        }
      }, 3000);

      // Periodic S-meter push
      session.smeterInterval = setInterval(() => {
        this.emitStatus();
      }, 1000);

      logger.info('Listen session started', { station: station.name });
      return status;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to start listen session', { error: message });
      status.error = message;
      status.connected = false;
      status.isListening = false;

      audioMonitorService.destroy();
      try { client.disconnect(); } catch { /* ignore */ }
      this.activeSession = null;

      this.emitStatus();
      throw error;
    }
  }

  async stopListen(): Promise<void> {
    if (!this.activeSession) return;

    logger.info('Stopping listen session');

    const session = this.activeSession;
    if (session.smeterInterval) {
      clearInterval(session.smeterInterval);
    }

    session.audioMonitorService.destroy();

    try {
      session.client.disconnect();
    } catch (error) {
      logger.error('Error disconnecting listen session', error);
    }

    session.status.connected = false;
    session.status.isListening = false;
    this.activeSession = null;
    this.emitStatus();

    logger.info('Listen session stopped');
  }

  async tuneListen(options: {
    profileId?: string;
    frequency?: number;
    modulation?: string;
    bandpassLow?: number;
    bandpassHigh?: number;
  }): Promise<void> {
    if (!this.activeSession || !this.activeSession.status.connected) {
      throw new Error('No active listen session');
    }

    const client = this.activeSession.client;
    const status = this.activeSession.status;

    if (options.profileId) {
      const station = this.getStationById(this.activeSession.stationId);
      if (!station) throw new Error('Station not found');
      const profileService = OpenWebRXProfileService.getInstance();
      await profileService.switchProfile(client, station.url, options.profileId, { bypassCooldown: true });
      status.currentProfileId = options.profileId;
    }

    if (options.modulation) {
      client.setModulation(options.modulation);
      status.modulation = options.modulation;
    }

    if (options.frequency) {
      client.setFrequency(options.frequency);
      status.frequency = options.frequency;
    }

    if (options.bandpassLow !== undefined && options.bandpassHigh !== undefined) {
      client.setBandpass(options.bandpassLow, options.bandpassHigh);
    }

    this.emitStatus();
    logger.info('Listen session tuned', options);
  }

  getListenStatus(): OpenWebRXListenStatus | null {
    return this.activeSession?.status ?? null;
  }

  // ===== Private =====

  private emitStatus(): void {
    if (this.activeSession) {
      this.emit('listenStatusChanged', { ...this.activeSession.status });
    }
  }

  destroy(): void {
    if (this.activeSession) {
      this.stopListen().catch(() => {});
    }
  }
}
