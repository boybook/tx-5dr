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

function normalizeObjectPrefix(value) {
  return value.replace(/^\/+|\/+$/g, '');
}

function resolveSourceName(value, fallback) {
  const normalized = String(value || fallback || '').trim().toLowerCase();
  if (normalized === 'oss' || normalized === 'github') {
    return normalized;
  }
  return fallback;
}

function buildOptionalAssetUrl(baseUrl, objectPrefix, fileName) {
  if (!baseUrl || !objectPrefix) {
    return undefined;
  }
  return joinUrl(trimSlash(ensureAbsoluteUrl(baseUrl)), `${normalizeObjectPrefix(objectPrefix)}/${fileName}`);
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

async function buildAssetEntry({
  baseUrl,
  objectPrefix,
  filePath,
  product,
  ossBaseUrl,
  ossObjectPrefix,
  githubBaseUrl,
  githubObjectPrefix,
  cnSource,
  globalSource,
}) {
  const fileName = path.basename(filePath);
  const [fileBuffer, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const canonicalUrl = joinUrl(baseUrl, `${objectPrefix}/${fileName}`);
  const ossUrl = buildOptionalAssetUrl(ossBaseUrl, ossObjectPrefix, fileName) || canonicalUrl;
  const githubUrl = buildOptionalAssetUrl(githubBaseUrl, githubObjectPrefix, fileName);
  const sourceUrls = {
    oss: ossUrl,
    github: githubUrl || canonicalUrl,
  };

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
    url: ossUrl,
    url_cn: sourceUrls[cnSource] || ossUrl,
    url_global: sourceUrls[globalSource] || githubUrl || ossUrl,
    url_oss: ossUrl,
    url_github: githubUrl,
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

function normalizeRecentCommit(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const shortId = typeof entry.short_id === 'string' ? entry.short_id.trim() : '';
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  const publishedAt = typeof entry.published_at === 'string' ? entry.published_at.trim() : '';

  const resolvedId = id || shortId;
  const resolvedShortId = shortId || resolvedId.slice(0, 7);
  if (!resolvedId && !title && !publishedAt) {
    return null;
  }

  return {
    id: resolvedId,
    short_id: resolvedShortId,
    title,
    published_at: publishedAt,
  };
}

function parseRecentCommits(value) {
  if (!value || value === true) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Invalid --recent-commits-json payload: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Invalid --recent-commits-json payload: expected a JSON array');
  }

  return parsed
    .map((entry) => normalizeRecentCommit(entry))
    .filter((entry) => Boolean(entry))
    .slice(0, 5);
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
  const objectPrefix = normalizeObjectPrefix(requireArg(args, 'object-prefix'));
  const outputPath = requireArg(args, 'output');
  const commitTitle = (args['commit-title'] && args['commit-title'] !== true)
    ? String(args['commit-title']).trim()
    : '';
  const ossBaseUrl = trimSlash(ensureAbsoluteUrl(args['oss-base-url'] || baseUrl));
  const ossObjectPrefix = normalizeObjectPrefix(args['oss-object-prefix'] || objectPrefix);
  const githubBaseUrl = args['github-base-url'] ? trimSlash(ensureAbsoluteUrl(args['github-base-url'])) : '';
  const githubObjectPrefix = args['github-object-prefix'] ? normalizeObjectPrefix(args['github-object-prefix']) : '';
  const cnSource = resolveSourceName(args['cn-source'], 'oss');
  const globalSource = resolveSourceName(args['global-source'], 'github');
  const assetsDir = args['assets-dir'];
  const releaseNotes = (args['release-notes'] && args['release-notes'] !== true)
    ? String(args['release-notes']).trim()
    : await readOptionalTextFile(args['release-notes-file']);
  const recentCommits = parseRecentCommits(args['recent-commits-json']);

  const assetFiles = await listFiles(assetsDir);
  const assets = [];
  for (const filePath of assetFiles) {
    assets.push(await buildAssetEntry({
      baseUrl,
      objectPrefix,
      filePath,
      product,
      ossBaseUrl,
      ossObjectPrefix,
      githubBaseUrl,
      githubObjectPrefix,
      cnSource,
      globalSource,
    }));
  }

  const manifest = {
    product,
    channel,
    tag,
    version,
    commit,
    commit_title: commitTitle || '',
    published_at: publishedAt,
    base_url: joinUrl(baseUrl, objectPrefix),
    release_notes: releaseNotes || '',
    recent_commits: recentCommits,
    assets,
  };

  if (product === 'server') {
    for (const asset of assets) {
      if (asset.package_type === 'deb' || asset.package_type === 'rpm') {
        manifest[`latest_url_${asset.arch}_${asset.package_type}`] = asset.url_oss || asset.url;
        manifest[`latest_url_${asset.arch}_${asset.package_type}_cn`] = asset.url_cn || asset.url_oss || asset.url;
        manifest[`latest_url_${asset.arch}_${asset.package_type}_global`] = asset.url_global || asset.url_github || asset.url_oss || asset.url;
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
