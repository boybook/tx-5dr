#!/usr/bin/env node

import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const ELECTRON_MAIN_PACKAGE_PATH = path.join(PROJECT_ROOT, 'packages', 'electron-main', 'package.json');
const BUILD_INFO_PATH = path.join(PROJECT_ROOT, 'packages', 'server', 'src', 'generated', 'buildInfo.json');
const SERVER_BUILD_INFO_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'prepare-server-build-info.mjs');

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
  const buildTimestamp = requireArg(args, 'build-timestamp');
  const buildStamp = requireArg(args, 'build-stamp');
  const inputVersion = args['version'] || '';

  const serverBuildInfoArgs = [
    SERVER_BUILD_INFO_SCRIPT,
    '--channel', channel,
    '--commit', commit,
    '--build-timestamp', buildTimestamp,
    '--build-stamp', buildStamp,
    '--distribution', 'electron',
  ];
  if (channel === 'release') {
    serverBuildInfoArgs.push('--version', inputVersion);
  }
  execFileSync(process.execPath, serverBuildInfoArgs, { cwd: PROJECT_ROOT, stdio: 'inherit' });

  const buildInfo = JSON.parse(await fs.readFile(BUILD_INFO_PATH, 'utf8'));
  await updatePackageVersion(ROOT_PACKAGE_PATH, buildInfo.version);
  await updatePackageVersion(ELECTRON_MAIN_PACKAGE_PATH, buildInfo.version);
  process.stdout.write(`${JSON.stringify(buildInfo, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
