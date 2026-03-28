import { EventEmitter } from 'eventemitter3';
import type { SpectrumCapabilities, SpectrumFrame, SpectrumKind, SpectrumSourceAvailability, SupportedRig } from '@tx5dr/contracts';
import type { SpectrumLine, SpectrumSupportSummary } from 'hamlib';
import type { IRadioConnection } from '../radio/connections/IRadioConnection.js';
import { RadioConnectionType } from '../radio/connections/IRadioConnection.js';
import { HamlibConnection } from '../radio/connections/HamlibConnection.js';
import { ConfigManager } from '../config/config-manager.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { createLogger } from '../utils/logger.js';
import { SPECTRUM_DISPLAY_BIN_COUNT, createHamlibRadioSpectrumFrame, createRadioSpectrumFrame, normalizeSpectrumFrame, resampleBins } from './spectrumUtils.js';
import type { IcomScopeFrame } from 'icom-wlan-node';

const logger = createLogger('SpectrumCoordinator');

const RADIO_SOURCE_STOP_DELAY_MS = 2000;

export interface SpectrumCoordinatorEvents {
  frame: (frame: SpectrumFrame) => void;
  capabilitiesChanged: (capabilities: SpectrumCapabilities) => void;
}

interface ScopeCapableConnection {
  addScopeFrameListener(listener: (frame: IcomScopeFrame) => void): void;
  removeScopeFrameListener(listener: (frame: IcomScopeFrame) => void): void;
  enableScopeStream(): Promise<void>;
  disableScopeStream(): Promise<void>;
}

interface OfficialSpectrumCapableHamlibConnection extends HamlibConnection {
  getSpectrumSupportSummary(): Promise<SpectrumSupportSummary>;
  startManagedSpectrum(listener: (line: SpectrumLine) => void): Promise<void>;
  stopManagedSpectrum(): Promise<void>;
}

export class SpectrumCoordinator extends EventEmitter<SpectrumCoordinatorEvents> {
  private readonly subscriptions = new Map<string, SpectrumKind | null>();
  private radioStopTimer: NodeJS.Timeout | null = null;
  private currentScopeConnection: ScopeCapableConnection | null = null;
  private currentHamlibScopeConnection: OfficialSpectrumCapableHamlibConnection | null = null;
  private readonly onScopeFrame = (frame: IcomScopeFrame) => {
    const profileId = ConfigManager.getInstance().getActiveProfileId();
    this.emit('frame', createRadioSpectrumFrame(frame, profileId, 'ICOM WLAN'));
  };
  private readonly onHamlibSpectrumLine = (line: SpectrumLine) => {
    const profileId = ConfigManager.getInstance().getActiveProfileId();
    this.emit('frame', createHamlibRadioSpectrumFrame(line, profileId, 'ICOM Serial (Hamlib)'));
  };

  constructor(private readonly engine: DigitalRadioEngine) {
    super();

    const triggerCapabilitiesRefresh = () => {
      void this.emitCapabilitiesChanged();
    };

    this.engine.on('radioStatusChanged', triggerCapabilitiesRefresh);
    this.engine.on('profileChanged', triggerCapabilitiesRefresh as never);
    this.engine.on('profileListUpdated', triggerCapabilitiesRefresh as never);
    this.engine.getSpectrumScheduler().on('spectrumReady', (frame) => {
      if (this.getSubscriberCount('audio') === 0) {
        return;
      }

      const resampled = this.normalizeAudioFrame(frame);
      this.emit('frame', resampled);
    });
  }

  async getCapabilities(): Promise<SpectrumCapabilities> {
    const profileId = ConfigManager.getInstance().getActiveProfileId();
    const config = this.engine.getRadioManager().getConfig();
    const radioSource = await this.getRadioSourceAvailability();
    const defaultKind = this.getDefaultSpectrumKind(config.type, radioSource.available);
    const audioSource: SpectrumSourceAvailability = {
      kind: 'audio',
      supported: true,
      available: true,
      defaultSelected: defaultKind === 'audio',
      displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      sourceBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      supportsWaterfall: true,
      frequencyRangeMode: 'baseband',
    };

    radioSource.defaultSelected = defaultKind === 'radio-sdr';

    return {
      profileId,
      defaultKind,
      sources: [radioSource, audioSource],
    };
  }

  async setConnectionSubscription(connectionId: string, kind: SpectrumKind | null): Promise<void> {
    const previousKind = this.subscriptions.get(connectionId) ?? null;
    if (previousKind === kind) {
      return;
    }

    this.subscriptions.set(connectionId, kind);
    this.updateAudioSubscriptionState();
    await this.updateRadioSubscriptionState();
  }

