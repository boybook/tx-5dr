#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function requireArg(args, key) {
  const value = args[key];
  if (!value || value === true) {
    throw new Error(`Missing required argument: --${key}`);
  }
  return value;
}

function trimSlash(value) {
  return value.replace(/\/+$/, '');
}

function ensureAbsoluteUrl(value) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

function joinUrl(base, suffix) {
  return `${trimSlash(base)}/${suffix.replace(/^\/+/, '')}`;
}

function detectServerAssetMetadata(fileName) {
  const match = fileName.match(/^TX-5DR-[^-]+-server-linux-(amd64|arm64)\.(deb|rpm)$/);
  if (!match) {
    return null;
  }
  return {
    platform: 'linux',
    arch: match[1],
    package_type: match[2],
  };
}

function detectAppAssetMetadata(fileName) {
  const normalizedArch = fileName.includes('-arm64') ? 'arm64' : fileName.includes('-amd64') ? 'amd64' : fileName.includes('-x64') ? 'x64' : 'unknown';
  const platform = fileName.includes('-windows-')
    ? 'windows'
    : fileName.includes('-macos-')
      ? 'macos'
      : fileName.includes('-linux-')
        ? 'linux'
        : 'unknown';

  return {
    platform,
    arch: normalizedArch,
    package_type: path.extname(fileName).replace(/^\./, '') || 'unknown',
  };
}

async function buildAssetEntry({ baseUrl, objectPrefix, filePath, product }) {
  const fileName = path.basename(filePath);
  const [fileBuffer, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  let metadata = {
    platform: 'unknown',
    arch: 'unknown',
    package_type: path.extname(fileName).replace(/^\./, '') || 'unknown',
  };

  if (product === 'server') {
    metadata = detectServerAssetMetadata(fileName) || metadata;
  } else if (product === 'app') {
    metadata = detectAppAssetMetadata(fileName);
  }

  return {
    name: fileName,
    url: joinUrl(baseUrl, `${objectPrefix}/${fileName}`),
    sha256,
    size: fileStats.size,
    ...metadata,
  };
}

async function listFiles(dirPath) {
  if (!dirPath) {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function readOptionalTextFile(filePath) {
  if (!filePath) {
    return '';
  }
  const content = await readFile(filePath, 'utf8');
  return content.trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const product = requireArg(args, 'product');
  const channel = requireArg(args, 'channel');
  const tag = requireArg(args, 'tag');
  const version = requireArg(args, 'version');
  const commit = requireArg(args, 'commit');
  const publishedAt = requireArg(args, 'published-at');
  const baseUrl = trimSlash(ensureAbsoluteUrl(requireArg(args, 'base-url')));
  const objectPrefix = requireArg(args, 'object-prefix').replace(/^\/+|\/+$/g, '');
  const outputPath = requireArg(args, 'output');
  const assetsDir = args['assets-dir'];
  const releaseNotes = (args['release-notes'] && args['release-notes'] !== true)
    ? String(args['release-notes']).trim()
    : await readOptionalTextFile(args['release-notes-file']);

  const assetFiles = await listFiles(assetsDir);
  const assets = [];
  for (const filePath of assetFiles) {
    assets.push(await buildAssetEntry({ baseUrl, objectPrefix, filePath, product }));
  }

  const manifest = {
    product,
    channel,
    tag,
    version,
    commit,
    published_at: publishedAt,
    base_url: joinUrl(baseUrl, objectPrefix),
    release_notes: releaseNotes || '',
    assets,
  };

  if (product === 'server') {
    for (const asset of assets) {
      if (asset.package_type === 'deb' || asset.package_type === 'rpm') {
        manifest[`latest_url_${asset.arch}_${asset.package_type}`] = asset.url;
        manifest[`latest_sha256_${asset.arch}_${asset.package_type}`] = asset.sha256;
      }
      if (asset.name === 'install-online.sh') {
        const stableUrl = joinUrl(baseUrl, 'tx-5dr/server/latest/install-online.sh');
        manifest.latest_url_install_online = stableUrl;
        manifest.latest_sha256_install_online = asset.sha256;
      }
    }
  }

  if (product === 'docker') {
    manifest.docker_image = args['docker-image'] || '';
    manifest.docker_tags = args['docker-tags'] ? args['docker-tags'].split(',').map((item) => item.trim()).filter(Boolean) : [];
    manifest.docker_digest = args['docker-digest'] || '';
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated manifest: ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
