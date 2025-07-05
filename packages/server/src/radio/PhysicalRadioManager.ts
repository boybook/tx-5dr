import { HamLib } from 'hamlib';
import { HamlibConfig } from '@tx5dr/contracts';

export class PhysicalRadioManager {
  private rig: HamLib | null = null;
  private currentConfig: HamlibConfig = { type: 'none' };

  getConfig(): HamlibConfig {
    return { ...this.currentConfig };
  }

  async applyConfig(config: HamlibConfig): Promise<void> {
    await this.disconnect();
    this.currentConfig = config;
    if (config.type === 'none') {
      return;
    }
    const port = config.type === 'network' ? `${config.host}:${config.port}` : config.path;
    const model = config.type === 'network' ? 2 : config.rigModel;
    this.rig = new HamLib(model, port);
    this.rig.open();
  }

  async disconnect(): Promise<void> {
    if (this.rig) {
      try { this.rig.close(); } catch {}
      try { this.rig.destroy(); } catch {}
      this.rig = null;
    }
  }

  async setFrequency(freq: number): Promise<void> {
    if (this.rig) {
      this.rig.setFrequency(freq);
    }
  }

  async setPTT(state: boolean): Promise<void> {
    if (this.rig) {
      this.rig.setPtt(state);
    }
  }

  isConnected(): boolean {
    return !!this.rig;
  }

  static listSupportedRigs() {
    return HamLib.getSupportedRigs();
  }
}
