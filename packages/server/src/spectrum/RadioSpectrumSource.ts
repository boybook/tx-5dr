import type { SpectrumFrame, SpectrumSourceAvailability } from '@tx5dr/contracts';
import type { RadioConnectionConfig, IRadioConnection } from '../radio/connections/IRadioConnection.js';

export interface RadioSpectrumSource {
  readonly key: object;
  readonly spanController?: RadioSpectrumSpanController;
  getAvailability(): Promise<SpectrumSourceAvailability>;
  start(listener: (frame: SpectrumFrame) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface RadioSpectrumSpanController {
  readonly frameSpanScale: number;
  readonly preferFrameSpan: boolean;
  getSupportedSpans(): Promise<readonly number[]>;
  getCurrentSpan(): Promise<number | null>;
  setSpan(spanHz: number): Promise<number | void>;
}

export interface RadioSpectrumSourceProviderContext {
  activeConnection: IRadioConnection | null;
  icomWlanConnection: object | null;
  connected: boolean;
  config: RadioConnectionConfig;
}

export interface RadioSpectrumSourceResolution {
  source: RadioSpectrumSource | null;
  availability: SpectrumSourceAvailability;
}

export interface RadioSpectrumSourceProvider {
  resolve(context: RadioSpectrumSourceProviderContext): Promise<RadioSpectrumSourceResolution | null>;
}

export class RadioSpectrumSourceRegistry {
  constructor(private readonly providers: readonly RadioSpectrumSourceProvider[]) {}

  async resolve(context: RadioSpectrumSourceProviderContext): Promise<RadioSpectrumSourceResolution | null> {
    for (const provider of this.providers) {
      const resolution = await provider.resolve(context);
      if (resolution) return resolution;
    }
    return null;
  }
}
