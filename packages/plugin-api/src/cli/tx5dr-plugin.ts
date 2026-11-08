#!/usr/bin/env node
// `tx5dr-plugin check [project-dir] [--entry built-entry.js]` (bin of @tx5dr/plugin-api)
// Checks Plugin API declarations the Host and the official marketplace rely on.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkPluginProject,
  type PluginProjectDefinition,
  type PluginProjectPackage,
} from '../project-check.js';

const USAGE = 'Usage: tx5dr-plugin check [project-dir] [--entry <built entry file>]';

async function loadDefinition(entryPath: string): Promise<PluginProjectDefinition> {
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(entryPath).href) as { default?: unknown };
  } catch (error) {
    throw new Error(
      `Cannot load ${entryPath}: ${error instanceof Error ? error.message : String(error)}\n`
      + 'Run npm install and build the plugin, or pass --entry <built file>.',
    );
  }
  const exported = module.default ?? module;
  if (!exported || typeof exported !== 'object') {
    throw new Error(`${entryPath} does not export a plugin definition`);
  }
  return exported as PluginProjectDefinition;
}

function resolveEntry(projectDir: string, pkg: PluginProjectPackage & { main?: string; tx5drPlugin?: { entry?: unknown } }, explicit?: string): string | undefined {
  const candidates = [
    explicit,
    typeof pkg.tx5drPlugin?.entry === 'string' ? pkg.tx5drPlugin.entry : undefined,
    pkg.main,
    'dist/index.js',
    'dist/index.mjs',
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.map((candidate) => path.resolve(projectDir, candidate)).find((candidate) => existsSync(candidate));
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'check') {
    process.stderr.write(`${USAGE}\n`);
    return command === '--help' || command === '-h' ? 0 : 2;
  }
  const entryFlag = rest.indexOf('--entry');
  const explicitEntry = entryFlag >= 0 ? rest[entryFlag + 1] : undefined;
  const positional = rest.filter((value, index) => !value.startsWith('--') && rest[index - 1] !== '--entry');
  const projectDir = path.resolve(positional[0] ?? '.');
  const packagePath = path.join(projectDir, 'package.json');
  if (!existsSync(packagePath)) {
    process.stderr.write(`No package.json found in ${projectDir}\n`);
    return 2;
  }
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as PluginProjectPackage & { main?: string };
  const entry = resolveEntry(projectDir, pkg, explicitEntry);
  if (explicitEntry && !entry) {
    process.stderr.write(`Entry not found: ${explicitEntry}\n`);
    return 2;
  }
  const definition = entry ? await loadDefinition(entry) : undefined;
  const result = checkPluginProject(pkg, definition);

  for (const error of result.errors) process.stdout.write(`ERROR  ${error}\n`);
  for (const warning of result.warnings) process.stdout.write(`WARN   ${warning}\n`);
  for (const note of result.notes) process.stdout.write(`NOTE   ${note}\n`);
  process.stdout.write(result.errors.length === 0
    ? 'Plugin API declarations are consistent.\n'
    : `${result.errors.length} problem(s) found.\n`);
  return result.errors.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
