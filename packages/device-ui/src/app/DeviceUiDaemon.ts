import { loadConfig, type DeviceUiConfig } from '../config.js';
import { AccessUrlController } from '../access/AccessUrlController.js';
import { NetworkHelperClient } from '../network/NetworkHelperClient.js';
import { NmcliNetworkController } from '../network/NmcliNetworkController.js';
import { PanelSocketHub } from '../panel/PanelSocketHub.js';
import { RendererProcessManager } from '../panel/RendererProcessManager.js';
import type { UiActionPayload } from '../panel/messages.js';
import { ServerApiClient } from '../server/ServerApiClient.js';
import { mapServerEventToPatches, mapSnapshotToPatches } from '../server/DeviceServerEventMapper.js';
import { createInitialModel, DeviceUiStateStore } from './DeviceUiStateStore.js';
import { chooseDefaultScreen } from './stateMachine.js';

export class DeviceUiDaemon {
  readonly config: DeviceUiConfig;
  readonly store: DeviceUiStateStore;
  readonly panel: PanelSocketHub;
  readonly renderer: RendererProcessManager;
  readonly server: ServerApiClient;
  readonly network: NmcliNetworkController;
  readonly access = new AccessUrlController();

  constructor(config: DeviceUiConfig = loadConfig()) {
    this.config = config;
    this.store = new DeviceUiStateStore(createInitialModel({ deviceId: config.deviceId, profileId: config.profile.id }));
    this.panel = new PanelSocketHub({ socketPath: config.socketPath, ackTimeoutMs: config.ackTimeoutMs, profilePayload: { profile: config.profile } });
    this.renderer = new RendererProcessManager(config);
    this.server = new ServerApiClient({ baseUrl: config.serverBaseUrl, tokenPath: config.tokenPath, deviceId: config.deviceId });
    this.network = new NmcliNetworkController(new NetworkHelperClient(config.helperSocketPath));
  }

  async start(): Promise<void> {
    this.wireEvents();
    await this.panel.start();
    await this.refreshNetwork();
    if (this.config.fixture) await this.loadFixture(this.config.fixture);
    else void this.refreshServer();
    this.renderer.start();
  }

  async stop(): Promise<void> {
    await this.renderer.stop();
    await this.panel.stop();
  }

  private wireEvents(): void {
    this.store.on('patch', (patch) => this.panel.sendPatch(patch));
    this.store.on('replace', (model) => void this.panel.replay(model));
    this.panel.on('hello', () => void this.panel.replay(this.store.getSnapshot()));
    this.panel.on('ready', () => void this.panel.replay(this.store.getSnapshot()));
    this.panel.on('action', (action: UiActionPayload) => void this.handleAction(action));
    this.panel.on('ackTimeout', () => this.renderer.restart());
    this.server.on('event', (event) => this.handleServerEvent(event));
  }

  private async refreshNetwork(): Promise<void> {
    const network = await this.network.getStatus();
    this.store.patch({ path: 'network', value: network });
    const snapshot = this.store.getSnapshot();
    this.store.patch({ path: 'statusBar', value: { ...snapshot.statusBar, networkKind: network.primary, networkLabel: labelNetwork(network), ip: network.ethernet.ip ?? network.wifi.ip ?? network.hotspot.ip } });
    this.store.patch({ path: 'screen', value: chooseDefaultScreen(network, snapshot.tx5dr, snapshot.monitor) });
  }

  private async refreshServer(): Promise<void> {
    try {
      const snapshot = await this.server.bootstrap();
      for (const patch of mapSnapshotToPatches(snapshot)) this.store.patch(patch);
      const current = this.store.getSnapshot();
      this.store.patch({ path: 'access', value: this.access.compose(current.network, current.tx5dr) });
      void this.server.connectEvents();
    } catch (error) {
      const current = this.store.getSnapshot();
      this.store.patch({ path: 'tx5dr', value: { ...current.tx5dr, server: 'unreachable' } });
      this.store.patch({ path: 'ui.toast', value: { level: 'warn', text: error instanceof Error ? error.message : 'Server unavailable', expiresAt: Date.now() + 5000 } });
    }
  }

  private handleServerEvent(event: unknown): void {
    for (const patch of mapServerEventToPatches(event, this.store.getSnapshot())) this.store.patch(patch);
  }

