import type {
  PluginMarketListing,
  PluginMarketVersion,
  PluginSource,
  PluginStatus,
} from '@tx5dr/contracts';

export type MarketplaceSource = Extract<PluginSource, { kind: 'marketplace' }>;

/**
 * Presentation state for one marketplace listing. Version selection and
 * compatibility are resolved by the Host; this only combines that result with
 * the locally loaded plugin snapshot.
 */
export interface MarketItemState {
  listing: PluginMarketListing;
  installedPlugin?: PluginStatus;
  installRecord?: MarketplaceSource;
  installedVersion?: string;
  isInstalled: boolean;
  isBuiltIn: boolean;
  isMarketplaceManaged: boolean;
  isManualInstall: boolean;
  /** The installed version cannot run on this Host, so the loader rejected it. */
  installedIncompatible: boolean;
  /** The installed version runs only through the legacy Plugin API window. */
  installedLegacy: boolean;
  /** Exact version an install/update action installs; null when none is compatible. */
  target: PluginMarketVersion | null;
  /** Version shown for requirements and metadata. */
  displayVersion: PluginMarketVersion;
  hasUpdate: boolean;
  /** Installed version is incompatible and a compatible replacement exists. */
  needsCompatibleReplacement: boolean;
  /** Replacing the installed version installs a lower version. */
  isDowngrade: boolean;
  /** A newer version exists that needs a newer Plugin API than this Host. */
  newerNeedsHostUpgrade: boolean;
  isSupported: boolean;
}

function parseSemverLike(value: string): { main: number[]; prerelease: string[] } {
  const normalized = value.trim();
  const [mainPart, prereleasePart = ''] = normalized.split('-', 2);
  const main = mainPart
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((segment) => (Number.isFinite(segment) ? segment : 0));
  const prerelease = prereleasePart
    ? prereleasePart.split('.').filter(Boolean)
    : [];
  return { main, prerelease };
}

export function compareSemverLike(left: string, right: string): number {
  const leftVersion = parseSemverLike(left);
  const rightVersion = parseSemverLike(right);
  const length = Math.max(leftVersion.main.length, rightVersion.main.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftVersion.main[index] ?? 0;
    const rightValue = rightVersion.main[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length === 0) {
    return 0;
  }
  if (leftVersion.prerelease.length === 0) {
    return 1;
  }
  if (rightVersion.prerelease.length === 0) {
    return -1;
  }

  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftValue = leftVersion.prerelease[index];
    const rightValue = rightVersion.prerelease[index];
    if (leftValue === rightValue) {
      continue;
    }
    if (leftValue === undefined) {
      return -1;
    }
    if (rightValue === undefined) {
      return 1;
    }

    const leftNumeric = Number.parseInt(leftValue, 10);
    const rightNumeric = Number.parseInt(rightValue, 10);
    const bothNumeric = Number.isFinite(leftNumeric) && Number.isFinite(rightNumeric);
    if (bothNumeric && leftNumeric !== rightNumeric) {
      return leftNumeric > rightNumeric ? 1 : -1;
    }

    const lexical = leftValue.localeCompare(rightValue);
    if (lexical !== 0) {
      return lexical > 0 ? 1 : -1;
    }
  }

  return 0;
}

export function buildMarketItemState(
  listing: PluginMarketListing,
  installedPluginsByName: Map<string, PluginStatus>,
): MarketItemState {
  const installedPlugin = installedPluginsByName.get(listing.name);
  const loadedRecord = installedPlugin?.source?.kind === 'marketplace'
    ? installedPlugin.source
    : undefined;
  const isBuiltIn = installedPlugin?.isBuiltIn ?? false;
  // `listing.installed` comes from the on-disk record, so it also covers a
  // marketplace plugin that the loader rejected as incompatible.
  const isInstalled = Boolean(installedPlugin) || Boolean(listing.installed);
  const installedVersion = installedPlugin?.version ?? loadedRecord?.version ?? listing.installed?.version;
  const isMarketplaceManaged = isInstalled && !isBuiltIn && Boolean(loadedRecord || listing.installed);
  const isManualInstall = Boolean(installedPlugin) && !isBuiltIn && !loadedRecord && !listing.installed;
  const installedIncompatible = isMarketplaceManaged && listing.installed?.compatible === false;
  const installedLegacy = installedPlugin?.pluginApiCompatibility === 'legacy' || listing.installed?.legacy === true;
  const target = listing.installable;
  const versionComparison = target && installedVersion
    ? compareSemverLike(target.version, installedVersion)
    : 0;
  const needsCompatibleReplacement = installedIncompatible && Boolean(target) && versionComparison !== 0;

  return {
    listing,
    installedPlugin,
    installRecord: loadedRecord,
    installedVersion,
    isInstalled,
    isBuiltIn,
    isMarketplaceManaged,
    isManualInstall,
    installedIncompatible,
    installedLegacy,
    target,
    displayVersion: target ?? listing.latest,
    hasUpdate: isMarketplaceManaged && !installedIncompatible && Boolean(target) && versionComparison > 0,
    needsCompatibleReplacement,
    isDowngrade: needsCompatibleReplacement && versionComparison < 0,
    newerNeedsHostUpgrade: Boolean(target) && compareSemverLike(listing.latest.version, target!.version) > 0,
    isSupported: listing.availability === 'compatible',
  };
}

export function getActionPriority(item: MarketItemState): number {
  if (item.needsCompatibleReplacement || item.installedIncompatible) return 5;
  if (item.hasUpdate) return 4;
  if (item.isInstalled) return 2;
  return 1;
}

/**
 * The single status a compact list row shows, most actionable first. `null`
 * means the plugin is simply available to install.
 */
export type MarketItemStatus =
  | 'incompatible'
  | 'update'
  | 'legacy'
  | 'installed'
  | 'manual'
  | 'unsupported'
  | null;

export function getMarketItemStatus(item: MarketItemState): MarketItemStatus {
  if (item.installedIncompatible) return 'incompatible';
  if (item.hasUpdate) return 'update';
  if (item.installedLegacy) return 'legacy';
  if (item.isMarketplaceManaged) return 'installed';
  if (item.isManualInstall) return 'manual';
  if (!item.isSupported && !item.isInstalled) return 'unsupported';
  return null;
}

/** Installed plugins stay in the main list even when no compatible version exists. */
export function isPrimaryMarketItem(item: MarketItemState): boolean {
  return item.isSupported || item.isInstalled;
}
