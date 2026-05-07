export const PANEL_IPC_VERSION = 1 as const;
export const PANEL_IPC_MAX_BYTES = 64 * 1024;

export type DeviceScreen =
  | 'boot'
  | 'access'
  | 'network-overview'
  | 'wifi-scan'
  | 'wifi-password'
  | 'hotspot'
  | 'monitor'
  | 'diagnostics'
  | 'dialog'
  | 'error';

export type DeviceUiAction =
  | 'nav.access'
  | 'nav.network'
  | 'nav.monitor'
  | 'nav.back'
  | 'network.scan'
  | 'network.wifi.select'
  | 'network.wifi.connect'
  | 'network.wifi.cancel'
  | 'network.wifi.forget'
  | 'network.hotspot.start'
  | 'network.hotspot.stop'
  | 'network.hotspot.show-credentials'
  | 'access.refresh-pairing-code'
  | 'access.toggle-qr-kind'
  | 'monitor.toggle-spectrum-source'
  | 'error.dismiss'
  | 'system.show-diagnostics'
  | 'system.restart-renderer';

export interface PanelIpcEnvelope<T = unknown> {
  v: 1;
  id?: string;
  seq?: number;
  t: string;
  ts: number;
  payload?: T;
}

export interface DeviceStatusBar {
  networkKind: 'ethernet' | 'wifi' | 'hotspot' | 'offline' | 'unknown';
  networkLabel: string;
  ip?: string;
  server: 'connecting' | 'ready' | 'error';
  engine: 'idle' | 'starting' | 'running' | 'stopping' | 'unknown';
  mode?: 'FT8' | 'FT4' | 'VOICE' | string;
  slotRemainingMs?: number;
  ptt: boolean;
  warningLevel: 'none' | 'info' | 'warn' | 'alert';
}

export interface WifiNetworkSummary {
  ssid: string;
  bssid?: string;
  signalPercent: number;
  security: string[];
  saved?: boolean;
}

export interface DeviceNetworkState {
  primary: 'ethernet' | 'wifi' | 'hotspot' | 'offline';
  ethernet: { connected: boolean; interfaceName?: string; ip?: string; url?: string };
  wifi: {
    supported: boolean;
    interfaceName?: string;
    state: 'disabled' | 'disconnected' | 'scanning' | 'connecting' | 'connected' | 'failed';
    ssid?: string;
    ip?: string;
    signalPercent?: number;
    savedNetworks: string[];
    scanResults?: WifiNetworkSummary[];
    lastError?: string;
  };
  hotspot: { active: boolean; ssid?: string; password?: string; ip?: string; url?: string; clients?: number };
}

export interface DeviceAccessState {
  url?: string;
  hostname?: string;
  pairingCode?: string;
  pairingUrl?: string;
  pairingId?: string;
  expiresAt?: number;
  qrKind: 'access-url' | 'pairing-url' | 'wifi';
}

export interface DeviceTx5drState {
  server: 'connecting' | 'ready' | 'auth-error' | 'unreachable' | 'error';
  version?: string;
  webPort?: number;
  webUrls: string[];
  browserClientCount: number;
  authMode: 'disabled' | 'enabled';
  publicViewingAllowed?: boolean;
  engine: {
    isRunning: boolean;
    state?: 'idle' | 'starting' | 'running' | 'stopping';
    mode?: string;
    currentRadioMode?: string;
    nextSlotInMs?: number;
    audioStarted?: boolean;
  };
  radio: {
    connected: boolean;
    status?: string;
    frequencyHz?: number;
    frequencyLabel?: string;
    band?: string;
    ptt: boolean;
    operatorIdsInPtt: string[];
  };
  clock: { state: 'ok' | 'warn' | 'alert' | 'stale' | 'failed' | 'never' | 'unknown'; offsetMs?: number };
}

export interface DeviceMonitorState {
  selectedOperatorId?: string;
  operators: Array<{
    id: string;
    callsign: string;
    active: boolean;
    transmitting: boolean;
    inActivePtt: boolean;
    txAudioHz?: number;
    targetCall?: string;
    strategyState?: string;
    currentMessage?: string;
    transmitCycles?: number[];
  }>;
  currentTx?: { operatorId: string; callsign?: string; message: string; frequencyHz: number; startedAt?: number };
  recentMessages: Array<{
    timeMs: number;
    direction: 'rx' | 'tx';
    operatorId?: string;
    callsign?: string;
    message: string;
    snr?: number;
    audioHz?: number;
    related: boolean;
  }>;
  spectrum: { available: boolean; kind?: 'audio' | 'radio-sdr' | 'openwebrx-sdr'; bins: number[]; minDb?: number; maxDb?: number; updatedAt?: number };
  warnings: Array<{ code: string; message: string; severity: 'info' | 'warn' | 'alert' }>;
}

export interface DeviceToast { level: 'info' | 'success' | 'warn' | 'error'; text: string; expiresAt?: number }
export interface DeviceDialog { id: string; title: string; body: string; actions: Array<{ id: string; label: string; style?: 'default' | 'danger' }> }

export interface DeviceUiModel {
  meta: { schemaVersion: 1; generatedAt: number; deviceId: string; profileId: string };
  screen: DeviceScreen;
  statusBar: DeviceStatusBar;
  network: DeviceNetworkState;
  access: DeviceAccessState;
  tx5dr: DeviceTx5drState;
  monitor: DeviceMonitorState;
  ui: { busy: boolean; busyText?: string; toast?: DeviceToast; dialog?: DeviceDialog; diagnosticsVisible: boolean };
}

export type DeviceUiPatch =
  | { path: 'statusBar'; value: DeviceStatusBar }
  | { path: 'network'; value: DeviceNetworkState }
  | { path: 'access'; value: DeviceAccessState }
  | { path: 'tx5dr'; value: DeviceTx5drState }
  | { path: 'monitor'; value: DeviceMonitorState }
  | { path: 'ui.busy'; value: boolean; text?: string }
  | { path: 'ui.toast'; value: DeviceToast | null }
  | { path: 'screen'; value: DeviceScreen };

export interface RendererHello {
  renderer: string;
  backend: string;
  profileId: string;
  width: number;
  height: number;
  input: 'touch' | 'buttons' | 'none';
}

export interface UiActionPayload { action: DeviceUiAction; source: 'touch' | 'button' | 'keyboard' | 'system'; screen?: DeviceScreen; data?: unknown }
