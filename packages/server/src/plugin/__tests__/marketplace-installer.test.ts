import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installPluginFromMarketplace,
  readInstalledMarketplaceVersions,
  uninstallPluginFromMarketplace,
} from '../marketplace-installer.js';
import { PLUGIN_SOURCE_FILE_NAME } from '../plugin-source.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const MARKETPLACE_TEMP_DIR_NAME = '.plugin-market-tmp';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createPluginArchive(
  root: string,
  pluginName: string,
  version: string,
  minPluginApiVersion = '2.0.0',
  includeManifest = true,
): Promise<string> {
  const sourceDir = path.join(root, 'source');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, 'index.mjs'),
    `export default { name: ${JSON.stringify(pluginName)}, version: ${JSON.stringify(version)}, minPluginApiVersion: ${JSON.stringify(minPluginApiVersion)}, type: 'utility' };`,
    'utf8',
  );
  if (includeManifest) {
    await fs.writeFile(path.join(sourceDir, 'tx5dr-plugin.json'), JSON.stringify({
      schemaVersion: 1,
      name: pluginName,
      version,
      minPluginApiVersion,
      type: 'utility',
      instanceScope: 'operator',
      permissions: [],
    }), 'utf8');
  }

  const archivePath = path.join(root, `${pluginName}-${version}.zip`);
  await execFileAsync('zip', ['-qr', archivePath, '.'], { cwd: sourceDir });
  return archivePath;
}

async function createTraversalArchive(root: string, pluginName: string, version: string): Promise<string> {
  const sourceDir = path.join(root, 'source-traversal');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(root, 'escape.txt'), 'escape', 'utf8');
  const archivePath = path.join(root, `${pluginName}-${version}-traversal.zip`);
  await execFileAsync('zip', ['-q', archivePath, '../escape.txt'], { cwd: sourceDir });
  return archivePath;
}

async function createSymlinkArchive(root: string, pluginName: string, version: string): Promise<string> {
  const sourceDir = path.join(root, 'source-symlink');
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(root, 'outside-index.mjs'),
    `export default { name: ${JSON.stringify(pluginName)}, version: ${JSON.stringify(version)}, minPluginApiVersion: '1.0.0', type: 'utility' };`,
    'utf8',
  );
  await fs.symlink('../outside-index.mjs', path.join(sourceDir, 'index.mjs'));
  const archivePath = path.join(root, `${pluginName}-${version}-symlink.zip`);
  await execFileAsync('zip', ['-qry', archivePath, 'index.mjs'], { cwd: sourceDir });
  return archivePath;
}

interface IndexVersion {
  version: string;
  minPluginApiVersion?: string;
  artifactUrl?: string;
  bytes: Uint8Array;
  yanked?: boolean;
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  return (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
}

async function indexResponse(pluginName: string, versions: IndexVersion[]): Promise<Response> {
  return new Response(JSON.stringify({
    schemaVersion: 3,
    generatedAt: '2026-11-07T12:00:00.000Z',
    plugins: [{
      name: pluginName,
      title: 'Hello Plugin',
      description: 'test plugin',
      versions: await Promise.all(versions.map(async (entry) => ({
        version: entry.version,
        minPluginApiVersion: entry.minPluginApiVersion ?? '2.0.0',
        artifactUrl: entry.artifactUrl ?? `https://cdn.example.com/${pluginName}/${entry.version}.zip`,
        sha256: await sha256Of(entry.bytes),
        size: entry.bytes.length,
        publishedAt: '2026-11-07T12:00:00.000Z',
        artifactManifestVersion: 1,
        ...(entry.yanked ? { yanked: true } : {}),
      }))),
    }],
  }), { status: 200 });
}

async function createCatalogFetch(
  archivePath: string,
  pluginName = 'hello-plugin',
  version = '1.0.0',
  artifactUrl = `https://cdn.example.com/${pluginName}-${version}.zip`,
  minPluginApiVersion = '2.0.0',
) {
  const artifactBytes = await fs.readFile(archivePath);
  return {
    artifactBytes,
    fetchImpl: vi.fn()
      .mockResolvedValueOnce(await indexResponse(pluginName, [{
        version,
        minPluginApiVersion,
        artifactUrl,
        bytes: artifactBytes,
      }]))
      .mockResolvedValueOnce(new Response(artifactBytes, { status: 200 })),
  };
}

const MARKET_ENV = { TX5DR_PLUGIN_MARKET_BASE_URL: 'https://cdn.example.com/market' };
const HOST_API = '2.6.0';

async function expectMarketplaceWorkspaceEmpty(root: string): Promise<void> {
  const workspaceDir = path.join(root, MARKETPLACE_TEMP_DIR_NAME);
  const entries = await fs.readdir(workspaceDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  });

  if (entries === null) {
    return;
  }

