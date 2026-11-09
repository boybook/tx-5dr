import { describe, expect, it } from 'vitest';
import type { PluginMarketListing, PluginMarketVersion, PluginStatus } from '@tx5dr/contracts';
import { buildMarketItemState, getMarketItemStatus, isPrimaryMarketItem } from '../marketplaceItems';

function version(value: string, min = '2.0.0'): PluginMarketVersion {
  return {
    version: value,
    minPluginApiVersion: min,
    artifactUrl: `https://cdn.example.com/demo/${value}.zip`,
    sha256: '0'.repeat(64),
    size: 1,
    publishedAt: '2026-11-07T12:00:00.000Z',
    permissions: [],
    artifactManifestVersion: 1,
    yanked: false,
  };
}

function listing(overrides: Partial<PluginMarketListing>): PluginMarketListing {
  const latest = overrides.latest ?? version('1.0.0');
  return {
    name: 'demo',
    title: 'Demo',
    description: 'demo',
    categories: [],
    keywords: [],
    screenshots: [],
    versions: [latest],
    latest,
    installable: latest,
    availability: 'compatible',
    ...overrides,
  };
}

function loaded(versionValue: string): Map<string, PluginStatus> {
  return new Map([['demo', {
    name: 'demo',
    type: 'utility',
    instanceScope: 'operator',
    version: versionValue,
    isBuiltIn: false,
    loaded: true,
    enabled: true,
    autoDisabled: false,
    errorCount: 0,
    source: {
      kind: 'marketplace',
      version: versionValue,
      artifactUrl: 'https://cdn.example.com/demo.zip',
      sha256: '0'.repeat(64),
      installedAt: 1,
    },
  } as PluginStatus]]);
}

describe('marketplace item state', () => {
  it('offers an update to the newest compatible version', () => {
    const item = buildMarketItemState(listing({
      latest: version('1.2.0', '2.7.0'),
      installable: version('1.1.0'),
      installed: { version: '1.0.0', compatible: true },
    }), loaded('1.0.0'));

    expect(item).toMatchObject({ hasUpdate: true, isDowngrade: false, newerNeedsHostUpgrade: true });
    expect(item.target?.version).toBe('1.1.0');
  });

  it('offers a confirmed downgrade when the installed version did not load', () => {
    const item = buildMarketItemState(listing({
      latest: version('1.2.0', '2.7.0'),
      installable: version('1.1.0'),
      installed: { version: '1.2.0', compatible: false },
    }), new Map());

    expect(item).toMatchObject({
      isInstalled: true,
      isMarketplaceManaged: true,
      installedIncompatible: true,
      needsCompatibleReplacement: true,
      isDowngrade: true,
      hasUpdate: false,
    });
  });

  it('offers a compatible upgrade for an outdated installed version', () => {
    const item = buildMarketItemState(listing({
      latest: version('2.0.0', '2.6.0'),
      installable: version('2.0.0', '2.6.0'),
      installed: { version: '1.0.0', compatible: false },
    }), new Map());

    expect(item).toMatchObject({ needsCompatibleReplacement: true, isDowngrade: false });
  });

  it('offers a normal update for a legacy installed version that still loads', () => {
    const item = buildMarketItemState(listing({
      latest: version('1.1.0', '2.0.0'),
      installable: version('1.1.0', '2.0.0'),
      installed: { version: '1.0.0', compatible: true, legacy: true },
    }), loaded('1.0.0'));

    expect(item).toMatchObject({
      installedLegacy: true,
      installedIncompatible: false,
      hasUpdate: true,
      needsCompatibleReplacement: false,
    });
  });

  it('collapses only unsupported plugins that are not installed', () => {
    const unsupported = listing({
      latest: version('1.0.0', '1.2.0'),
      installable: null,
      availability: 'plugin-outdated',
    });

    expect(isPrimaryMarketItem(buildMarketItemState(unsupported, new Map()))).toBe(false);
    expect(isPrimaryMarketItem(buildMarketItemState({
      ...unsupported,
      installed: { version: '1.0.0', compatible: false },
    }, new Map()))).toBe(true);
    expect(isPrimaryMarketItem(buildMarketItemState(listing({}), new Map()))).toBe(true);
  });

  it('treats a loaded plugin without a marketplace record as a manual install', () => {
    const manual = loaded('1.0.0');
    manual.set('demo', { ...manual.get('demo')!, source: undefined });
    expect(buildMarketItemState(listing({}), manual)).toMatchObject({
      isManualInstall: true,
      isMarketplaceManaged: false,
      hasUpdate: false,
    });
  });

  it('reports the single most actionable status for a list row', () => {
    const status = (item: PluginMarketListing, installed = new Map<string, PluginStatus>()) => (
      getMarketItemStatus(buildMarketItemState(item, installed))
    );
    expect(status(listing({}))).toBeNull();
    expect(status(listing({ installed: { version: '1.0.0', compatible: true } }), loaded('1.0.0'))).toBe('installed');
    expect(status(listing({
      latest: version('1.1.0'),
      installed: { version: '1.0.0', compatible: true, legacy: true },
    }), loaded('1.0.0'))).toBe('update');
    expect(status(listing({ installed: { version: '1.0.0', compatible: true, legacy: true } }), loaded('1.0.0'))).toBe('legacy');
    expect(status(listing({ installed: { version: '1.0.0', compatible: false } }))).toBe('incompatible');
    expect(status(listing({ installable: null, availability: 'host-upgrade-required' }))).toBe('unsupported');
    const manual = loaded('1.0.0');
    manual.set('demo', { ...manual.get('demo')!, source: undefined });
    expect(status(listing({}), manual)).toBe('manual');
  });
});
