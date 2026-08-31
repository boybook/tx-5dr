#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');
const SEMANTIC_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const HOST_BASE_VERSION = '1.0.0';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

export function stripLeadingV(value) {
  return String(value || '').replace(/^v/i, '');
}

export function normalizeHostBaseVersion(value) {
  const version = stripLeadingV(value).split('-')[0].split('+')[0];
  if (!SEMANTIC_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid Host base version: ${String(value)}`);
  }
  return version;
}

export function resolveHostVersion({
  sourceVersion,
  channel,
  releaseVersion,
  buildStamp,
  commit,
}) {
  const baseVersion = normalizeHostBaseVersion(sourceVersion);
  if (channel === 'release') {
    const version = stripLeadingV(releaseVersion || baseVersion);
    if (!SEMANTIC_VERSION_PATTERN.test(version)) {
      throw new Error(`Invalid Host release version: ${String(releaseVersion)}`);
    }
    return version;
  }
  if (channel !== 'nightly') {
    throw new Error(`Unsupported Host release channel: ${String(channel)}`);
  }
  if (!buildStamp || !/^[0-9A-Za-z-]+$/.test(buildStamp)) {
    throw new Error(`Invalid nightly build stamp: ${String(buildStamp)}`);
  }
  if (!commit) {
    throw new Error('Nightly Host version requires a commit');
  }
  const commitShort = commit === 'development' ? commit : commit.slice(0, 7);
  if (!/^[0-9A-Za-z-]+$/.test(commitShort)) {
    throw new Error(`Invalid nightly commit: ${String(commit)}`);
  }
  return `${baseVersion}-nightly.${buildStamp}+g${commitShort}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPackage = JSON.parse(await fs.readFile(ROOT_PACKAGE_PATH, 'utf8'));
  const version = resolveHostVersion({
    sourceVersion: rootPackage.version,
    channel: args.channel,
    releaseVersion: args.version,
    buildStamp: args['build-stamp'],
    commit: args.commit,
  });
  process.stdout.write(`${version}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