  expect(entries).toEqual([]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('plugin marketplace installer', () => {
  it('installs the newest compatible version and records it without a channel', async () => {
    const root = await makeTempDir('tx5dr-market-install-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const compatible = await fs.readFile(await createPluginArchive(path.join(root, 'a'), 'hello-plugin', '1.1.0', '2.5.0'));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(await indexResponse('hello-plugin', [
        { version: '1.0.0', minPluginApiVersion: '2.0.0', bytes: Buffer.from('old') },
        { version: '1.1.0', minPluginApiVersion: '2.5.0', bytes: compatible },
        { version: '1.2.0', minPluginApiVersion: '2.7.0', bytes: Buffer.from('needs newer host') },
        { version: '1.1.5', minPluginApiVersion: '2.0.0', bytes: Buffer.from('yanked'), yanked: true },
      ]))
      .mockResolvedValueOnce(new Response(compatible, { status: 200 }));
    const mkdtempSpy = vi.spyOn(fs, 'mkdtemp');

    const result = await installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    });

    expect(result.action).toBe('install');
    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://cdn.example.com/market/index.json', expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://cdn.example.com/hello-plugin/1.1.0.zip', expect.anything());
    await expect(fs.access(path.join(pluginDir, 'hello-plugin', 'index.mjs'))).resolves.toBeUndefined();
    const sourceFile = JSON.parse(
      await fs.readFile(path.join(pluginDir, 'hello-plugin', PLUGIN_SOURCE_FILE_NAME), 'utf8'),
    ) as { schemaVersion: number; source: Record<string, unknown> };
    expect(sourceFile.schemaVersion).toBe(1);
    // `channel` keeps the record readable by Hosts up to v1.0.1 after a downgrade.
    expect(sourceFile.source).toMatchObject({ kind: 'marketplace', version: '1.1.0', channel: 'nightly' });
    expect(mkdtempSpy).toHaveBeenCalledWith(path.join(root, MARKETPLACE_TEMP_DIR_NAME, 'install-'));
    await expectMarketplaceWorkspaceEmpty(root);
    await expect(readInstalledMarketplaceVersions(pluginDir, ['hello-plugin', 'missing', '../escape']))
      .resolves.toEqual(new Map([['hello-plugin', '1.1.0']]));
  });

  it('replaces an incompatible installed plugin with a pinned lower compatible version', async () => {
    const root = await makeTempDir('tx5dr-market-downgrade-');
    const pluginDir = path.join(root, 'plugins');
    const existingDir = path.join(pluginDir, 'hello-plugin');
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, 'index.mjs'), `export default { name: 'hello-plugin', version: '1.2.0', type: 'utility' };`, 'utf8');

    const older = await fs.readFile(await createPluginArchive(path.join(root, 'a'), 'hello-plugin', '1.1.0', '2.5.0'));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(await indexResponse('hello-plugin', [
        { version: '1.1.0', minPluginApiVersion: '2.5.0', bytes: older },
        { version: '1.2.0', minPluginApiVersion: '2.7.0', bytes: Buffer.from('newer') },
      ]))
      .mockResolvedValueOnce(new Response(older, { status: 200 }));

    const result = await installPluginFromMarketplace('hello-plugin', pluginDir, {
      version: '1.1.0',
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    }, 'update');

    expect(result).toMatchObject({ action: 'update', record: { version: '1.1.0' } });
    expect(await fs.readFile(path.join(existingDir, 'index.mjs'), 'utf8')).toContain('1.1.0');
    await expectMarketplaceWorkspaceEmpty(root);
  });

  it('rejects pinned versions that are missing, yanked or incompatible before downloading', async () => {
    const root = await makeTempDir('tx5dr-market-pinned-');
    const pluginDir = path.join(root, 'plugins');
    const versions: IndexVersion[] = [
      { version: '1.0.0', minPluginApiVersion: '2.0.0', bytes: Buffer.from('a'), yanked: true },
      { version: '1.1.0', minPluginApiVersion: '3.0.0', bytes: Buffer.from('b') },
    ];
    for (const [version, expected] of [
      ['9.9.9', { code: 'PLUGIN_MARKET_VERSION_NOT_FOUND' }],
      ['1.0.0', { code: 'PLUGIN_MARKET_VERSION_YANKED' }],
      ['1.1.0', { code: 'PLUGIN_API_VERSION_UNSUPPORTED' }],
    ] as const) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(await indexResponse('hello-plugin', versions));
      await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
        version,
        fetchImpl,
        pluginApiVersion: HOST_API,
        env: MARKET_ENV,
      })).rejects.toMatchObject(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects a plugin missing from the index', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(await indexResponse('other-plugin', [
      { version: '1.0.0', bytes: Buffer.from('a') },
    ]));
    await expect(installPluginFromMarketplace('hello-plugin', '/unused', {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    })).rejects.toMatchObject({ code: 'PLUGIN_MARKET_PLUGIN_NOT_FOUND' });
  });

  it('cleans up the managed temp workspace after an invalid marketplace archive fails', async () => {
    const root = await makeTempDir('tx5dr-market-invalid-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });

    const invalidArtifactBytes = Buffer.from('not-a-zip-archive', 'utf8');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(await indexResponse('hello-plugin', [{ version: '1.0.0', bytes: invalidArtifactBytes }]))
      .mockResolvedValueOnce(new Response(invalidArtifactBytes, { status: 200 }));

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    })).rejects.toThrow();

    await expect(fs.access(path.join(pluginDir, 'hello-plugin'))).rejects.toThrow();
    await expectMarketplaceWorkspaceEmpty(root);
  });

  it('rejects archives that contain parent-directory paths before extraction', async () => {
    const root = await makeTempDir('tx5dr-market-traversal-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });

    const archivePath = await createTraversalArchive(root, 'hello-plugin', '1.0.0');
    const { fetchImpl } = await createCatalogFetch(archivePath);

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    })).rejects.toThrow('Unsafe archive path rejected');

    await expect(fs.access(path.join(pluginDir, 'hello-plugin'))).rejects.toThrow();
    await expectMarketplaceWorkspaceEmpty(root);
  });

  it('rejects archives that contain symbolic links', async () => {
    const root = await makeTempDir('tx5dr-market-symlink-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });

    const archivePath = await createSymlinkArchive(root, 'hello-plugin', '1.0.0');
    const { fetchImpl } = await createCatalogFetch(archivePath);

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    })).rejects.toThrow('symbolic links');

    await expect(fs.access(path.join(pluginDir, 'hello-plugin'))).rejects.toThrow();
    await expectMarketplaceWorkspaceEmpty(root);
  });

  it('rejects non-HTTPS marketplace asset URLs', async () => {
    const root = await makeTempDir('tx5dr-market-http-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });

    const archivePath = await createPluginArchive(root, 'hello-plugin', '1.0.0');
    const { fetchImpl } = await createCatalogFetch(
      archivePath,
      'hello-plugin',
      '1.0.0',
      'http://cdn.example.com/hello-plugin-1.0.0.zip',
    );

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    })).rejects.toThrow('must use HTTPS');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an incompatible catalog before downloading the artifact', async () => {
    const root = await makeTempDir('tx5dr-market-plugin-api-version-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const archivePath = await createPluginArchive(root, 'hello-plugin', '1.0.0', '2.0.0');
    const { fetchImpl } = await createCatalogFetch(
      archivePath,
      'hello-plugin',
      '1.0.0',
      'https://cdn.example.com/hello-plugin-1.0.0.zip',
      '2.0.0',
    );

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: '1.9.9',
      env: MARKET_ENV,
    })).rejects.toMatchObject({ code: 'PLUGIN_API_VERSION_UNSUPPORTED' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(pluginDir, 'hello-plugin'))).rejects.toThrow();
  });

  it('rejects an artifact whose embedded version differs from the catalog', async () => {
    const root = await makeTempDir('tx5dr-market-artifact-version-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const archivePath = await createPluginArchive(root, 'hello-plugin', '0.9.0');
    const { fetchImpl } = await createCatalogFetch(archivePath, 'hello-plugin', '1.0.0');

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: HOST_API,
      env: MARKET_ENV,
    })).rejects.toThrow('Plugin archive version mismatch');

    await expectMarketplaceWorkspaceEmpty(root);
  });

  it('rejects an artifact whose embedded Plugin API requirement differs from the catalog', async () => {
    const root = await makeTempDir('tx5dr-market-artifact-plugin-api-version-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const archivePath = await createPluginArchive(root, 'hello-plugin', '1.0.0', '1.1.0');
    const { fetchImpl } = await createCatalogFetch(archivePath, 'hello-plugin', '1.0.0');

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: '2.0.0',
      env: MARKET_ENV,
    })).rejects.toThrow('Plugin archive Plugin API requirement mismatch');

    await expectMarketplaceWorkspaceEmpty(root);
  });

  it('requires a static artifact manifest', async () => {
    const root = await makeTempDir('tx5dr-market-artifact-manifest-');
    const pluginDir = path.join(root, 'plugins');
    await fs.mkdir(pluginDir, { recursive: true });
    const archivePath = await createPluginArchive(
      root,
      'hello-plugin',
      '1.0.0',
      '1.0.0',
      false,
    );
    const { fetchImpl } = await createCatalogFetch(archivePath);

    await expect(installPluginFromMarketplace('hello-plugin', pluginDir, {
      fetchImpl,
      pluginApiVersion: '2.1.0',
      env: MARKET_ENV,
    })).rejects.toThrow('missing tx5dr-plugin.json');

    await expectMarketplaceWorkspaceEmpty(root);
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
