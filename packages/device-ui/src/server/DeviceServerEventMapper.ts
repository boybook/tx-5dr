import type { DeviceUiAccessSummary, DeviceUiNetworkSummary, DeviceUiPatchOp, DeviceUiRadioSummary, DeviceUiRecentMessage, DeviceUiSpectrumSummary } from '@tx5dr/contracts';
import type { DeviceAccessState, DeviceMonitorState, DeviceNetworkState, DeviceTx5drState, DeviceUiModel, DeviceUiPatch } from '../panel/messages.js';

export interface DeviceServerSnapshot {
  server: { ready: boolean; version?: string; webPort: number; hostname: string; browserClientCount: number; auth: { enabled: boolean; publicViewingAllowed: boolean } };
  engine: { isRunning: boolean; isDecoding: boolean; engineState?: string; mode: string; engineMode: 'digital' | 'voice'; nextSlotInMs?: number; audioStarted: boolean };
  radio: { connected: boolean; connectionStatus?: string; frequencyHz?: number; mode?: string; band?: string; ptt: boolean };
  operators: DeviceMonitorState['operators'];
  recentMessages: DeviceMonitorState['recentMessages'];
  spectrumMini?: DeviceMonitorState['spectrum'];
  warnings: DeviceMonitorState['warnings'];
}

interface ContractDeviceUiModel {
  schemaVersion: 1;
  page: string;
  network: {
    kind: 'ethernet' | 'wifi' | 'hotspot' | 'offline';
    connected: boolean;
    interfaceName: string | null;
    ssid?: string | null;
    ipAddress: string | null;
    signalPercent?: number | null;
    helperAvailable: boolean;
    message?: string;
  };
  access: {
    url: string | null;
    qrText: string | null;
    pairingCode: string | null;
    pairingExpiresAt: number | null;
    browserClientCount: number;
  };
  radio: {
    serverConnected: boolean;
    engineState: 'idle' | 'starting' | 'running' | 'stopping' | 'unknown';
    radioConnected: boolean;
    frequencyHz: number | null;
    mode: string | null;
    band: string | null;
    pttActive: boolean;
    txOperatorIds: string[];
    txText: string | null;
    slotSecondsRemaining: number | null;
  };
  spectrum: { timestamp: number; bins: number[]; peakBin: number | null };
  recentMessages: Array<{ id: string; timestamp: number; direction: 'rx' | 'tx'; text: string; callsign?: string | null; related: boolean; snr?: number | null }>;
}

export function mapSnapshotToPatches(snapshot: DeviceServerSnapshot): DeviceUiPatch[] {
  if (isContractDeviceUiModel(snapshot)) return mapContractModelToPatches(snapshot);

  const tx5dr: DeviceTx5drState = {
    server: snapshot.server.ready ? 'ready' : 'connecting',
    version: snapshot.server.version,
    webPort: snapshot.server.webPort,
    webUrls: [`http://${snapshot.server.hostname}:${snapshot.server.webPort}`],
    browserClientCount: snapshot.server.browserClientCount,
    authMode: snapshot.server.auth.enabled ? 'enabled' : 'disabled',
    publicViewingAllowed: snapshot.server.auth.publicViewingAllowed,
    engine: {
      isRunning: snapshot.engine.isRunning,
      state: normalizeEngineState(snapshot.engine.engineState),
      mode: snapshot.engine.mode,
      currentRadioMode: snapshot.radio.mode,
      nextSlotInMs: snapshot.engine.nextSlotInMs,
      audioStarted: snapshot.engine.audioStarted,
    },
    radio: {
      connected: snapshot.radio.connected,
      status: snapshot.radio.connectionStatus,
      frequencyHz: snapshot.radio.frequencyHz,
      frequencyLabel: snapshot.radio.frequencyHz ? `${(snapshot.radio.frequencyHz / 1_000_000).toFixed(3)} MHz` : undefined,
      band: snapshot.radio.band,
      ptt: snapshot.radio.ptt,
      operatorIdsInPtt: [],
    },
    clock: { state: 'unknown' },
  };
  return [
    { path: 'tx5dr', value: tx5dr },
    { path: 'monitor', value: { operators: snapshot.operators, recentMessages: snapshot.recentMessages, spectrum: snapshot.spectrumMini ?? { available: false, bins: [] }, warnings: snapshot.warnings } },
  ];
}

