import type { SpectrumFrame, SpectrumSourceAvailability, SupportedRig } from '@tx5dr/contracts';
import type { IcomScopeFrame } from 'icom-wlan-node';
import type { ManagedSpectrumConfig, SpectrumLine, SpectrumSupportSummary } from 'hamlib/spectrum';
import { HamlibConnection } from '../radio/connections/HamlibConnection.js';
import { IcomWlanConnection } from '../radio/connections/IcomWlanConnection.js';
import { TciConnection } from '../radio/connections/TciConnection.js';
import { resolveHamlibSpectrumRuntimeConfig } from './hamlibSpectrumConfig.js';
import {
  createHamlibRadioSpectrumFrame,
  createRadioSpectrumFrame,
  SPECTRUM_DISPLAY_BIN_COUNT,
} from './spectrumUtils.js';
import { TciIqSpectrumSource } from './TciIqSpectrumSource.js';
import type {
  RadioSpectrumSource,
  RadioSpectrumSourceProvider,
  RadioSpectrumSourceProviderContext,
  RadioSpectrumSourceResolution,
  RadioSpectrumSpanController,
} from './RadioSpectrumSource.js';

const ICOM_WLAN_SCOPE_FRAME_MIN_INTERVAL_MS = 250;

interface ScopeCapableIcomConnection extends IcomWlanConnection {
  addScopeFrameListener(listener: (frame: IcomScopeFrame) => void): void;
  removeScopeFrameListener(listener: (frame: IcomScopeFrame) => void): void;
  enableScopeStream(): Promise<void>;
  disableScopeStream(): Promise<void>;
}

interface SpectrumCapableHamlibConnection extends HamlibConnection {
  getSpectrumSupportSummary(): Promise<SpectrumSupportSummary>;
  startManagedSpectrum(listener: (line: SpectrumLine) => void, config?: ManagedSpectrumConfig): Promise<void>;
  stopManagedSpectrum(): Promise<void>;
}

function availability(options: {
  supported: boolean;
  available: boolean;
  reason?: string;
  sourceBinCount?: number | null;
}): SpectrumSourceAvailability {
  return {
    kind: 'radio-sdr',
    supported: options.supported,
    available: options.available,
    defaultSelected: false,
    reason: options.reason,
    sourceBinCount: options.sourceBinCount ?? null,
    displayBinCount: SPECTRUM_DISPLAY_BIN_COUNT,
    supportsWaterfall: true,
    frequencyRangeMode: 'absolute',
  };
}

class IcomWlanSpectrumSource implements RadioSpectrumSource {
  readonly key: object;
  readonly spanController: RadioSpectrumSpanController;
  private listener: ((frame: SpectrumFrame) => void) | null = null;
  private lastFrameAt = 0;
  private readonly onFrame = (frame: IcomScopeFrame) => {
    const now = Date.now();
    if (this.lastFrameAt > 0 && now - this.lastFrameAt < ICOM_WLAN_SCOPE_FRAME_MIN_INTERVAL_MS) return;
    this.lastFrameAt = now;
    this.listener?.(createRadioSpectrumFrame(frame, null, 'ICOM WLAN'));
  };

  constructor(private readonly connection: ScopeCapableIcomConnection) {
    this.key = connection;
    this.spanController = {
      frameSpanScale: 2,
      preferFrameSpan: true,
      getSupportedSpans: () => connection.getSpectrumSpans(),
      getCurrentSpan: () => connection.getCurrentSpectrumSpan(),
      setSpan: (spanHz) => connection.setSpectrumSpan(spanHz),
    };
  }

  async getAvailability(): Promise<SpectrumSourceAvailability> {
    return availability({ supported: true, available: true });
  }

  async start(listener: (frame: SpectrumFrame) => void): Promise<void> {
    this.listener = listener;
    this.lastFrameAt = 0;
    this.connection.addScopeFrameListener(this.onFrame);
    await this.connection.enableScopeStream();
  }

  async stop(): Promise<void> {
    this.connection.removeScopeFrameListener(this.onFrame);
    this.listener = null;
    await this.connection.disableScopeStream();
  }
}

class HamlibSpectrumSource implements RadioSpectrumSource {
  readonly key: object;
  readonly spanController: RadioSpectrumSpanController;
  private cachedAvailability: SpectrumSourceAvailability | null = null;
  private listener: ((frame: SpectrumFrame) => void) | null = null;
  private readonly onLine = (line: SpectrumLine) => {
    this.listener?.(createHamlibRadioSpectrumFrame(line, null, 'ICOM Serial (Hamlib)'));
  };

