#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..', '..', '..');
const source = join(projectRoot, 'packages', 'plugin-api', 'dist', 'contest-logbook-ui');
const target = join(projectRoot, 'packages', 'builtin-plugins', 'dist', 'ft-contests', 'ui');

if (!existsSync(source)) {
  throw new Error(`Contest logbook UI bundle is missing: ${source}`);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`Copied contest logbook UI to ${target}`);