export function mapServerEventToPatches(event: unknown, current: DeviceUiModel): DeviceUiPatch[] {
  if (!event || typeof event !== 'object') return [];
  const typed = event as { type?: string; t?: string; data?: unknown; payload?: unknown };

  if (typed.t === 'device.snapshot') return mapSnapshotToPatches(typed.payload as DeviceServerSnapshot);
  if (typed.t === 'device.patch' && typed.payload) return [typed.payload as DeviceUiPatch];

  if (typed.type === 'state.replace') return mapSnapshotToPatches(typed.data as DeviceServerSnapshot);
  if (typed.type === 'state.patch') {
    const ops = (typed.data as { ops?: DeviceUiPatchOp[] } | undefined)?.ops ?? [];
    return mapContractPatchOpsToPatches(ops, current);
  }
  if (typed.type === 'spectrum.update') {
    return mapContractPatchOpsToPatches([{ path: 'spectrum', value: typed.data as DeviceUiSpectrumSummary }], current);
  }
  if (typed.type === 'access.update') {
    return mapContractPatchOpsToPatches([{ path: 'access', value: typed.data as DeviceUiAccessSummary }], current);
  }

  return [];
}

export function mapContractPatchOpsToPatches(ops: DeviceUiPatchOp[], current: DeviceUiModel): DeviceUiPatch[] {
  const patches: DeviceUiPatch[] = [];
  for (const op of ops) {
    switch (op.path) {
      case 'page':
        patches.push({ path: 'screen', value: op.value });
        break;
      case 'network':
        patches.push({ path: 'network', value: mapNetworkSummary(op.value) });
        break;
      case 'access':
        patches.push({ path: 'access', value: mapAccessSummary(op.value) });
        break;
      case 'radio':
        patches.push(...mapRadioSummary(op.value, current));
        break;
      case 'spectrum':
        patches.push({ path: 'monitor', value: { ...current.monitor, spectrum: mapSpectrumSummary(op.value) } });
        break;
      case 'recentMessages':
        patches.push({ path: 'monitor', value: { ...current.monitor, recentMessages: op.value.map(mapRecentMessage) } });
        break;
      case 'alert':
        patches.push({ path: 'ui.toast', value: op.value ? { level: op.value.level === 'error' ? 'error' : op.value.level, text: op.value.text, expiresAt: Date.now() + 5000 } : null });
        break;
    }
  }
  return patches;
}

function isContractDeviceUiModel(snapshot: unknown): snapshot is ContractDeviceUiModel {
  return Boolean(snapshot && typeof snapshot === 'object' && (snapshot as { schemaVersion?: unknown }).schemaVersion === 1 && 'radio' in snapshot && 'access' in snapshot);
}

function mapContractModelToPatches(model: ContractDeviceUiModel): DeviceUiPatch[] {
  const tx5dr = mapRadioSummaryToTx5dr(model.radio, {
    server: 'connecting',
    webUrls: [],
    browserClientCount: model.access.browserClientCount,
    authMode: 'enabled',
    engine: { isRunning: false },
    radio: { connected: false, ptt: false, operatorIdsInPtt: [] },
    clock: { state: 'unknown' },
  });
  tx5dr.webUrls = model.access.url ? [model.access.url] : [];
  tx5dr.browserClientCount = model.access.browserClientCount;
  return [
    { path: 'screen', value: model.page as never },
    { path: 'network', value: mapNetworkSummary(model.network) },
    { path: 'access', value: mapAccessSummary(model.access) },
    { path: 'tx5dr', value: tx5dr },
    { path: 'monitor', value: {
      operators: [],
      recentMessages: model.recentMessages.map(mapRecentMessage),
      spectrum: mapSpectrumSummary(model.spectrum),
      warnings: [],
    } },
  ];
}

