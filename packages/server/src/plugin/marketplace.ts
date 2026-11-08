import {
  PluginMarketIndexEnvelopeSchema,
  PluginMarketPluginEnvelopeSchema,
  PluginMarketVersionSchema,
  type PluginMarketAvailability,
  type PluginMarketCatalogResponse,
  type PluginMarketIndex,
  type PluginMarketInstalledVersion,
  type PluginMarketListing,
  type PluginMarketPlugin,
  type PluginMarketVersion,
} from '@tx5dr/contracts';
import {
  comparePluginApiVersions,
  getPluginApiCompatibility,
  isPluginApiCompatible,
  PluginApiCompatibilityError,
} from './runtime-info.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginMarketplace');

const DEFAULT_PLUGIN_MARKET_BASE_URL = 'https://dl.tx5dr.com/plugins/market';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function ensureAbsoluteUrl(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimTrailingSlash(trimmed);
  }
  if (trimmed.startsWith('//')) {
    return trimTrailingSlash(`https:${trimmed}`);
  }
  return trimTrailingSlash(`https://${trimmed.replace(/^\/+/, '')}`);
}

export function resolvePluginMarketBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TX5DR_PLUGIN_MARKET_BASE_URL?.trim();
  return ensureAbsoluteUrl(explicit || DEFAULT_PLUGIN_MARKET_BASE_URL);
}

/** The single channel-free marketplace index (catalog schema v3). */
export function resolvePluginMarketIndexUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolvePluginMarketBaseUrl(env)}/index.json`;
}

export interface FetchPluginMarketIndexResult {
  index: PluginMarketIndex;
  sourceUrl: string;
}

export interface PluginMarketFetchOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export async function fetchPluginMarketIndex(
  options: PluginMarketFetchOptions = {},
): Promise<FetchPluginMarketIndexResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sourceUrl = resolvePluginMarketIndexUrl(options.env);
  const response = await fetchImpl(sourceUrl, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Marketplace index request failed: ${response.status} ${response.statusText}`);
  }

  return { index: parsePluginMarketIndex(await response.json()), sourceUrl };
}

/**
 * Reads a schema v3 index entry by entry. Versions or plugins this Host cannot
 * read (for example a permission added by a newer Plugin API) are skipped and
 * logged, so one future entry never disables the whole marketplace.
 */
export function parsePluginMarketIndex(payload: unknown): PluginMarketIndex {
  const envelope = PluginMarketIndexEnvelopeSchema.parse(payload);
  const plugins: PluginMarketPlugin[] = [];
  const seen = new Set<string>();
  let skippedVersions = 0;
  let skippedPlugins = 0;

  for (const rawPlugin of envelope.plugins) {
    const plugin = PluginMarketPluginEnvelopeSchema.safeParse(rawPlugin);
    if (!plugin.success || seen.has(plugin.data.name)) {
      skippedPlugins += 1;
      continue;
    }
    const versions: PluginMarketVersion[] = [];
    const versionNames = new Set<string>();
    for (const rawVersion of plugin.data.versions) {
      const version = PluginMarketVersionSchema.safeParse(rawVersion);
      if (!version.success || versionNames.has(version.data.version)) {
        skippedVersions += 1;
        continue;
      }
      versionNames.add(version.data.version);
      versions.push(version.data);
    }
    if (versions.length === 0) {
      skippedPlugins += 1;
      continue;
    }
    seen.add(plugin.data.name);
    plugins.push({ ...plugin.data, versions });
  }

  if (skippedPlugins > 0 || skippedVersions > 0) {
    logger.warn('Skipped unreadable marketplace entries', { skippedPlugins, skippedVersions });
  }
  return { schemaVersion: 3, generatedAt: envelope.generatedAt, plugins };
}

/** Error raised when a requested marketplace plugin or version cannot be used. */
export class PluginMarketVersionError extends Error {
  constructor(
    readonly code: 'PLUGIN_MARKET_PLUGIN_NOT_FOUND' | 'PLUGIN_MARKET_VERSION_NOT_FOUND' | 'PLUGIN_MARKET_VERSION_YANKED',
    message: string,
  ) {
    super(message);
    this.name = 'PluginMarketVersionError';
  }
}

function compareVersionsDescending(left: PluginMarketVersion, right: PluginMarketVersion): number {
  return -(comparePluginApiVersions(left.version, right.version) ?? 0);
}

function selectableVersions(plugin: PluginMarketPlugin): PluginMarketVersion[] {
  return plugin.versions.filter((entry) => !entry.yanked).sort(compareVersionsDescending);
}

