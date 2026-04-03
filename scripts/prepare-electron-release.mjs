#!/usr/bin/env node

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const ELECTRON_MAIN_PACKAGE_PATH = path.join(PROJECT_ROOT, 'packages', 'electron-main', 'package.json');
const BUILD_INFO_PATH = path.join(PROJECT_ROOT, 'packages', 'electron-main', 'src', 'generated', 'buildInfo.ts');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function stripLeadingV(value) {
  return value.replace(/^v/i, '');
}

function normalizeBaseVersion(value) {
  return stripLeadingV(value).split('-')[0].split('+')[0];
}

function formatNightlyVersion(baseVersion, buildStamp, shortSha) {
  return `${baseVersion}-nightly.${buildStamp}+${shortSha}`;
}

function buildInfoSource(buildInfo) {
  return `export interface BuildInfo {\n  channel: 'release' | 'nightly';\n  version: string;\n  commit: string;\n  commitShort: string;\n  tag: string;\n  buildTimestamp: string;\n}\n\nexport const BUILD_INFO: BuildInfo = ${JSON.stringify(buildInfo, null, 2)};\n`;
}

async function updatePackageVersion(filePath, version) {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.version = version;
  await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channel = requireArg(args, 'channel');
  if (channel !== 'release' && channel !== 'nightly') {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  const commit = requireArg(args, 'commit');
  const commitShort = commit.slice(0, 7);
  const buildTimestamp = requireArg(args, 'build-timestamp');
  const buildStamp = requireArg(args, 'build-stamp');
  const inputVersion = args['version'] || '';

  const rootPackage = JSON.parse(await fs.readFile(ROOT_PACKAGE_PATH, 'utf8'));
  const baseVersion = normalizeBaseVersion(rootPackage.version);
  const effectiveVersion = channel === 'nightly'
    ? formatNightlyVersion(baseVersion, buildStamp, commitShort)
    : stripLeadingV(inputVersion || baseVersion);
  const tag = channel === 'nightly' ? 'nightly-app' : (inputVersion || baseVersion);

  await updatePackageVersion(ROOT_PACKAGE_PATH, effectiveVersion);
  await updatePackageVersion(ELECTRON_MAIN_PACKAGE_PATH, effectiveVersion);

  const buildInfo = {
    channel,
    version: effectiveVersion,
    commit,
    commitShort,
    tag,
    buildTimestamp,
  };
  await fs.mkdir(path.dirname(BUILD_INFO_PATH), { recursive: true });
  await fs.writeFile(BUILD_INFO_PATH, buildInfoSource(buildInfo));

  process.stdout.write(`${JSON.stringify(buildInfo, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
