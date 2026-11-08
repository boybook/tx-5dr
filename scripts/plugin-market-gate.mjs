import { readReleaseResource } from './release-http.mjs';

export const DEFAULT_PLUGIN_MARKET_INDEX_URL = 'https://dl.tx5dr.com/plugins/market/index.json';

/**
 * Host releases resolve marketplace plugins from the channel-free schema v3
 * index. Publishing a Host before that index is live leaves its marketplace
 * unavailable and gives installed plugins no compatible replacement, so a
 * release fails closed when the index is missing or not schema v3.
 */
export async function assertPluginMarketIndexAvailable(
  url = DEFAULT_PLUGIN_MARKET_INDEX_URL,
  read = readReleaseResource,
) {
  const response = await read(url, 'json');
  if (response.status !== 200) {
    throw new Error(`Plugin marketplace index unavailable (HTTP ${response.status}): ${url}`);
  }
  const index = response.value;
  if (index?.schemaVersion !== 3 || !Array.isArray(index.plugins) || index.plugins.length === 0) {
    throw new Error(`Plugin marketplace index is not a populated schema v3 index: ${url}`);
  }
  return index.plugins.length;
}
