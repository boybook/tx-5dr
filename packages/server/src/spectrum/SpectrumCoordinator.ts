import { EventEmitter } from 'eventemitter3';
import {
  getSpectrumPresetDefinition,
  type SpectrumCapabilities,
  type SpectrumFrame,
  type SpectrumKind,
  type SpectrumSourceAvailability,
  type SupportedRig,
} from '@tx5dr/contracts';
import { ConfigManager } from '../config/config-manager.js';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import { PhysicalRadioManager } from '../radio/PhysicalRadioManager.js';
import { createLogger } from '../utils/logger.js';
import { SPECTRUM_DISPLAY_BIN_COUNT, createOpenWebRXSpectrumFrame, normalizeSpectrumFrame } from './spectrumUtils.js';
import type { OpenWebRXSpectrumFrame } from '@openwebrx-js/api';
import type { OpenWebRXAudioAdapter } from '../openwebrx/OpenWebRXAudioAdapter.js';
import { RadioSpectrumSourceRegistry, type RadioSpectrumSource } from './RadioSpectrumSource.js';
import {
  HamlibSpectrumSourceProvider,
  IcomWlanSpectrumSourceProvider,
  TciIqSpectrumSourceProvider,
} from './BuiltInRadioSpectrumSources.js';

const logger = createLogger('SpectrumCoordinator');

const RADIO_SOURCE_STOP_DELAY_MS = 2000;

export interface SpectrumCoordinatorEvents {
  frame: (frame: SpectrumFrame) => void;
  capabilitiesChanged: (capabilities: SpectrumCapabilities) => void;
}

interface OpenWebRXSpectrumCapableAdapter extends Pick<OpenWebRXAudioAdapter,
  'isConnected' | 'getLatestSpectrumFrame' | 'on' | 'off'
> {}

export class SpectrumCoordinator extends EventEmitter<SpectrumCoordinatorEvents> {
  private readonly subscriptions = new Map<string, SpectrumKind | null>();
  private radioStopTimer: NodeJS.Timeout | null = null;
  private currentOpenWebRXAdapter: OpenWebRXSpectrumCapableAdapter | null = null;
  private currentRegisteredRadioSource: RadioSpectrumSource | null = null;
  private readonly registeredSourceRegistry: RadioSpectrumSourceRegistry;
  private readonly onOpenWebRXSpectrumFrame = (frame: OpenWebRXSpectrumFrame) => {
    if (this.getSubscriberCount('openwebrx-sdr') === 0) {
      return;
    }

    const profileId = ConfigManager.getInstance().getActiveProfileId();
    const normalizedFrame = createOpenWebRXSpectrumFrame(frame, profileId);
    if (normalizedFrame) {
      this.emit('frame', normalizedFrame);
    }
  };
  private readonly onRegisteredRadioFrame = (frame: SpectrumFrame) => {
    this.emit('frame', {
      ...frame,
      meta: { ...frame.meta, profileId: ConfigManager.getInstance().getActiveProfileId() },
    });
  };

  constructor(private readonly engine: DigitalRadioEngine) {
    super();
    this.registeredSourceRegistry = new RadioSpectrumSourceRegistry([
      new IcomWlanSpectrumSourceProvider(),
      new TciIqSpectrumSourceProvider(),
      new HamlibSpectrumSourceProvider(
        async () => PhysicalRadioManager.listSupportedRigs() as Promise<SupportedRig[]>,
      ),
    ]);

    const handleSourceTopologyChanged = () => {
      void this.emitCapabilitiesChanged();
      void this.refreshSourceBindings();
    };

    this.engine.on('radioStatusChanged', handleSourceTopologyChanged);
    this.engine.on('modeChanged', handleSourceTopologyChanged as never);
    this.engine.on('profileChanged', handleSourceTopologyChanged as never);
    this.engine.on('profileListUpdated', handleSourceTopologyChanged as never);
    this.engine.on('openwebrxConnectionChanged' as never, handleSourceTopologyChanged as never);
    this.engine.on('openwebrxProfileChanged' as never, handleSourceTopologyChanged as never);
    this.engine.getSpectrumScheduler().on('spectrumReady', (frame) => {
      if (this.getSubscriberCount('audio') === 0) {
        return;
      }

      const normalized = this.normalizeAudioFrame(frame);
      this.emit('frame', normalized);
    });
    this.engine.getSpectrumScheduler().on('configChanged', () => {
      void this.emitCapabilitiesChanged();
    });
  }