/**
 * Resolves one marketplace plugin against the Host's bundled Plugin API.
 *
 * Returns `null` when every version is yanked, so the plugin is not offered.
 */
export function resolvePluginMarketListing(
  plugin: PluginMarketPlugin,
  pluginApiVersion: string,
  installedVersion?: string,
): PluginMarketListing | null {
  const candidates = selectableVersions(plugin);
  const latest = candidates[0];
  if (!latest) return null;

  const installable = candidates.find((entry) => (
    isPluginApiCompatible(entry.minPluginApiVersion, pluginApiVersion)
  )) ?? null;

  let availability: PluginMarketAvailability = 'compatible';
  if (!installable) {
    const latestNeedsNewerHost = (comparePluginApiVersions(pluginApiVersion, latest.minPluginApiVersion) ?? -1) < 0;
    availability = latestNeedsNewerHost ? 'host-upgrade-required' : 'plugin-outdated';
  }

  let installed: PluginMarketInstalledVersion | undefined;
  if (installedVersion) {
    const record = plugin.versions.find((entry) => entry.version === installedVersion);
    // Mirrors the loader: legacy-window versions still load, so they are
    // compatible here but flagged so the UI can recommend an update.
    const compatibility = record ? getPluginApiCompatibility(record.minPluginApiVersion, pluginApiVersion) : undefined;
    installed = {
      version: installedVersion,
      ...(compatibility ? { compatible: compatibility === 'compatible' || compatibility === 'legacy' } : {}),
      ...(compatibility === 'legacy' ? { legacy: true } : {}),
    };
  }

  return {
    ...plugin,
    latest,
    installable,
    availability,
    ...(installed ? { installed } : {}),
  };
}

export function buildPluginMarketCatalogResponse(
  result: FetchPluginMarketIndexResult,
  pluginApiVersion: string,
  installedVersions: ReadonlyMap<string, string> = new Map(),
): PluginMarketCatalogResponse {
  const plugins = result.index.plugins
    .map((plugin) => resolvePluginMarketListing(plugin, pluginApiVersion, installedVersions.get(plugin.name)))
    .filter((plugin): plugin is PluginMarketListing => plugin !== null);
  return {
    sourceUrl: result.sourceUrl,
    generatedAt: result.index.generatedAt,
    pluginApiVersion,
    plugins,
  };
}

/**
 * Chooses the exact version to install.
 *
 * With `requestedVersion`, that version must exist, must not be yanked, and
 * must be compatible. Without it, the newest compatible version is chosen.
 */
export function selectPluginMarketInstallVersion(
  plugin: PluginMarketPlugin,
  pluginApiVersion: string,
  requestedVersion?: string,
): PluginMarketVersion {
  if (requestedVersion) {
    const entry = plugin.versions.find((candidate) => candidate.version === requestedVersion);
    if (!entry) {
      throw new PluginMarketVersionError(
        'PLUGIN_MARKET_VERSION_NOT_FOUND',
        `Plugin version not found in marketplace: ${plugin.name}@${requestedVersion}`,
      );
    }
    if (entry.yanked) {
      throw new PluginMarketVersionError(
        'PLUGIN_MARKET_VERSION_YANKED',
        `Plugin version was withdrawn from marketplace: ${plugin.name}@${requestedVersion}`,
      );
    }
    if (!isPluginApiCompatible(entry.minPluginApiVersion, pluginApiVersion)) {
      throw new PluginApiCompatibilityError(pluginApiVersion, entry.minPluginApiVersion, plugin.name);
    }
    return entry;
  }

  const listing = resolvePluginMarketListing(plugin, pluginApiVersion);
  if (!listing) {
    throw new PluginMarketVersionError(
      'PLUGIN_MARKET_VERSION_NOT_FOUND',
      `Plugin has no available marketplace version: ${plugin.name}`,
    );
  }
  if (!listing.installable) {
    throw new PluginApiCompatibilityError(pluginApiVersion, listing.latest.minPluginApiVersion, plugin.name);
  }
  return listing.installable;
}

export function findPluginMarketPlugin(index: PluginMarketIndex, pluginName: string): PluginMarketPlugin {
  const plugin = index.plugins.find((entry) => entry.name === pluginName);
  if (!plugin) {
    throw new PluginMarketVersionError(
      'PLUGIN_MARKET_PLUGIN_NOT_FOUND',
      `Plugin not found in marketplace: ${pluginName}`,
    );
  }
  return plugin;
}
