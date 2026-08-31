#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_BASE_VERSION, resolveHostVersion } from './host-version.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readPackage(relativePath) {
  return JSON.parse(await fs.readFile(path.join(projectRoot, relativePath, 'package.json'), 'utf8'));
}

function assertVersion(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} version is ${actual}; expected ${expected}`);
  }
}

const rootPackage = await readPackage('.');
const hostVersion = rootPackage.version;
assertVersion(hostVersion, HOST_BASE_VERSION, 'TX-5DR Host base');
assertVersion(
  resolveHostVersion({
    sourceVersion: hostVersion,
    channel: 'nightly',
    buildStamp: '202608311200',
    commit: 'abcdef1234567890',
  }),
  '1.0.0-nightly.202608311200+gabcdef1',
  'TX-5DR nightly version policy',
);
const hostPackages = [
  'packages/builtin-plugins',
  'packages/client-tools',
  'packages/electron-main',
  'packages/electron-preload',
  'packages/server',
  'packages/shared-config',
  'packages/web',
];
for (const packagePath of hostPackages) {
  const manifest = await readPackage(packagePath);
  assertVersion(manifest.version, hostVersion, manifest.name);
}

const pluginApiPackage = await readPackage('packages/plugin-api');
const pluginApiVersion = pluginApiPackage.version;
const sdkPackages = [
  'packages/contracts',
  'packages/core',
  'packages/create-tx5dr-plugin',
];
for (const packagePath of sdkPackages) {
  const manifest = await readPackage(packagePath);
  assertVersion(manifest.version, pluginApiVersion, manifest.name);
}

const buildInfo = JSON.parse(await fs.readFile(
  path.join(projectRoot, 'packages/server/src/generated/buildInfo.json'),
  'utf8',
));
assertVersion(buildInfo.version, hostVersion, 'Default canonical Host build info');
assertVersion(buildInfo.pluginApiVersion, pluginApiVersion, 'Default canonical Plugin API build info');

console.log(`Version consistency passed: Host ${hostVersion}, Plugin SDK ${pluginApiVersion}`);
