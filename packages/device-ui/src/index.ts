#!/usr/bin/env node
export { DeviceUiDaemon } from './app/DeviceUiDaemon.js';
export { DeviceUiStateStore, createInitialModel } from './app/DeviceUiStateStore.js';
export { ServerApiClient } from './server/ServerApiClient.js';
export { PanelSocketHub } from './panel/PanelSocketHub.js';
export { RendererProcessManager } from './panel/RendererProcessManager.js';
export { NetworkHelperClient } from './network/NetworkHelperClient.js';
export { NmcliNetworkController } from './network/NmcliNetworkController.js';
export * from './network/NetworkController.js';
export * from './panel/messages.js';
export * from './profiles/displayProfiles.js';
export * from './config.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadConfig } = await import('./config.js');
  const { DeviceUiDaemon } = await import('./app/DeviceUiDaemon.js');
  const daemon = new DeviceUiDaemon(loadConfig());
  await daemon.start();
  console.log(`[device-ui] started profile=${daemon.config.profile.id} socket=${daemon.config.socketPath}`);
  process.on('SIGINT', async () => { await daemon.stop(); process.exit(0); });
  process.on('SIGTERM', async () => { await daemon.stop(); process.exit(0); });
}
