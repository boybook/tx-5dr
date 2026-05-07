import type { DeviceUiModel, DeviceUiPatchOp } from '@tx5dr/contracts';
import type { DigitalRadioEngine } from '../DigitalRadioEngine.js';
import type { WSServer } from '../websocket/WSServer.js';

export class DeviceUiProjectionService {
  private model: DeviceUiModel;
  private listeners = new Set<(ops: DeviceUiPatchOp[]) => void>();

  constructor(
    private readonly digitalRadioEngine: DigitalRadioEngine,
    private readonly wsServer: WSServer,
  ) {
    this.model = this.buildInitialModel();
  }

  getModel(): DeviceUiModel {
    this.refreshRadioProjection();
    this.refreshBrowserClientCount();
    return this.model;
  }

  updateAccess(url: string | null, qrText: string | null, pairingCode: string | null, pairingExpiresAt: number | null): DeviceUiModel['access'] {
    const access = {
      ...this.model.access,
      url,
      qrText,
      pairingCode,
      pairingExpiresAt,
    };
    this.applyPatch([{ path: 'access', value: access }]);
    return access;
  }

  onPatch(listener: (ops: DeviceUiPatchOp[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private applyPatch(ops: DeviceUiPatchOp[]): void {
    for (const op of ops) {
      this.model = { ...this.model, [op.path]: op.value, updatedAt: Date.now() };
    }
    for (const listener of this.listeners) listener(ops);
  }

  private refreshBrowserClientCount(): void {
    const count = this.wsServer.getBrowserClientCount();
    if (this.model.access.browserClientCount !== count) {
      this.model = {
        ...this.model,
        updatedAt: Date.now(),
        access: { ...this.model.access, browserClientCount: count },
      };
    }
  }

  private refreshRadioProjection(): void {
    try {
      const status = this.digitalRadioEngine.getStatus();
      const nextRadio = {
        ...this.model.radio,
        serverConnected: true,
        engineState: status.engineState ?? (status.isRunning ? 'running' : 'idle'),
        radioConnected: status.radioConnected ?? false,
        slotSecondsRemaining: typeof status.nextSlotIn === 'number' ? Math.max(0, Math.ceil(status.nextSlotIn / 1000)) : null,
      } as DeviceUiModel['radio'];
      this.model = { ...this.model, radio: nextRadio, updatedAt: Date.now() };
    } catch {
      this.model = {
        ...this.model,
        radio: { ...this.model.radio, serverConnected: false, engineState: 'unknown' },
        updatedAt: Date.now(),
      };
    }
  }

  private buildInitialModel(): DeviceUiModel {
    const now = Date.now();
    return {
      schemaVersion: 1,
      page: 'boot',
      updatedAt: now,
      device: {
        id: 'server',
        profile: 'server-projection',
        renderer: 'device-ui-ws',
      },
      network: {
        kind: 'offline',
        connected: false,
        interfaceName: null,
        ipAddress: null,
        helperAvailable: false,
        message: 'Network is managed by the device-ui daemon',
      },
      access: {
        url: null,
        qrText: null,
        pairingCode: null,
        pairingExpiresAt: null,
        browserClientCount: 0,
      },
      radio: {
        serverConnected: true,
        engineState: 'unknown',
        radioConnected: false,
        frequencyHz: null,
        mode: null,
        band: null,
        pttActive: false,
        txOperatorIds: [],
        txText: null,
        slotSecondsRemaining: null,
      },
      spectrum: {
        timestamp: now,
        bins: [],
        peakBin: null,
      },
      recentMessages: [],
      alert: null,
    };
  }
}