  constructor(
    private readonly connection: SpectrumCapableHamlibConnection,
    private readonly getRuntimeConfig: () => ManagedSpectrumConfig,
  ) {
    this.key = connection;
    this.spanController = {
      frameSpanScale: 1,
      preferFrameSpan: false,
      getSupportedSpans: () => connection.getSpectrumSpans(),
      getCurrentSpan: () => connection.getCurrentSpectrumSpan(),
      setSpan: (spanHz) => connection.setSpectrumSpan(spanHz),
    };
  }

  async getAvailability(): Promise<SpectrumSourceAvailability> {
    if (this.connection.getRadioIoQueueSnapshot?.().backpressure) {
      return this.cachedAvailability ?? availability({ supported: true, available: true });
    }
    try {
      const summary = await this.connection.getSpectrumSupportSummary();
      this.cachedAvailability = availability({
        supported: summary.supported,
        available: summary.supported,
        reason: summary.supported ? undefined : 'hamlib_official_spectrum_not_supported',
      });
      return this.cachedAvailability;
    } catch {
      return availability({
        supported: false,
        available: false,
        reason: 'hamlib_official_spectrum_probe_failed',
      });
    }
  }

  async start(listener: (frame: SpectrumFrame) => void): Promise<void> {
    this.listener = listener;
    await this.connection.startManagedSpectrum(this.onLine, this.getRuntimeConfig());
  }

  async stop(): Promise<void> {
    this.listener = null;
    await this.connection.stopManagedSpectrum();
  }
}

export class IcomWlanSpectrumSourceProvider implements RadioSpectrumSourceProvider {
  private readonly sources = new WeakMap<ScopeCapableIcomConnection, IcomWlanSpectrumSource>();

  async resolve(context: RadioSpectrumSourceProviderContext): Promise<RadioSpectrumSourceResolution | null> {
    if (context.config.type !== 'icom-wlan') return null;
    const connection = context.icomWlanConnection;
    if (!context.connected || !(connection instanceof IcomWlanConnection)) {
      return {
        source: null,
        availability: availability({ supported: true, available: false, reason: 'radio_disconnected' }),
      };
    }
    let source = this.sources.get(connection as ScopeCapableIcomConnection);
    if (!source) {
      source = new IcomWlanSpectrumSource(connection as ScopeCapableIcomConnection);
      this.sources.set(connection as ScopeCapableIcomConnection, source);
    }
    return { source, availability: await source.getAvailability() };
  }
}

export class TciIqSpectrumSourceProvider implements RadioSpectrumSourceProvider {
  private readonly sources = new WeakMap<TciConnection, TciIqSpectrumSource>();

  async resolve(context: RadioSpectrumSourceProviderContext): Promise<RadioSpectrumSourceResolution | null> {
    if (context.config.type !== 'tci') return null;
    const connection = context.activeConnection;
    if (!context.connected || !(connection instanceof TciConnection)) {
      return {
        source: null,
        availability: availability({
          supported: false,
          available: false,
          reason: context.connected ? 'tci_iq_not_supported' : 'radio_disconnected',
        }),
      };
    }
    let source = this.sources.get(connection);
    if (!source) {
      source = new TciIqSpectrumSource(connection);
      this.sources.set(connection, source);
    }
    return { source, availability: await source.getAvailability() };
  }
}

export class HamlibSpectrumSourceProvider implements RadioSpectrumSourceProvider {
  private readonly sources = new WeakMap<SpectrumCapableHamlibConnection, HamlibSpectrumSource>();

  constructor(private readonly listSupportedRigs: () => Promise<SupportedRig[]>) {}

  async resolve(context: RadioSpectrumSourceProviderContext): Promise<RadioSpectrumSourceResolution | null> {
    if (context.config.type !== 'serial') return null;
    const rigModel = context.config.serial?.rigModel;
    const supportedRig = rigModel
      ? (await this.listSupportedRigs()).find((rig) => rig.rigModel === rigModel)
      : null;
    if (supportedRig?.mfgName.toUpperCase() !== 'ICOM') {
      return {
        source: null,
        availability: availability({
          supported: false,
          available: false,
          reason: 'radio_sdr_only_supported_for_icom_serial',
        }),
      };
    }

    const connection = context.activeConnection;
    if (!context.connected || !(connection instanceof HamlibConnection)) {
      return {
        source: null,
        availability: availability({ supported: true, available: false, reason: 'radio_disconnected' }),
      };
    }

    const capableConnection = connection as SpectrumCapableHamlibConnection;
    if (typeof capableConnection.getSpectrumSupportSummary !== 'function') {
      return {
        source: null,
        availability: availability({
          supported: true,
          available: false,
          reason: 'hamlib_official_spectrum_api_unavailable',
        }),
      };
    }

    let source = this.sources.get(capableConnection);
    if (!source) {
      source = new HamlibSpectrumSource(
        capableConnection,
        () => resolveHamlibSpectrumRuntimeConfig(context.config),
      );
      this.sources.set(capableConnection, source);
    }
    return { source, availability: await source.getAvailability() };
  }
}