  async getCapabilities(): Promise<SpectrumCapabilities> {
    const profileId = ConfigManager.getInstance().getActiveProfileId();
    const config = this.engine.getRadioManager().getConfig();
    const radioSource = await this.getRadioSourceAvailability();
    const openWebRXSource = this.getOpenWebRXSourceAvailability();
    const defaultKind = this.getDefaultSpectrumKind(config.type, radioSource.available, openWebRXSource.available);
    const scheduler = this.engine.getSpectrumScheduler() as SpectrumCoordinatorSchedulerLike;
    const balanced = getSpectrumPresetDefinition('balanced');
    const renderConfig = scheduler.getRenderConfig?.() ?? {
      ...balanced,
      revision: 0,
    };
    const audioSource: SpectrumSourceAvailability = {
      kind: 'audio',
      supported: true,
      available: true,
      defaultSelected: defaultKind === 'audio',
      displayBinCount: renderConfig.displayBinCount,
      sourceBinCount: renderConfig.displayBinCount,
      supportsWaterfall: true,
      frequencyRangeMode: 'baseband',
    };

    radioSource.defaultSelected = defaultKind === 'radio-sdr';
    openWebRXSource.defaultSelected = defaultKind === 'openwebrx-sdr';

    return {
      profileId,
      defaultKind,
      sources: [radioSource, openWebRXSource, audioSource],
      renderConfig,
      presets: (['responsive', 'balanced', 'fine'] as const).map(getSpectrumPresetDefinition),
    };
  }

  async setConnectionSubscription(connectionId: string, kind: SpectrumKind | null): Promise<void> {
    const previousKind = this.subscriptions.get(connectionId) ?? null;
    if (previousKind === kind) {
      this.updateAudioSubscriptionState();
      return;
    }

    this.subscriptions.set(connectionId, kind);
    this.updateAudioSubscriptionState();
    await this.updateRadioSubscriptionState();
    this.updateOpenWebRXSpectrumState();
  }

  async removeConnection(connectionId: string): Promise<void> {
    if (!this.subscriptions.has(connectionId)) {
      return;
    }

    this.subscriptions.delete(connectionId);
    this.updateAudioSubscriptionState();
    await this.updateRadioSubscriptionState();
    this.updateOpenWebRXSpectrumState();
  }

  getConnectionSubscription(connectionId: string): SpectrumKind | null {
    return this.subscriptions.get(connectionId) ?? null;
  }

  getSubscribedConnectionIds(kind: SpectrumKind): string[] {
    return Array.from(this.subscriptions.entries())
      .filter(([, selectedKind]) => selectedKind === kind)
      .map(([connectionId]) => connectionId);
  }

