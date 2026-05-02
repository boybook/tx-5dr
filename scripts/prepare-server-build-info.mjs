#!/usr/bin/env node
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'packages', 'server', 'src', 'generated', 'buildInfo.ts');
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');

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

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function stripLeadingV(value) {
  return String(value || '').replace(/^v/i, '');
}

function normalizeBaseVersion(value) {
  return stripLeadingV(value).split('-')[0].split('+')[0];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPackage = JSON.parse(await fs.readFile(PACKAGE_PATH, 'utf8'));
  const baseVersion = normalizeBaseVersion(rootPackage.version);
  const commit = args.commit || process.env.GITHUB_SHA || git(['rev-parse', 'HEAD'], 'development');
  const commitShort = commit === 'development' ? 'development' : commit.slice(0, 7);
  const channel = args.channel || process.env.TX5DR_BUILD_CHANNEL || 'nightly';
  if (channel !== 'release' && channel !== 'nightly') {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  const buildTimestamp = args['build-timestamp'] || process.env.TX5DR_BUILD_TIMESTAMP || new Date().toISOString();
  const buildStamp = args['build-stamp'] || process.env.TX5DR_BUILD_STAMP || git(['show', '-s', '--date=format-local:%Y%m%d%H%M', '--format=%cd', commit], 'dev');
  const version = args.version || process.env.TX5DR_BUILD_VERSION || (
    channel === 'nightly'
      ? `${baseVersion}-nightly.${buildStamp}+${commitShort}`
      : baseVersion
  );
  const distribution = args.distribution || process.env.TX5DR_BUILD_DISTRIBUTION || undefined;
  const dockerDigest = args['docker-digest'] || process.env.TX5DR_DOCKER_DIGEST || undefined;

  const buildInfo = {
    channel,
    version: stripLeadingV(version),
    commit,
    commitShort,
    buildTimestamp,
    ...(distribution ? { distribution } : {}),
    ...(dockerDigest ? { dockerDigest } : {}),
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `export interface ServerBuildInfo {\n  channel: 'release' | 'nightly';\n  version: string;\n  commit: string;\n  commitShort: string;\n  buildTimestamp: string;\n  distribution?: 'electron' | 'docker' | 'linux-service' | 'generic-server' | 'web-dev';\n  dockerDigest?: string;\n}\n\nexport const SERVER_BUILD_INFO: ServerBuildInfo = ${JSON.stringify(buildInfo, null, 2)};\n`);
  console.log(`Wrote ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} (${buildInfo.version}, ${buildInfo.commitShort})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
