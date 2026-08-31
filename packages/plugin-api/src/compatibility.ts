interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Compares Plugin API semantic versions. Build metadata is intentionally ignored. */
export function comparePluginApiVersions(left: string, right: string): number | null {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export class PluginApiCompatibilityError extends Error {
  readonly code = 'PLUGIN_API_VERSION_UNSUPPORTED' as const;

  constructor(
    readonly pluginApiVersion: string,
    readonly minPluginApiVersion: string,
    readonly pluginName?: string,
  ) {
    super(
      `PLUGIN_API_VERSION_UNSUPPORTED: ${pluginName ? `plugin ${pluginName} ` : 'plugin '}`
      + `requires Plugin API >= ${minPluginApiVersion}; bundled Plugin API is ${pluginApiVersion}`,
    );
    this.name = 'PluginApiCompatibilityError';
  }
}

/** Throws when a Host cannot prove it satisfies a plugin's Plugin API floor. */
export function assertPluginApiCompatible(
  minPluginApiVersion: string | undefined,
  pluginName: string | undefined,
  pluginApiVersion: string | undefined,
): void {
  if (!minPluginApiVersion) return;
  const currentVersion = pluginApiVersion?.trim() || 'unavailable';
  const comparison = comparePluginApiVersions(currentVersion, minPluginApiVersion);
  if (comparison === null || comparison < 0) {
    throw new PluginApiCompatibilityError(currentVersion, minPluginApiVersion, pluginName);
  }
}