  async removeConnection(connectionId: string): Promise<void> {
    if (!this.subscriptions.has(connectionId)) {
      return;
    }

    this.subscriptions.delete(connectionId);
    this.updateAudioSubscriptionState();
    await this.updateRadioSubscriptionState();
  }

  getConnectionSubscription(connectionId: string): SpectrumKind | null {
    return this.subscriptions.get(connectionId) ?? null;
  }

  getSubscribedConnectionIds(kind: SpectrumKind): string[] {
    return Array.from(this.subscriptions.entries())
      .filter(([, selectedKind]) => selectedKind === kind)
      .map(([connectionId]) => connectionId);
  }

  private getSubscriberCount(kind: SpectrumKind): number {
    let count = 0;
    for (const selectedKind of this.subscriptions.values()) {
      if (selectedKind === kind) {
        count++;
      }
    }
    return count;
  }

  private updateAudioSubscriptionState(): void {
    this.engine.getSpectrumScheduler().setSubscriptionActive(this.getSubscriberCount('audio') > 0);
  }

  private async updateRadioSubscriptionState(): Promise<void> {
    const count = this.getSubscriberCount('radio-sdr');

    if (count > 0) {
      if (this.radioStopTimer) {
        clearTimeout(this.radioStopTimer);
        this.radioStopTimer = null;
      }
      await this.startRadioScopeIfNeeded();
      return;
    }

    if (this.radioStopTimer) {
      return;
    }

    this.radioStopTimer = setTimeout(() => {
      this.radioStopTimer = null;
      void this.stopRadioScope();
    }, RADIO_SOURCE_STOP_DELAY_MS);
  }

  private async startRadioScopeIfNeeded(): Promise<void> {
    const radioManager = this.engine.getRadioManager();
    const scopeConnection = radioManager.getIcomWlanManager() as ScopeCapableConnection | null;

    if (scopeConnection) {
      await this.startIcomScope(scopeConnection);
      return;
    }

    const activeConnection = radioManager.getActiveConnection();
    if (this.isHamlibSerialScopeConnection(activeConnection)) {
      await this.startHamlibScope(activeConnection);
      return;
    }

    await this.stopRadioScope();
    await this.emitCapabilitiesChanged();
  }

  private async stopRadioScope(): Promise<void> {
    let changed = false;

    if (this.currentScopeConnection) {
      try {
        await this.currentScopeConnection.disableScopeStream();
      } catch (error) {
        logger.warn('Failed to disable ICOM WLAN scope stream', error);
      }

      this.currentScopeConnection.removeScopeFrameListener(this.onScopeFrame);
      this.currentScopeConnection = null;
      changed = true;
    }

    if (this.currentHamlibScopeConnection) {
      try {
        await this.currentHamlibScopeConnection.stopManagedSpectrum();
      } catch (error) {
        logger.warn('Failed to stop Hamlib official spectrum stream', error);
      }

      this.currentHamlibScopeConnection = null;
      changed = true;
    }

    if (changed) {
      await this.emitCapabilitiesChanged();
    }
  }

