import { describe, expect, it, vi } from 'vitest';
import { PluginMarketPluginSchema, type PluginMarketPlugin } from '@tx5dr/contracts';
import {
  buildPluginMarketCatalogResponse,
  fetchPluginMarketIndex,
  parsePluginMarketIndex,
  resolvePluginMarketBaseUrl,
  resolvePluginMarketIndexUrl,
  resolvePluginMarketListing,
  selectPluginMarketInstallVersion,
} from '../marketplace.js';

const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function plugin(versions: Array<[version: string, min: string, yanked?: boolean]>): PluginMarketPlugin {
  return PluginMarketPluginSchema.parse({
    name: 'hello-plugin',
    title: 'Hello Plugin',
    description: 'test plugin',
    versions: versions.map(([version, minPluginApiVersion, yanked]) => ({
      version,
      minPluginApiVersion,
      artifactUrl: `https://cdn.example.com/hello-plugin/${version}.zip`,
      sha256: SHA,
      size: 1,
      publishedAt: '2026-11-07T12:00:00.000Z',
      artifactManifestVersion: 1,
      ...(yanked ? { yanked: true } : {}),
    })),
  });
}

describe('plugin marketplace index', () => {
  it('resolves the default OSS-only index url', () => {
    expect(resolvePluginMarketBaseUrl({} as NodeJS.ProcessEnv)).toBe('https://dl.tx5dr.com/plugins/market');
    expect(resolvePluginMarketIndexUrl({} as NodeJS.ProcessEnv)).toBe('https://dl.tx5dr.com/plugins/market/index.json');
  });

  it('builds the index url from an env override', () => {
    expect(resolvePluginMarketIndexUrl({
      TX5DR_PLUGIN_MARKET_BASE_URL: 'cdn.example.com/custom-market/',
    })).toBe('https://cdn.example.com/custom-market/index.json');
  });

  it('fetches and validates the v3 index', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 3,
      generatedAt: '2026-11-07T12:00:00.000Z',
      plugins: [plugin([['1.0.0', '2.0.0']])],
    }), { status: 200 }));

    const result = await fetchPluginMarketIndex({
      fetchImpl,
      env: { TX5DR_PLUGIN_MARKET_BASE_URL: 'https://cdn.example.com/market' },
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example.com/market/index.json',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) }),
    );
    expect(result.index.plugins[0]?.versions[0]?.version).toBe('1.0.0');
  });

  it('skips unreadable versions and plugins instead of rejecting the whole index', () => {
    const current = plugin([['1.0.0', '2.0.0']]);
    const index = parsePluginMarketIndex({
      schemaVersion: 3,
      generatedAt: 'now',
      plugins: [
        {
          ...current,
          versions: [
            ...current.versions,
            { ...current.versions[0], version: '2.0.0', permissions: ['radio:future-capability'] },
            { ...current.versions[0], version: '3.0.0', artifactManifestVersion: 2 },
            { ...current.versions[0], version: '1.0.0' },
          ],
        },
        { ...current, name: 'future-only', versions: [{ ...current.versions[0], artifactManifestVersion: 2 }] },
        { name: 'broken' },
        current,
      ],
    });

    expect(index.plugins.map((entry) => entry.name)).toEqual(['hello-plugin']);
    expect(index.plugins[0]?.versions.map((entry) => entry.version)).toEqual(['1.0.0']);
    expect(() => parsePluginMarketIndex({ schemaVersion: 4, generatedAt: 'now', plugins: [] })).toThrow();
  });

  it('rejects legacy channel catalogs', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 2,
      generatedAt: '2026-11-07T12:00:00.000Z',
      channel: 'nightly',
      plugins: [],
    }), { status: 200 }));

    await expect(fetchPluginMarketIndex({ fetchImpl })).rejects.toThrow();
  });
});

describe('plugin marketplace version resolution', () => {
  const history = plugin([
    ['1.0.0', '1.2.0'],
    ['1.10.0', '2.5.0'],
    ['1.9.0', '2.0.0'],
    ['1.11.0', '2.6.0', true],
    ['2.0.0', '2.7.0'],
  ]);

  it('selects the newest compatible non-yanked version by SemVer order', () => {
    const listing = resolvePluginMarketListing(history, '2.6.0');
    expect(listing).toMatchObject({
      availability: 'compatible',
      latest: { version: '2.0.0' },
      installable: { version: '1.10.0' },
    });
  });

  it('reports a Host upgrade when every candidate needs a newer Plugin API', () => {
    expect(resolvePluginMarketListing(plugin([['1.0.0', '2.7.0']]), '2.6.0')).toMatchObject({
      availability: 'host-upgrade-required',
      installable: null,
    });
  });

  it('reports an outdated plugin when candidates target an older Plugin API major', () => {
    expect(resolvePluginMarketListing(plugin([['1.0.0', '1.7.8']]), '2.6.0')).toMatchObject({
      availability: 'plugin-outdated',
      installable: null,
    });
  });

  it('reports installed compatibility from the version history', () => {
    expect(resolvePluginMarketListing(history, '2.6.0', '1.0.0')?.installed)
      .toEqual({ version: '1.0.0', compatible: true, legacy: true });
    expect(resolvePluginMarketListing(plugin([['1.0.0', '0.9.0']]), '2.6.0', '1.0.0')?.installed)
      .toEqual({ version: '1.0.0', compatible: false });
    expect(resolvePluginMarketListing(plugin([['1.0.0', '2.7.0']]), '2.6.0', '1.0.0')?.installed)
      .toEqual({ version: '1.0.0', compatible: false });
    expect(resolvePluginMarketListing(history, '2.6.0', '1.9.0')?.installed)
      .toEqual({ version: '1.9.0', compatible: true });
    expect(resolvePluginMarketListing(history, '2.6.0', '0.1.0')?.installed)
      .toEqual({ version: '0.1.0' });
  });

  it('hides plugins whose versions are all yanked', () => {
    const yanked = plugin([['1.0.0', '2.0.0', true]]);
    expect(resolvePluginMarketListing(yanked, '2.6.0')).toBeNull();
    expect(buildPluginMarketCatalogResponse({
      sourceUrl: 'https://cdn.example.com/index.json',
      index: { schemaVersion: 3, generatedAt: 'now', plugins: [yanked, history] },
    }, '2.6.0').plugins.map((entry) => entry.name)).toEqual(['hello-plugin']);
  });

  it('selects pinned or newest compatible install versions', () => {
    expect(selectPluginMarketInstallVersion(history, '2.6.0').version).toBe('1.10.0');
    expect(selectPluginMarketInstallVersion(history, '2.6.0', '1.9.0').version).toBe('1.9.0');
    expect(() => selectPluginMarketInstallVersion(history, '2.6.0', '2.0.0'))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_API_VERSION_UNSUPPORTED' }));
    expect(() => selectPluginMarketInstallVersion(history, '2.6.0', '1.11.0'))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_MARKET_VERSION_YANKED' }));
    expect(() => selectPluginMarketInstallVersion(plugin([['1.0.0', '1.2.0']]), '2.6.0'))
      .toThrow(expect.objectContaining({ code: 'PLUGIN_API_VERSION_UNSUPPORTED' }));
  });
});
