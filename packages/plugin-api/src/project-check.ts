// Author-side checks behind the `tx5dr-plugin check` bin. They mirror what the Host
// loader and the official marketplace enforce, so authors find problems before
// users do. Keep them consistent with `assertPluginApiCompatible` and the
// marketplace validator in boybook/tx-5dr-plugins.

import { comparePluginApiVersions } from './compatibility.js';
import { PLUGIN_COMMAND_CAPABILITY_PERMISSIONS } from './capabilities.js';

/** The subset of package.json the check reads. */
export interface PluginProjectPackage {
  name?: string;
  version?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  tx5drPlugin?: { minPluginApiVersion?: unknown; pluginName?: unknown };
}

/** The subset of a built plugin definition the check reads. */
export interface PluginProjectDefinition {
  name?: unknown;
  version?: unknown;
  apiVersion?: unknown;
  type?: unknown;
  minPluginApiVersion?: unknown;
  permissions?: unknown;
}

export interface PluginProjectCheckResult {
  errors: string[];
  warnings: string[];
  /** Plain-language summary of where the plugin runs. */
  notes: string[];
  /** The Plugin API version the project builds against, when known. */
  pluginApiFloor?: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Lower bound of `^X.Y.Z`, `~X.Y.Z`, `>=X.Y.Z` or exact `X.Y.Z`; undefined otherwise. */
export function pluginApiRangeFloor(range: string | undefined): string | undefined {
  return /^\s*(?:\^|~|>=\s*)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(range ?? '')?.[1];
}

function nextMajor(version: string): string {
  return `${Number(version.split('.')[0]) + 1}.0.0`;
}

/**
 * Checks a plugin project's Plugin API declarations.
 *
 * The rule for authors: declare `minPluginApiVersion` equal to the
 * `@tx5dr/plugin-api` version you install and build against. Declare a lower
 * version only after testing the plugin on a Host that bundles it.
 */
export function checkPluginProject(
  pkg: PluginProjectPackage,
  definition?: PluginProjectDefinition,
): PluginProjectCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
    errors.push('package.json "version" must be a semantic version such as 1.0.0.');
  }

  const range = pkg.dependencies?.['@tx5dr/plugin-api']
    ?? pkg.devDependencies?.['@tx5dr/plugin-api']
    ?? pkg.peerDependencies?.['@tx5dr/plugin-api'];
  const floor = pluginApiRangeFloor(range);
  if (!range) {
    errors.push('Add @tx5dr/plugin-api to devDependencies (for example "^2.7.0") so the Plugin API you build against is known.');
  } else if (!floor) {
    warnings.push(`Cannot read a minimum version from @tx5dr/plugin-api range "${range}"; use "^X.Y.Z".`);
  }

  const packageMin = typeof pkg.tx5drPlugin?.minPluginApiVersion === 'string'
    ? pkg.tx5drPlugin.minPluginApiVersion
    : undefined;
  const definitionMin = typeof definition?.minPluginApiVersion === 'string'
    ? definition.minPluginApiVersion
    : undefined;
  const declared = definitionMin ?? packageMin;
  const suggestion = floor ? ` Use minPluginApiVersion: '${floor}'.` : '';

  if (!declared) {
    // Without a built definition the declaration may simply not be visible yet.
    if (definition) {
      errors.push(`Declare minPluginApiVersion in the plugin definition so TX-5DR can tell whether it can run the plugin.${suggestion}`);
    }
  } else if (!SEMVER.test(declared)) {
    errors.push(`minPluginApiVersion "${declared}" is not a semantic version.${suggestion}`);
  } else if (floor) {
    if ((comparePluginApiVersions(declared, floor) ?? -1) < 0) {
      errors.push(
        `minPluginApiVersion ${declared} is lower than the @tx5dr/plugin-api ${floor} you build against; `
        + `TX-5DR versions without the newer APIs would accept the plugin.${suggestion}`,
      );
    } else if (declared.split('.')[0] !== floor.split('.')[0]) {
      // A declaration above the floor is valid; it only has to stay in the same major.
      errors.push(`minPluginApiVersion ${declared} does not match the major of @tx5dr/plugin-api ${floor}.${suggestion}`);
    }
  }

  if (packageMin && definitionMin && packageMin !== definitionMin) {
    errors.push(`package.json tx5drPlugin.minPluginApiVersion (${packageMin}) differs from the plugin definition (${definitionMin}).`);
  }

  if (definition) {
    if (definition.version !== undefined && definition.version !== pkg.version) {
      errors.push(`The plugin definition version (${String(definition.version)}) differs from package.json (${String(pkg.version)}).`);
    }
    const permissions = Array.isArray(definition.permissions) ? definition.permissions : [];
    const privileged = permissions.filter((permission) => (
      (PLUGIN_COMMAND_CAPABILITY_PERMISSIONS as readonly unknown[]).includes(permission)
    ));
    if ((definition.type === 'strategy' || privileged.length > 0) && definition.apiVersion !== 2) {
      errors.push('Strategy plugins and plugins requesting command permissions must declare apiVersion: 2.');
    }
  } else {
    warnings.push('Build the plugin first to also check its runtime definition (name, version, apiVersion, permissions).');
  }

  if (declared && SEMVER.test(declared)) {
    notes.push(
      `Runs on TX-5DR whose bundled Plugin API is >= ${declared} and < ${nextMajor(declared)}. `
      + 'TX-5DR shows its Plugin API version in Settings > Plugins.',
    );
  }

  return { errors, warnings, notes, ...(floor ? { pluginApiFloor: floor } : {}) };
}
