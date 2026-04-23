import {
  PluginMarketCatalogSchema,
  type PluginMarketCatalog,
  type PluginMarketChannel,
} from '@tx5dr/contracts';

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

export function resolvePluginMarketCatalogUrl(
  channel: PluginMarketChannel,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolvePluginMarketBaseUrl(env)}/${channel}/index.json`;
}

export interface FetchPluginMarketCatalogResult {
  catalog: PluginMarketCatalog;
  sourceUrl: string;
}

export async function fetchPluginMarketCatalog(
  channel: PluginMarketChannel,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<FetchPluginMarketCatalogResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sourceUrl = resolvePluginMarketCatalogUrl(channel, options.env);
  const response = await fetchImpl(sourceUrl, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Marketplace catalog request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const catalog = PluginMarketCatalogSchema.parse(payload);
  if (catalog.channel !== channel) {
    throw new Error(`Marketplace catalog channel mismatch: expected ${channel}, received ${catalog.channel}`);
  }

  return { catalog, sourceUrl };
}
