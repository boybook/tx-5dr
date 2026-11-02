import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ConfigManager } from '../config-manager.js';

it('rejects a legacy virtual Profile without changing the file or selecting another Profile', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tx5dr-legacy-virtual-'));
  const previous = process.env.TX5DR_CONFIG_DIR;
  const slot = ConfigManager as unknown as { instance?: ConfigManager };
  const priorInstance = slot.instance;
  try {
    process.env.TX5DR_CONFIG_DIR = directory;
    slot.instance = undefined;
    const config = JSON.stringify({ activeProfileId: 'old', profiles: [{ id: 'old', radio: { type: 'virtual' } }] });
    await writeFile(path.join(directory, 'config.json'), config);
    await expect(ConfigManager.getInstance().initialize()).rejects.toThrow('Legacy virtual radio Profiles');
    expect(await readFile(path.join(directory, 'config.json'), 'utf8')).toBe(config);
    expect(ConfigManager.getInstance().getActiveProfileId()).toBeNull();
  } finally {
    slot.instance = priorInstance;
    if (previous === undefined) delete process.env.TX5DR_CONFIG_DIR; else process.env.TX5DR_CONFIG_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