  getActiveRadioSpectrumSource(): RadioSpectrumSource | null {
    return this.currentRegisteredRadioSource;
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

  private updateOpenWebRXSpectrumState(): void {
    const adapter = this.engine.getOpenWebRXAudioAdapter();
    const shouldAttach = this.getSubscriberCount('openwebrx-sdr') > 0 && adapter?.isConnected();

    if (!shouldAttach) {
      if (this.currentOpenWebRXAdapter) {
        this.currentOpenWebRXAdapter.off('spectrumFrame', this.onOpenWebRXSpectrumFrame);
        this.currentOpenWebRXAdapter = null;
      }
      return;
    }

    if (this.currentOpenWebRXAdapter !== adapter && adapter) {
      if (this.currentOpenWebRXAdapter) {
        this.currentOpenWebRXAdapter.off('spectrumFrame', this.onOpenWebRXSpectrumFrame);
      }

      this.currentOpenWebRXAdapter = adapter;
      adapter.on('spectrumFrame', this.onOpenWebRXSpectrumFrame);

      const latestFrame = adapter.getLatestSpectrumFrame();
      if (latestFrame) {
        this.onOpenWebRXSpectrumFrame(latestFrame);
      }
    }
  }

  private async refreshSourceBindings(): Promise<void> {
    this.updateAudioSubscriptionState();
    await this.updateRadioSubscriptionState();
    this.updateOpenWebRXSpectrumState();
  }

  private async startRadioScopeIfNeeded(): Promise<void> {
    const radioManager = this.engine.getRadioManager();
    const resolution = await this.registeredSourceRegistry.resolve({
      activeConnection: radioManager.getActiveConnection(),
      icomWlanConnection: radioManager.getIcomWlanManager(),
      connected: radioManager.isConnected(),
      config: radioManager.getConfig(),
    });
    if (resolution?.source) {
      await this.startRegisteredRadioSource(resolution.source);
      return;
    }

    await this.stopRadioScope();
    await this.emitCapabilitiesChanged();
  }

  private async stopRadioScope(): Promise<void> {
    if (this.currentRegisteredRadioSource) {
      try {
        await this.currentRegisteredRadioSource.stop();
      } catch (error) {
        logger.warn('Failed to stop registered radio spectrum source', error);
      }
      this.currentRegisteredRadioSource = null;
      await this.emitCapabilitiesChanged();
    }
  }

  private normalizeAudioFrame(frame: SpectrumFrame): SpectrumFrame {
    const bytes = Buffer.from(frame.binaryData.data, 'base64');
    const int16View = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / Int16Array.BYTES_PER_ELEMENT));
    const preserved = Int16Array.from(int16View);

    return normalizeSpectrumFrame({
      ...frame,
      binaryData: {
        data: preserved,
        scale: frame.binaryData.format.scale,
        offset: frame.binaryData.format.offset,
      },
      meta: {
        ...frame.meta,
        displayBinCount: preserved.length,
      },
    });
  }

  private async getRadioSourceAvailability(): Promise<SpectrumSourceAvailability> {
    const radioManager = this.engine.getRadioManager();
    const config = radioManager.getConfig();
    const resolution = await this.registeredSourceRegistry.resolve({
      activeConnection: radioManager.getActiveConnection(),
      icomWlanConnection: radioManager.getIcomWlanManager(),
      connected: radioManager.isConnected(),
      config,
    });
    if (resolution) return resolution.availability;

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

  private async emitCapabilitiesChanged(): Promise<void> {
    this.emit('capabilitiesChanged', await this.getCapabilities());
  }

  private getOpenWebRXSourceAvailability(): SpectrumSourceAvailability {
    const adapter = this.engine.getOpenWebRXAudioAdapter();
    const connected = adapter?.isConnected() ?? false;
    const configured = adapter !== null;

    return {
      kind: 'openwebrx-sdr',
      supported: configured,
      available: connected,
      defaultSelected: false,
      reason: configured ? (connected ? undefined : 'openwebrx_disconnected') : 'openwebrx_input_not_active',
      sourceBinCount: null,
      displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
      supportsWaterfall: true,
      frequencyRangeMode: 'absolute',
    };
  }

  private getDefaultSpectrumKind(
    configType: ReturnType<PhysicalRadioManager['getConfig']>['type'],
    radioAvailable: boolean,
    openWebRXAvailable: boolean
  ): SpectrumKind {
    if (openWebRXAvailable) {
      return 'openwebrx-sdr';
    }

    if (radioAvailable) {
      return 'radio-sdr';
    }

    if (!radioAvailable) {
      return 'audio';
    }

    return 'audio';
  }

  private async startRegisteredRadioSource(source: RadioSpectrumSource): Promise<void> {
    if (this.currentRegisteredRadioSource === source) return;
    await this.stopRadioScope();
    try {
      await source.start(this.onRegisteredRadioFrame);
      this.currentRegisteredRadioSource = source;
    } catch (error) {
      logger.error('Failed to start registered radio spectrum source', error);
      await source.stop().catch(() => undefined);
      this.currentRegisteredRadioSource = null;
    }
    await this.emitCapabilitiesChanged();
  }
}

interface SpectrumCoordinatorSchedulerLike {
  getRenderConfig?: () => SpectrumCapabilities['renderConfig'];
}