function mapNetworkSummary(network: DeviceUiNetworkSummary): DeviceNetworkState {
  return {
    primary: network.kind,
    ethernet: {
      connected: network.kind === 'ethernet' && network.connected,
      interfaceName: network.kind === 'ethernet' ? network.interfaceName ?? undefined : undefined,
      ip: network.kind === 'ethernet' ? network.ipAddress ?? undefined : undefined,
    },
    wifi: {
      supported: true,
      interfaceName: network.kind === 'wifi' ? network.interfaceName ?? undefined : undefined,
      state: network.kind === 'wifi' && network.connected ? 'connected' : 'disconnected',
      ssid: network.kind === 'wifi' ? network.ssid ?? undefined : undefined,
      ip: network.kind === 'wifi' ? network.ipAddress ?? undefined : undefined,
      signalPercent: network.signalPercent ?? undefined,
      savedNetworks: [],
      lastError: network.message,
    },
    hotspot: {
      active: network.kind === 'hotspot' && network.connected,
      ssid: network.kind === 'hotspot' ? network.ssid ?? undefined : undefined,
      ip: network.kind === 'hotspot' ? network.ipAddress ?? undefined : undefined,
    },
  };
}

function mapAccessSummary(access: DeviceUiAccessSummary): DeviceAccessState {
  return {
    url: access.url ?? undefined,
    pairingCode: access.pairingCode ?? undefined,
    expiresAt: access.pairingExpiresAt ?? undefined,
    qrKind: access.qrText && access.pairingCode ? 'pairing-url' : 'access-url',
  };
}

function mapRadioSummary(radio: DeviceUiRadioSummary, current: DeviceUiModel): DeviceUiPatch[] {
  const nextTx5dr = mapRadioSummaryToTx5dr(radio, current.tx5dr);
  const patches: DeviceUiPatch[] = [{ path: 'tx5dr', value: nextTx5dr }];
  if (radio.txText) {
    patches.push({
      path: 'monitor',
      value: {
        ...current.monitor,
        currentTx: {
          operatorId: radio.txOperatorIds[0] ?? 'unknown',
          message: radio.txText,
          frequencyHz: radio.frequencyHz ?? current.monitor.currentTx?.frequencyHz ?? 0,
        },
      },
    });
  }
  return patches;
}

function mapRadioSummaryToTx5dr(radio: DeviceUiRadioSummary, current: DeviceTx5drState): DeviceTx5drState {
  return {
    ...current,
    server: radio.serverConnected ? 'ready' : 'unreachable',
    engine: {
      ...current.engine,
      isRunning: radio.engineState === 'running',
      state: normalizeEngineState(radio.engineState),
      mode: radio.mode ?? undefined,
      currentRadioMode: radio.mode ?? undefined,
      nextSlotInMs: radio.slotSecondsRemaining == null ? undefined : radio.slotSecondsRemaining * 1000,
    },
    radio: {
      ...current.radio,
      connected: radio.radioConnected,
      frequencyHz: radio.frequencyHz ?? undefined,
      frequencyLabel: radio.frequencyHz ? `${(radio.frequencyHz / 1_000_000).toFixed(3)} MHz` : undefined,
      band: radio.band ?? undefined,
      ptt: radio.pttActive,
      operatorIdsInPtt: radio.txOperatorIds,
    },
  };
}

function mapSpectrumSummary(spectrum: DeviceUiSpectrumSummary): DeviceMonitorState['spectrum'] {
  return { available: spectrum.bins.length > 0, bins: spectrum.bins.map(bin => Math.round(bin * 100)), updatedAt: spectrum.timestamp };
}

function mapRecentMessage(message: DeviceUiRecentMessage): DeviceMonitorState['recentMessages'][number] {
  return {
    timeMs: message.timestamp,
    direction: message.direction,
    callsign: message.callsign ?? undefined,
    message: message.text,
    snr: message.snr ?? undefined,
    related: message.related,
  };
}

function normalizeEngineState(value?: string): DeviceTx5drState['engine']['state'] {
  if (value === 'starting' || value === 'running' || value === 'stopping') return value;
  return 'idle';
}
