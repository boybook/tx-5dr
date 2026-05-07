#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { DeviceUiDaemon } from '../app/DeviceUiDaemon.js';

const config = loadConfig(process.argv.slice(2));
const watch = process.argv.includes('--watch');
const daemon = new DeviceUiDaemon({ ...config, renderer: config.renderer === 'auto' ? 'mock' : config.renderer });
await daemon.start();
const snapshot = daemon.store.getSnapshot();
console.log(JSON.stringify({ ok: true, mode: 'preview', fixture: config.fixture, socketPath: config.socketPath, screen: snapshot.screen, model: snapshot }, null, 2));

if (daemon.config.renderer === 'mock') {
  console.error('[device-ui preview] mock renderer mode: no native window is launched. Use --watch to keep the socket open.');
}

if (!watch && daemon.config.renderer === 'mock') {
  await daemon.stop();
  process.exit(0);
}

process.on('SIGINT', async () => { await daemon.stop(); process.exit(0); });
process.on('SIGTERM', async () => { await daemon.stop(); process.exit(0); });
