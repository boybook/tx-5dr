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

/**
 * How a plugin's `minPluginApiVersion` relates to a Host's bundled Plugin API.
 *
 * - `compatible`: the Host satisfies `^minPluginApiVersion`.
 * - `legacy`: the plugin targets an earlier major still inside
 *   {@link PLUGIN_API_LEGACY_MAJOR_WINDOW}; the Host loads it with a warning.
 * - `requires-newer-host`: the plugin needs a newer Plugin API than the Host has.
 * - `unsupported`: the plugin targets a major outside the legacy window, or a
 *   version is not valid SemVer.
 */
export type PluginApiCompatibility = 'compatible' | 'legacy' | 'requires-newer-host' | 'unsupported';

/**
 * Number of earlier Plugin API majors whose plugins a Host still loads.
 *
 * Plugins built for the previous major already ran on Hosts of the current
 * major before caret matching existed, so rejecting them would only break
 * working installations. They load as `legacy`; the marketplace still installs
 * only caret-compatible versions. Lowering this to 0 retires the window.
 */
export const PLUGIN_API_LEGACY_MAJOR_WINDOW = 1;

/** Classifies a plugin requirement against a Host Plugin API version. */
export function getPluginApiCompatibility(
  minPluginApiVersion: string,
  pluginApiVersion: string,
): PluginApiCompatibility {
  const required = parseSemver(minPluginApiVersion);
  const current = parseSemver(pluginApiVersion);
  if (!required || !current) return 'unsupported';
  const comparison = comparePluginApiVersions(pluginApiVersion, minPluginApiVersion);
  if (comparison === null) return 'unsupported';
  if (comparison < 0) return 'requires-newer-host';
  if (required.major > 0) {
    if (current.major === required.major) return 'compatible';
    return current.major - required.major <= PLUGIN_API_LEGACY_MAJOR_WINDOW ? 'legacy' : 'unsupported';
  }
  if (required.minor > 0) {
    return current.major === 0 && current.minor === required.minor ? 'compatible' : 'unsupported';
  }
  return current.major === 0 && current.minor === 0 && current.patch === required.patch
    ? 'compatible'
    : 'unsupported';
}

/**
 * Returns whether a Host's bundled Plugin API satisfies a plugin's requirement.
 *
 * Compatibility follows npm caret (`^`) semantics on `minPluginApiVersion`:
 * the Host version must be at least the requirement and must not cross the
 * next breaking boundary. For `X.Y.Z` with `X > 0` that boundary is the next
 * major; for `0.Y.Z` it is the next minor; for `0.0.Z` only that patch matches.
 * Returns `false` when either version is not valid SemVer. Legacy-window
 * plugins are not compatible here; see {@link getPluginApiCompatibility}.
 */
export function isPluginApiCompatible(minPluginApiVersion: string, pluginApiVersion: string): boolean {
  return getPluginApiCompatibility(minPluginApiVersion, pluginApiVersion) === 'compatible';
}

/** Stable error returned when a plugin's Plugin API requirement is not satisfied. */
export class PluginApiCompatibilityError extends Error {
  /** Machine-readable compatibility failure code. */
  readonly code = 'PLUGIN_API_VERSION_UNSUPPORTED' as const;

  /** Captures the available version, required caret range, and optional plugin identity. */
  constructor(
    readonly pluginApiVersion: string,
    readonly minPluginApiVersion: string,
    readonly pluginName?: string,
    readonly compatibility: Exclude<PluginApiCompatibility, 'compatible' | 'legacy'> =
      getPluginApiCompatibility(minPluginApiVersion, pluginApiVersion) === 'requires-newer-host'
        ? 'requires-newer-host'
        : 'unsupported',
  ) {
    super(
      `PLUGIN_API_VERSION_UNSUPPORTED: ${pluginName ? `plugin ${pluginName} ` : 'plugin '}`
      + `requires Plugin API ^${minPluginApiVersion}; bundled Plugin API is ${pluginApiVersion}`,
    );
    this.name = 'PluginApiCompatibilityError';
  }
}

/**
 * Throws when a Host cannot satisfy a plugin's requirement and returns the
 * accepted classification. `allowLegacy` accepts plugins inside the legacy
 * major window; only the Host loader uses it.
 */
export function assertPluginApiCompatible(
  minPluginApiVersion: string | undefined,
  pluginName: string | undefined,
  pluginApiVersion: string | undefined,
  options: { allowLegacy?: boolean } = {},
): 'compatible' | 'legacy' {
  if (!minPluginApiVersion) return 'compatible';
  const currentVersion = pluginApiVersion?.trim() || 'unavailable';
  const compatibility = getPluginApiCompatibility(minPluginApiVersion, currentVersion);
  if (compatibility === 'compatible' || (compatibility === 'legacy' && options.allowLegacy)) {
    return compatibility;
  }
  throw new PluginApiCompatibilityError(currentVersion, minPluginApiVersion, pluginName);
}
