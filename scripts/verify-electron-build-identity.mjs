#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) {
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, relativePath), 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${String(actual)}; expected ${String(expected)}`);
  }
}

async function directoryContains(relativePath, value) {
  const directory = path.join(PROJECT_ROOT, relativePath);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await directoryContains(path.relative(PROJECT_ROOT, entryPath), value)) return true;
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      if ((await fs.readFile(entryPath, 'utf8')).includes(value)) return true;
    }
  }
  return false;
}

const args = parseArgs(process.argv.slice(2));
const rootPackage = await readJson('package.json');
const electronPackage = await readJson('packages/electron-main/package.json');
const canonical = await readJson('packages/server/src/generated/buildInfo.json');
const serverDist = await readJson('packages/server/dist/generated/buildInfo.json');
const electronDistPath = path.join(PROJECT_ROOT, 'packages/electron-main/dist/generated/buildInfo.js');
delete require.cache[require.resolve(electronDistPath)];
const electronDist = require(electronDistPath).BUILD_INFO;

assertEqual(canonical.version, rootPackage.version, 'Canonical Host build version');
assertEqual(electronPackage.version, canonical.version, 'Electron package version');
assertEqual(serverDist.version, canonical.version, 'Server dist build version');
assertEqual(electronDist.version, canonical.version, 'Electron dist build version');
assertEqual(serverDist.commit, canonical.commit, 'Server dist build commit');
assertEqual(electronDist.commit, canonical.commit, 'Electron dist build commit');
if (args.distribution) assertEqual(canonical.distribution, args.distribution, 'Canonical distribution');
if (!await directoryContains('packages/web/dist', canonical.version)) {
  throw new Error(`Web dist does not contain canonical build version ${canonical.version}`);
}

console.log(`Electron build identity verified: ${canonical.version} (${canonical.commitShort})`);