  private normalizeAudioFrame(frame: SpectrumFrame): SpectrumFrame {
    const bytes = Buffer.from(frame.binaryData.data, 'base64');
    const int16View = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT));
    const resampled = resampleBins(int16View, SPECTRUM_DISPLAY_BIN_COUNT);

    return normalizeSpectrumFrame({
      ...frame,
      binaryData: {
        data: resampled,
        scale: frame.binaryData.format.scale,
        offset: frame.binaryData.format.offset,
      },
      meta: {
        ...frame.meta,
        displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      },
    });
  }

  private async getRadioSourceAvailability(): Promise<SpectrumSourceAvailability> {
    const radioManager = this.engine.getRadioManager();
    const config = radioManager.getConfig();

    if (config.type === 'icom-wlan') {
      const connected = radioManager.isConnected();
      return {
        kind: 'radio-sdr',
        supported: true,
        available: connected,
        defaultSelected: false,
        reason: connected ? undefined : 'radio_disconnected',
        sourceBinCount: null,
        displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
        supportsWaterfall: true,
        frequencyRangeMode: 'absolute',
      };
    }

    if (config.type === 'serial') {
      const supportedRig = await this.lookupSupportedRig(config.serial?.rigModel);
      const isIcom = supportedRig?.mfgName.toUpperCase() === 'ICOM';
      const connected = radioManager.isConnected();
      const activeConnection = radioManager.getActiveConnection();

      if (!isIcom) {
        return {
          kind: 'radio-sdr',
          supported: false,
          available: false,
          defaultSelected: false,
          reason: 'radio_sdr_only_supported_for_icom_serial',
          sourceBinCount: null,
          displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
          supportsWaterfall: true,
          frequencyRangeMode: 'absolute',
        };
      }

      if (!connected || !this.isHamlibSerialScopeConnection(activeConnection)) {
        return {
          kind: 'radio-sdr',
          supported: true,
          available: false,
          defaultSelected: false,
          reason: connected ? 'hamlib_official_spectrum_api_unavailable' : 'radio_disconnected',
          sourceBinCount: null,
          displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
          supportsWaterfall: true,
          frequencyRangeMode: 'absolute',
        };
      }

      try {
        const summary = await activeConnection.getSpectrumSupportSummary();
        return {
          kind: 'radio-sdr',
          supported: summary.supported,
          available: summary.supported,
          defaultSelected: false,
          reason: summary.supported ? undefined : 'hamlib_official_spectrum_not_supported',
          sourceBinCount: null,
          displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
          supportsWaterfall: true,
          frequencyRangeMode: 'absolute',
        };
      } catch {
        return {
          kind: 'radio-sdr',
          supported: false,
          available: false,
          defaultSelected: false,
          reason: 'hamlib_official_spectrum_probe_failed',
          sourceBinCount: null,
          displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
          supportsWaterfall: true,
          frequencyRangeMode: 'absolute',
        };
      }
    }

    return {
      kind: 'radio-sdr',
      supported: false,
      available: false,
      defaultSelected: false,
      reason: config.type === 'network'
        ? 'rigctld_not_supported'
        : 'radio_sdr_not_supported_for_current_profile',
      sourceBinCount: null,
      displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      supportsWaterfall: true,
      frequencyRangeMode: 'absolute',
    };
  }

  private async lookupSupportedRig(rigModel?: number): Promise<SupportedRig | null> {
    if (!rigModel) {
      return null;
    }

    const rigs = await PhysicalRadioManager.listSupportedRigs() as SupportedRig[];
    return rigs.find(rig => rig.rigModel === rigModel) ?? null;
  }

  private async emitCapabilitiesChanged(): Promise<void> {
    this.emit('capabilitiesChanged', await this.getCapabilities());
  }

  private getDefaultSpectrumKind(
    configType: ReturnType<PhysicalRadioManager['getConfig']>['type'],
    radioAvailable: boolean
  ): SpectrumKind {
    if (!radioAvailable) {
      return 'audio';
    }

    return configType === 'icom-wlan' ? 'radio-sdr' : 'audio';
  }

  private isHamlibSerialScopeConnection(connection: IRadioConnection | null): connection is OfficialSpectrumCapableHamlibConnection {
    return connection instanceof HamlibConnection
      && this.engine.getRadioManager().getConfig().type === 'serial'
      && connection.getType() === RadioConnectionType.HAMLIB;
  }

  private async startIcomScope(scopeConnection: ScopeCapableConnection): Promise<void> {
    if (this.currentHamlibScopeConnection) {
      await this.stopRadioScope();
    }

    if (this.currentScopeConnection !== scopeConnection) {
      await this.stopRadioScope();
      this.currentScopeConnection = scopeConnection;
      this.currentScopeConnection.addScopeFrameListener(this.onScopeFrame);
    }

    try {
      await this.currentScopeConnection.enableScopeStream();
    } catch (error) {
      logger.error('Failed to enable ICOM WLAN scope stream', error);
    }

    await this.emitCapabilitiesChanged();
  }

  private async startHamlibScope(connection: OfficialSpectrumCapableHamlibConnection): Promise<void> {
    if (this.currentScopeConnection) {
      await this.stopRadioScope();
    }

    if (this.currentHamlibScopeConnection === connection) {
      return;
    }

    await this.stopRadioScope();
    try {
      await connection.startManagedSpectrum(this.onHamlibSpectrumLine);
      this.currentHamlibScopeConnection = connection;
    } catch (error) {
      logger.error('Failed to start Hamlib official spectrum stream', error);
      try {
        await connection.stopManagedSpectrum();
      } catch {}
      this.currentHamlibScopeConnection = null;
    }

    await this.emitCapabilitiesChanged();
  }
}
