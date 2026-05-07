import { EventEmitter } from 'node:events';
import type { DeviceAccessState, DeviceMonitorState, DeviceNetworkState, DeviceStatusBar, DeviceTx5drState, DeviceUiModel, DeviceUiPatch } from '../panel/messages.js';

export class DeviceUiStateStore extends EventEmitter {
  #model: DeviceUiModel;
  #seq = 0;

  constructor(initial: DeviceUiModel) {
    super();
    this.#model = structuredClone(initial);
  }

  getSnapshot(): DeviceUiModel {
    return structuredClone(this.#model);
  }

  get seq(): number {
    return this.#seq;
  }

  replace(model: DeviceUiModel): number {
    this.#seq += 1;
    this.#model = structuredClone({ ...model, meta: { ...model.meta, generatedAt: Date.now() } });
    this.emit('replace', this.getSnapshot(), this.#seq);
    return this.#seq;
  }

  patch(patch: DeviceUiPatch): number {
    this.#seq += 1;
    applyPatch(this.#model, patch);
    this.#model.meta.generatedAt = Date.now();
    this.emit('patch', patch, this.#seq, this.getSnapshot());
    return this.#seq;
  }
}

export function createInitialModel(input: { deviceId: string; profileId: string }): DeviceUiModel {
  return {
    meta: { schemaVersion: 1, generatedAt: Date.now(), deviceId: input.deviceId, profileId: input.profileId },
    screen: 'boot',
    statusBar: createStatusBar(),
    network: createNetworkState(),
    access: { qrKind: 'access-url' },
    tx5dr: createTx5drState(),
    monitor: createMonitorState(),
    ui: { busy: false, diagnosticsVisible: false },
  };
}

function applyPatch(model: DeviceUiModel, patch: DeviceUiPatch): void {
  switch (patch.path) {
    case 'statusBar': model.statusBar = patch.value as DeviceStatusBar; break;
    case 'network': model.network = patch.value as DeviceNetworkState; break;
    case 'access': model.access = patch.value as DeviceAccessState; break;
    case 'tx5dr': model.tx5dr = patch.value as DeviceTx5drState; break;
    case 'monitor': model.monitor = patch.value as DeviceMonitorState; break;
    case 'ui.busy': model.ui.busy = patch.value; model.ui.busyText = patch.text; break;
    case 'ui.toast': patch.value === null ? delete model.ui.toast : (model.ui.toast = patch.value); break;
    case 'screen': model.screen = patch.value; break;
  }
}

function createStatusBar(): DeviceStatusBar {
  return { networkKind: 'unknown', networkLabel: 'Network', server: 'connecting', engine: 'unknown', ptt: false, warningLevel: 'info' };
}

function createNetworkState(): DeviceNetworkState {
  return {
    primary: 'offline',
    ethernet: { connected: false },
    wifi: { supported: false, state: 'disconnected', savedNetworks: [] },
    hotspot: { active: false },
  };
}

function createTx5drState(): DeviceTx5drState {
  return {
    server: 'connecting',
    webUrls: [],
    browserClientCount: 0,
    authMode: 'enabled',
    engine: { isRunning: false, state: 'idle' },
    radio: { connected: false, ptt: false, operatorIdsInPtt: [] },
    clock: { state: 'unknown' },
  };
}

function createMonitorState(): DeviceMonitorState {
  return { operators: [], recentMessages: [], spectrum: { available: false, bins: [] }, warnings: [] };
}
