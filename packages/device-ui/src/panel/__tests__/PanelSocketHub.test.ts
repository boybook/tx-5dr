import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createInitialModel } from '../../app/DeviceUiStateStore.js';
import { PanelSocketHub } from '../PanelSocketHub.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('PanelSocketHub', () => {
  it('replays hello, panel config, and full state over NDJSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tx5dr-panel-'));
    dirs.push(dir);
    const socketPath = join(dir, 'panel.sock');
    const hub = new PanelSocketHub({ socketPath, ackTimeoutMs: 200, profilePayload: { profile: { id: 'tft' } } });
    await hub.start();

    const client = connect(socketPath);
    const lines: string[] = [];
    client.setEncoding('utf8');
    client.on('data', chunk => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        lines.push(line);
        const msg = JSON.parse(line);
        client.write(`${JSON.stringify({ v: 1, id: msg.id, t: 'renderer.applied', ts: Date.now() })}\n`);
      }
    });

    await new Promise<void>(resolve => client.once('connect', resolve));
    await hub.replay(createInitialModel({ deviceId: 'd', profileId: 'p' }));

    expect(lines.map(line => JSON.parse(line).t)).toEqual(['daemon.hello', 'panel.config', 'state.replace']);
    client.destroy();
    await hub.stop();
  });
});
