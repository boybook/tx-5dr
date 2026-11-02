import { isProcessShuttingDown } from '../utils/process-shutdown.js';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ArmStationTestSchema, StationTestRunSchema, UserRole, type CapabilityState, type StationTestRun, type StationTestStatus } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { ConfigManager } from '../config/config-manager.js';
import { requireRole } from '../auth/authPlugin.js';
import { installAudioDeviceFactory } from '../audio/rtaudio-api.js';
import { installRadioExecutionPolicy } from '../radio/RadioExecutionPolicy.js';
import { PeerSession } from '../simulation/PeerSession.js';
import { VirtualAudioDevice } from './VirtualAudioDevice.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('StationTest');

/** Process-owned test resources. No replacement engine, scheduler or configuration store. */
export class StationTestRuntime {
  readonly sessionId = randomUUID();
  private engine?: DigitalRadioEngine;
  private peer?: PeerSession;
  private error?: string;
  private stopped = false;
  private wasReady = false;
  private connectionGeneration?: number;
  private providerDefinition?: unknown;
  private armedUntil: number | null = null;
  private baselinePower?: number;
  private baselineRadioMode?: string;
  private modeCheck?: Promise<void>;
  private lastModeCheck = 0;
  private arming = false;
  private powerBusy = false;
  private lastPowerCheck = 0;
  private powerEvidence: StationTestStatus['powerEvidence'] = 'not-applicable';
  private timer?: NodeJS.Timeout;
  private readonly uninstall: Array<() => void> = [];
  private readonly target;
  private readonly deadline: number;
  private stopPromise?: Promise<void>;