  private async handleAction(payload: UiActionPayload): Promise<void> {
    switch (payload.action) {
      case 'nav.access': this.store.patch({ path: 'screen', value: 'access' }); break;
      case 'nav.network': this.store.patch({ path: 'screen', value: 'network-overview' }); break;
      case 'nav.monitor': this.store.patch({ path: 'screen', value: 'monitor' }); break;
      case 'network.scan': {
        const current = this.store.getSnapshot().network;
        this.store.patch({ path: 'network', value: { ...current, wifi: { ...current.wifi, state: 'scanning' } } });
        const scanResults = await this.network.scanWifi();
        this.store.patch({ path: 'network', value: { ...this.store.getSnapshot().network, wifi: { ...current.wifi, state: 'disconnected', scanResults } } });
        this.store.patch({ path: 'screen', value: 'wifi-scan' });
        break;
      }
      case 'network.hotspot.start': await this.network.startHotspot(); await this.refreshNetwork(); this.store.patch({ path: 'screen', value: 'hotspot' }); break;
      case 'network.hotspot.stop': await this.network.stopHotspot(); await this.refreshNetwork(); break;
      case 'network.hotspot.show-credentials': this.store.patch({ path: 'screen', value: 'hotspot' }); break;
      case 'network.wifi.connect': await this.connectWifi(payload.data); break;
      case 'network.wifi.forget': await this.forgetWifi(payload.data); break;
      case 'access.refresh-pairing-code': await this.refreshPairingCode(); break;
      case 'access.toggle-qr-kind': this.toggleQrKind(); break;
      case 'system.show-diagnostics': this.store.patch({ path: 'screen', value: 'diagnostics' }); break;
      case 'system.restart-renderer': this.renderer.restart(); break;
      default: this.panel.sendToast(`Action queued: ${payload.action}`); break;
    }
  }

  private async connectWifi(data: unknown): Promise<void> {
    const input = data as { ssid?: string; password?: string; hidden?: boolean } | undefined;
    if (!input?.ssid) { this.panel.sendToast('Choose a Wi-Fi network first', 'warn'); return; }
    this.store.patch({ path: 'ui.busy', value: true, text: `Connecting to ${input.ssid}` });
    try {
      await this.network.connectWifi({ ssid: input.ssid, password: input.password, hidden: input.hidden });
      await this.refreshNetwork();
      this.store.patch({ path: 'screen', value: 'network-overview' });
    } catch (error) {
      const current = this.store.getSnapshot().network;
      this.store.patch({ path: 'network', value: { ...current, wifi: { ...current.wifi, state: 'failed', lastError: error instanceof Error ? error.message : 'Wi-Fi connect failed' } } });
      this.panel.sendToast(error instanceof Error ? error.message : 'Wi-Fi connect failed', 'warn');
    } finally {
      this.store.patch({ path: 'ui.busy', value: false });
    }
  }

  private async forgetWifi(data: unknown): Promise<void> {
    const ssid = typeof data === 'string' ? data : (data as { ssid?: string } | undefined)?.ssid;
    if (!ssid) { this.panel.sendToast('Choose a saved Wi-Fi network first', 'warn'); return; }
    await this.network.forgetWifi(ssid);
    await this.refreshNetwork();
  }

  private toggleQrKind(): void {
    const current = this.store.getSnapshot().access;
    const next = current.qrKind === 'access-url' && current.pairingUrl ? 'pairing-url' : 'access-url';
    this.store.patch({ path: 'access', value: { ...current, qrKind: next } });
  }

  private async refreshPairingCode(): Promise<void> {
    const pairing = await this.server.requestPairingCode();
    const current = this.store.getSnapshot().access;
    this.store.patch({ path: 'access', value: { ...current, pairingCode: pairing.code, pairingUrl: pairing.url, pairingId: pairing.id, expiresAt: pairing.expiresAt, qrKind: pairing.url ? 'pairing-url' : current.qrKind } });
  }

  private async loadFixture(name: string): Promise<void> {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', '..', 'fixtures', `${name}.json`);
    const model = JSON.parse(await readFile(path, 'utf8'));
    this.store.replace({ ...model, meta: { ...model.meta, deviceId: this.config.deviceId, profileId: this.config.profile.id, generatedAt: Date.now() } });
  }
}

function labelNetwork(network: { primary: string; wifi: { ssid?: string }; hotspot: { ssid?: string } }): string {
  if (network.primary === 'wifi') return network.wifi.ssid ?? 'Wi-Fi';
  if (network.primary === 'hotspot') return network.hotspot.ssid ?? 'Hotspot';
  if (network.primary === 'ethernet') return 'Ethernet';
  return 'Offline';
}
