import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPluginFromMarketplace,
  uninstallPluginFromMarketplace,
  updatePluginFromMarketplace,
} from '../marketplace-installer.js';
import { PLUGIN_SOURCE_FILE_NAME } from '../plugin-source.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createPluginArchive(root: string, pluginName: string, version: string): Promise<string> {
  const sourceDir = path.join(root, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'index.mjs'),
    `export default { name: ${JSON.stringify(pluginName)}, version: ${JSON.stringify(version)}, type: 'utility' };`,
    'utf8',
  );

  const archivePath = path.join(root, `${pluginName}-${version}.zip`);
  await execFileAsync('zip', ['-qr', archivePath, '.'], { cwd: sourceDir });
  return archivePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('plugin marketplace installer', () => {
  it('installs a plugin zip into the runtime plugin directory', async () => {
    const root = await makeTempDir('tx5dr-market-install-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const archivePath = await createPluginArchive(root, 'hello-plugin', '1.0.0');
    const artifactBytes = await fs.readFile(archivePath);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(artifactBytes).digest('hex');

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-04-22T12:00:00.000Z',
        channel: 'stable',
        plugins: [
          {
            name: 'hello-plugin',
            title: 'Hello Plugin',
            description: 'test plugin',
            latestVersion: '1.0.0',
            minHostVersion: '1.0.0',
            artifactUrl: 'https://cdn.example.com/hello-plugin-1.0.0.zip',
            sha256,
            size: artifactBytes.length,
            publishedAt: '2026-04-22T12:00:00.000Z',
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(artifactBytes, { status: 200 }));

    const result = await installPluginFromMarketplace('hello-plugin', pluginDir, 'stable', {
      fetchImpl,
      env: { TX5DR_PLUGIN_MARKET_BASE_URL: 'https://cdn.example.com/market' },
    });

    expect(result.action).toBe('install');
    await expect(fs.access(path.join(pluginDir, 'hello-plugin', 'index.mjs'))).resolves.toBeUndefined();
    const sourceFile = JSON.parse(
      await fs.readFile(path.join(pluginDir, 'hello-plugin', PLUGIN_SOURCE_FILE_NAME), 'utf8'),
    ) as {
      schemaVersion: number;
      source: {
        kind: string;
        version: string;
        channel: string;
      };
    };
    expect(sourceFile.schemaVersion).toBe(1);
    expect(sourceFile.source).toMatchObject({
      kind: 'marketplace',
      version: '1.0.0',
      channel: 'stable',
    });
  });

  it('updates an existing installed plugin by replacing the runtime directory', async () => {
    const root = await makeTempDir('tx5dr-market-update-');
    const pluginDir = path.join(root, 'plugins');
    const existingDir = path.join(pluginDir, 'hello-plugin');
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, 'index.mjs'), `export default { name: 'hello-plugin', version: '0.9.0', type: 'utility' };`, 'utf8');

    const archivePath = await createPluginArchive(root, 'hello-plugin', '1.1.0');
    const artifactBytes = await fs.readFile(archivePath);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(artifactBytes).digest('hex');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-04-22T12:00:00.000Z',
        channel: 'nightly',
        plugins: [
          {
            name: 'hello-plugin',
            title: 'Hello Plugin',
            description: 'test plugin',
            latestVersion: '1.1.0',
            minHostVersion: '1.0.0',
            artifactUrl: 'https://cdn.example.com/hello-plugin-1.1.0.zip',
            sha256,
            size: artifactBytes.length,
            publishedAt: '2026-04-22T12:00:00.000Z',
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(artifactBytes, { status: 200 }));

    const result = await updatePluginFromMarketplace('hello-plugin', pluginDir, 'nightly', {
      fetchImpl,
      env: { TX5DR_PLUGIN_MARKET_BASE_URL: 'https://cdn.example.com/market' },
    });

    const installedSource = await fs.readFile(path.join(pluginDir, 'hello-plugin', 'index.mjs'), 'utf8');
    expect(result.action).toBe('update');
    expect(installedSource).toContain('1.1.0');
    const sourceFile = JSON.parse(
      await fs.readFile(path.join(pluginDir, 'hello-plugin', PLUGIN_SOURCE_FILE_NAME), 'utf8'),
    ) as {
      source: {
        kind: string;
        version: string;
        channel: string;
      };
    };
    expect(sourceFile.source).toMatchObject({
      kind: 'marketplace',
      version: '1.1.0',
      channel: 'nightly',
    });
  });

  it('uninstalls plugin code but leaves plugin-data untouched', async () => {
    const root = await makeTempDir('tx5dr-market-uninstall-');
    const pluginDir = path.join(root, 'plugins');
    const dataDir = path.join(root, 'plugin-data', 'hello-plugin');
    await fs.mkdir(path.join(pluginDir, 'hello-plugin'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, 'state.json'), '{}', 'utf8');

    const result = await uninstallPluginFromMarketplace('hello-plugin', pluginDir);

    expect(result.action).toBe('uninstall');
    await expect(fs.access(path.join(pluginDir, 'hello-plugin'))).rejects.toThrow();
    await expect(fs.access(path.join(dataDir, 'state.json'))).resolves.toBeUndefined();
  });
});