  constructor(readonly config: StationTestRun) {
    const manager = ConfigManager.getInstance();
    if (manager.getActiveProfileId() !== config.profileId) throw new Error('Station test Profile mismatch');
    this.target = manager.getRadioConfig();
    this.deadline = Date.now() + config.maxDurationMs;
    if (manager.getPSKReporterConfig().enabled || manager.getRigctldConfig().enabled) throw new Error('Station tests require external reporters and rigctld bridge disabled');
    if (!config.hardware) {
      if (this.target.type !== 'serial' || this.target.serial?.rigModel !== 1 || this.target.pttMethod !== 'cat'
        || this.target.pttPort || this.target.cwKeyPort || this.target.serial.serialNumber) throw new Error('Headless station tests require native Hamlib Dummy with CAT PTT');
      this.uninstall.push(installAudioDeviceFactory(() => new VirtualAudioDevice((at, rate, count) => this.peer?.render(at, rate, count) ?? new Float32Array(count))));
    }
    this.uninstall.push(installRadioExecutionPolicy({ assert: operation => {
      if (operation.kind === 'connect') {
        if (this.stopped || !isDeepStrictEqual(operation.config, this.target)) throw new Error('Connection target is outside the station test session');
      } else if (operation.kind === 'transmit') {
        if (!['digital', 'ptt', 'test'].includes(operation.source)) throw new Error('This station test only permits digital transmission');
        if (this.stopped || this.error || !this.contextMatches() || (this.config.hardware && (!this.armedUntil || Date.now() >= this.armedUntil))) {
          throw new Error('Station test transmission is not authorized');
        }
      } else if (config.hardware && operation.kind === 'mode-write' && this.armedUntil) {
        const error = new Error('Radio mode writes invalidate station test permission');
        this.fail(error);
        throw error;
      } else if (config.hardware && (operation.kind === 'power' || (operation.kind === 'capability-write' && operation.id === 'rf_power'))) {
        throw new Error('Physical power changes are prohibited during a hardware test');
      }
    }, validateTransmission: config.hardware ? () => this.checkRadioMode() : undefined }));
  }
  async attach(engine: DigitalRadioEngine, server: FastifyInstance, onOwnerLost?: () => void): Promise<void> {
    this.engine = engine;
    this.providerDefinition = engine.pluginManager.getLoadedPlugin(this.config.scenarioProvider)?.definition;
    this.peer = new PeerSession({ config: this.config, artifactDir: this.config.artifactDir, now: () => engine.getClockSource().now(),
      scenarios: engine.pluginManager.getSimulationScenarios(this.config.scenarioProvider),
      channel: () => ({ connected: this.contextMatches(), frequency: engine.getRadioManager().getKnownFrequency() ?? 0, mode: engine.getCurrentMode().name }),
      fail: error => this.fail(error),
    });
    await this.peer.start();
    engine.getAudioStreamManager().on('txAudioObservation', this.peer.observe);
    if (this.config.hardware) engine.getAudioStreamManager().setBasebandContribution((at, rate, count) => this.peer!.render(at, rate, count));
    const radio = engine.getRadioManager();
    if (radio.isConnected()) this.connectionGeneration = radio.getConnectionGeneration();
    const connected = () => {
      const generation = radio.getConnectionGeneration();
      if (this.connectionGeneration !== undefined && this.connectionGeneration !== generation) this.fail(new Error('Radio connection generation changed'));
      else this.connectionGeneration = generation;
    };
    const disconnect = () => { if (this.connectionGeneration !== undefined && !isProcessShuttingDown()) this.fail(new Error('Radio connection ended')); };
    radio.on('connected', connected);
    radio.on('disconnected', disconnect);
    const modeChanged = (state: CapabilityState) => {
      if (!this.armedUntil || state.id !== 'radio_mode') return;
      if (!state.supported || state.availability === 'unavailable'
        || typeof state.value !== 'string' || state.value.trim().toUpperCase() !== this.baselineRadioMode) {
        this.fail(new Error('Station test radio mode changed or became unavailable'));
      }
    };
    radio.on('capabilityChanged', modeChanged);
    this.uninstall.push(() => { radio.off('connected', connected); radio.off('disconnected', disconnect); radio.off('capabilityChanged', modeChanged); });
    const onPluginUnload = () => {
      if (engine.pluginManager.getLoadedPlugin(this.config.scenarioProvider)?.definition !== this.providerDefinition) this.fail(new Error('Peer provider unloaded'));
    };
    // Provider presence and frozen definition are checked throughout the session.
    this.timer = setInterval(() => {
      if (this.stopped) return;
      if (isProcessShuttingDown()) { void this.stop('server shutdown').catch(error => logger.error('Station shutdown failed', error)); return; }
      onPluginUnload();
      if (Date.now() >= this.deadline || (this.armedUntil && Date.now() >= this.armedUntil)) this.fail(new Error('Station test permission expired'));
      if (this.wasReady && !this.contextMatches()) this.fail(new Error('Station test operating context changed'));
      if (this.status().phase === 'ready' || this.status().phase === 'armed') this.wasReady = true;
      if (this.config.hardware && this.armedUntil && !this.modeCheck && Date.now() - this.lastModeCheck >= 1000) {
        void this.checkRadioMode().catch(() => { /* checkRadioMode revokes the session on failure. */ });
      }
      if (this.config.hardware && this.armedUntil && this.baselinePower !== undefined && !this.powerBusy && Date.now() - this.lastPowerCheck >= 1000) {
        this.powerBusy = true; this.lastPowerCheck = Date.now();
        void this.readPower().then(value => {
          if (value !== this.baselinePower) throw new Error('Manually set RF power changed');
        }).catch(error => this.fail(error as Error)).finally(() => { this.powerBusy = false; });
      }
    }, 100);
    process.stdin.resume();
    const ownerEnded = () => {
      this.fail(new Error('Station test owner disconnected'));
      void this.stop('owner disconnected').finally(() => onOwnerLost?.()).catch(error => logger.error('Owner-loss cleanup failed', error));
    };
    process.stdin.once('end', ownerEnded);
    this.uninstall.push(() => process.stdin.off('end', ownerEnded));
    const admin = requireRole(UserRole.ADMIN);
    server.get('/api/station-test/status', { onRequest: admin }, async () => this.status());
    server.post('/api/station-test/arm', { onRequest: admin }, async request => {
      const body = ArmStationTestSchema.parse(request.body);
      if (!this.config.hardware || this.arming || body.sessionId !== this.sessionId || this.status().phase !== 'ready') throw new Error('Hardware test session is not ready');
      this.arming = true;
      try {
        const mode = await this.readRadioMode();
        const power = engine.getRadioManager().getCapabilityState('rf_power');
        if (power?.supported) {
          this.baselinePower = await this.readPower(); this.powerEvidence = 'readback';
        } else this.powerEvidence = 'manual-confirmation';
        if (await this.readRadioMode() !== mode || !this.contextMatches()) throw new Error('Hardware context changed while arming');
        this.baselineRadioMode = mode;
        this.lastModeCheck = Date.now();
        this.wasReady = true;
        this.armedUntil = this.deadline;
        return this.status();
      } catch (error) {
        this.fail(error as Error);
        throw error;
      } finally {
        this.arming = false;
      }
    });
    server.post('/api/station-test/stop', { onRequest: admin }, async () => { await this.stop('administrator stopped test'); return this.status(); });
    server.addHook('onClose', async () => { await this.stop('server closed'); for (const dispose of this.uninstall.reverse()) dispose(); });
  }
  private contextMatches(): boolean {
    const e = this.engine;
    return Boolean(e && !this.stopped && !this.error
      && e.pluginManager.getLoadedPlugin(this.config.scenarioProvider)?.definition === this.providerDefinition
      && ConfigManager.getInstance().getActiveProfileId() === this.config.profileId
      && isDeepStrictEqual(ConfigManager.getInstance().getRadioConfig(), this.target)
      && e.getRadioManager().isConnected()
      && (this.connectionGeneration === undefined || e.getRadioManager().getConnectionGeneration() === this.connectionGeneration)
      && e.getCurrentMode().name === this.config.mode
      && Math.abs((e.getRadioManager().getKnownFrequency() ?? 0) - this.config.dialFrequencyHz) < 1);
  }
  private async readPower(): Promise<number> {
    const conn = this.engine?.getRadioManager().getCurrentConnection();
    if (!conn?.getRFPower) throw new Error('RF power readback unavailable');
    const value = await conn.getRFPower();
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('RF power readback invalid');
    return value;
  }
  private async readRadioMode(): Promise<string> {
    const result = await this.engine!.getRadioManager().getMode();
    const mode = typeof result.mode === 'string' ? result.mode.trim().toUpperCase() : '';
    if (!mode || mode === 'UNKNOWN') throw new Error('Radio mode readback unavailable');
    return mode;
  }
  private checkRadioMode(): Promise<void> {
    if (this.modeCheck) return this.modeCheck;
    const permission = this.armedUntil;
    this.lastModeCheck = Date.now();
    const check = (async () => {
      const mode = await this.readRadioMode();
      if (!permission || this.armedUntil !== permission || !this.contextMatches() || Date.now() >= permission) {
        throw new Error('Station test permission changed during mode readback');
      }
      if (mode !== this.baselineRadioMode) throw new Error(`Station test radio mode changed: ${this.baselineRadioMode} -> ${mode}`);
    })().catch(error => {
      this.fail(error as Error);
      throw error;
    }).finally(() => { if (this.modeCheck === check) this.modeCheck = undefined; });
    this.modeCheck = check;
    return check;
  }
  status(): StationTestStatus {
    const connected = this.engine?.getRadioManager().isConnected() ?? false;
    const ready = this.engine?.getAudioStreamManager().getAudioPlaybackReadiness('digital').ready ?? false;
    return { sessionId: this.sessionId, phase: this.error ? 'failed' : this.stopped ? 'stopped' : this.armedUntil ? 'armed' : connected && ready && this.contextMatches() && Boolean(this.peer) ? 'ready' : 'starting',
      hardware: this.config.hardware, radioConnected: connected, audioReady: ready, peerReady: Boolean(this.peer) && !this.stopped,
      expiresAt: this.armedUntil, powerEvidence: this.powerEvidence, error: this.error, tracePath: this.peer?.getTracePath() ?? '' };
  }
  private fail(error: Error): void {
    if (this.error || this.stopped) return;
    this.error = error.message; logger.error('Station test failed', error);
    void this.stop(error.message).catch(stopError => logger.error('Station test cleanup failed', stopError));
  }
  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.armedUntil = null;
    if (this.timer) clearInterval(this.timer);
    this.stopPromise = (async () => {
      if (this.engine && this.peer) {
        this.engine.getAudioStreamManager().off('txAudioObservation', this.peer.observe);
        this.engine.getAudioStreamManager().setBasebandContribution(undefined);
        const errors: unknown[] = [];
        try { await this.engine.forceStopTransmission(); } catch (error) { errors.push(error); }
        try { await this.peer.stop(reason); } catch (error) { errors.push(error); }
        try { await this.engine.stop(); } catch (error) { errors.push(error); }
        if (errors.length) {
          const error = new AggregateError(errors, 'Station test cleanup failed');
          this.error ??= error.message;
          throw error;
        }
      }
    })();
    return this.stopPromise;
  }
}

export async function prepareStationTest(): Promise<StationTestRuntime | undefined> {
  const file = process.env.TX5DR_STATION_TEST_SPEC;
  if (!file) return undefined;
  for (const key of ['TX5DR_CONFIG_DIR', 'TX5DR_DATA_DIR', 'TX5DR_LOGS_DIR', 'TX5DR_CACHE_DIR', 'TX5DR_PLUGINS_DIR', 'TX5DR_PLUGIN_DATA_DIR']) {
    if (!process.env[key]) throw new Error(`Station test requires isolated ${key}`);
  }
  return new StationTestRuntime(StationTestRunSchema.parse(JSON.parse(await readFile(file, 'utf8'))));
}
