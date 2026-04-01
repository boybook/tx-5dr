#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(PROJECT_ROOT, '.cache', 'livekit');
const CANDIDATE_REPOS = ['livekit/livekit', 'livekit/livekit-server'];
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

function parseArgs(argv) {
  const options = {
    target: `${process.env.PLATFORM || process.platform}-${process.env.ARCH || process.arch}`,
    output: null,
    source: process.env.LIVEKIT_BINARY_PATH || null,
    force: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') {
      options.target = argv[++i];
    } else if (arg === '--output') {
      options.output = argv[++i];
    } else if (arg === '--source') {
      options.source = argv[++i];
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/prepare-livekit-binary.mjs [options]

Options:
  --target <platform-arch>   Target triplet, e.g. darwin-arm64, linux-x64, win32-x64
  --output <path>            Destination file path
  --source <path>            Use a local binary instead of downloading
  --force                    Redownload / overwrite existing output
  --help                     Show this help
`);
}

function normalizeTarget(rawTarget) {
  const [platformRaw, archRaw] = rawTarget.split('-');
  if (!platformRaw || !archRaw) {
    throw new Error(`Invalid target: ${rawTarget}`);
  }

  const platform = platformRaw === 'win32' ? 'windows' : platformRaw;
  const archMap = {
    x64: 'amd64',
    amd64: 'amd64',
    arm64: 'arm64',
    aarch64: 'arm64',
  };
  const arch = archMap[archRaw];
  if (!arch) {
    throw new Error(`Unsupported target arch: ${archRaw}`);
  }

  return {
    platform,
    arch,
    triplet: `${platformRaw}-${archRaw}`,
    exeName: platform === 'windows' ? 'livekit-server.exe' : 'livekit-server',
  };
}

function defaultOutputPath(target) {
  return path.join(PROJECT_ROOT, 'resources', 'bin', target.triplet, target.exeName);
}

function ensureDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function recursiveFindFile(rootDir, targetName) {
  const entries = readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const found = recursiveFindFile(fullPath, targetName);
      if (found) return found;
    } else if (entry.isFile() && entry.name === targetName) {
      return fullPath;
    }
  }
  return null;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status ?? 'unknown'}`);
  }
}

function commandExists(command) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [command], { encoding: 'utf8' })
    : spawnSync('which', [command], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return null;
  }
  const resolved = probe.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return resolved || null;
}

function extractArchive(archivePath, extractDir, platform) {
  mkdirSync(extractDir, { recursive: true });
  if (archivePath.endsWith('.tar.gz')) {
    runCommand('tar', ['-xzf', archivePath, '-C', extractDir]);
    return;
  }

  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      runCommand('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ]);
      return;
    }
    runCommand('unzip', ['-o', archivePath, '-d', extractDir]);
    return;
  }

  throw new Error(`Unsupported archive format for ${platform}: ${archivePath}`);
}

function buildGitHubHeaders(accept) {
  const headers = {
    'User-Agent': 'tx5dr-livekit-prep',
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
}

function formatGitHubApiError(url, statusCode, responseHeaders, body) {
  const details = [];
  if (statusCode) {
    details.push(`status=${statusCode}`);
  }

  const remaining = responseHeaders['x-ratelimit-remaining'];
  if (remaining) {
    details.push(`rateLimitRemaining=${remaining}`);
  }

  const reset = responseHeaders['x-ratelimit-reset'];
  if (reset) {
    const resetTime = Number(reset);
    if (Number.isFinite(resetTime)) {
      details.push(`rateLimitReset=${new Date(resetTime * 1000).toISOString()}`);
    }
  }

  if (body) {
    try {
      const payload = JSON.parse(body);
      if (payload?.message) {
        details.push(`message=${payload.message}`);
      }
      if (payload?.documentation_url) {
        details.push(`docs=${payload.documentation_url}`);
      }
    } catch {
      const excerpt = body.trim().slice(0, 200);
      if (excerpt) {
        details.push(`body=${excerpt}`);
      }
    }
  }

  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `Request failed: ${url}${suffix}`;
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { ...buildGitHubHeaders('application/vnd.github+json'), ...headers } }, (res) => {
      const { statusCode = 0, headers: responseHeaders } = res;
      if ([301, 302, 307, 308].includes(statusCode) && responseHeaders.location) {
        resolve(fetchJson(responseHeaders.location, headers));
        res.resume();
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(formatGitHubApiError(url, statusCode, responseHeaders, body)));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: buildGitHubHeaders('application/octet-stream') }, async (res) => {
      const { statusCode = 0, headers } = res;
      if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
        res.resume();
        resolve(downloadFile(headers.location, destination));
        return;
      }
      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(formatGitHubApiError(url, statusCode, headers, '')));
        res.resume();
        return;
      }

      try {
        ensureDir(destination);
        await pipeline(res, createWriteStream(destination));
        resolve(destination);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function matchesAsset(assetName, target) {
  const lower = assetName.toLowerCase();
  const platformTokens = target.platform === 'windows'
    ? ['windows', 'win']
    : target.platform === 'darwin'
    ? ['darwin', 'macos', 'mac', 'osx']
    : ['linux'];
  const archTokens = target.arch === 'amd64'
    ? ['amd64', 'x86_64', 'x64']
    : ['arm64', 'aarch64'];
  const archiveTokens = target.platform === 'windows'
    ? ['.zip']
    : ['.tar.gz'];

  if (!lower.includes('livekit')) return false;
  if (lower.includes('checksums') || lower.endsWith('.txt')) return false;
  if (!platformTokens.some((token) => lower.includes(token))) return false;
  if (!archTokens.some((token) => lower.includes(token))) return false;
  if (!archiveTokens.some((token) => lower.endsWith(token))) return false;
  return true;
}

async function resolveAsset(target) {
  const lookupErrors = [];
  for (const repo of CANDIDATE_REPOS) {
    try {
      const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset = assets.find((candidate) => typeof candidate?.name === 'string' && matchesAsset(candidate.name, target));
      if (asset?.browser_download_url) {
        return {
          repo,
          tag: release.tag_name,
          name: asset.name,
          url: asset.browser_download_url,
        };
      }
      const availableAssets = assets
        .map((candidate) => candidate?.name)
        .filter((name) => typeof name === 'string');
      lookupErrors.push(
        `${repo}@${release.tag_name || 'unknown'}: no asset matched ${target.platform}-${target.arch}; available assets: ${availableAssets.length > 0 ? availableAssets.join(', ') : 'none'}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lookupErrors.push(`${repo}: ${message}`);
    }
  }

  throw new Error(
    `Could not find a LiveKit release asset for ${target.platform}-${target.arch}. Checked repos:\n- ${lookupErrors.join('\n- ')}`
  );
}

function copyExecutable(sourcePath, outputPath) {
  ensureDir(outputPath);
  copyFileSync(sourcePath, outputPath);
  if (!outputPath.endsWith('.exe')) {
    chmodSync(outputPath, 0o755);
  }
}

function findLocalBinary(target) {
  const candidates = [];
  const commandPath = commandExists(target.exeName);
  if (commandPath) {
    candidates.push(commandPath);
  }

  if (target.platform !== 'windows') {
    candidates.push(
      `/opt/homebrew/bin/${target.exeName}`,
      `/usr/local/bin/${target.exeName}`,
      `/usr/bin/${target.exeName}`
    );
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function shouldAllowMissingBinary(target, error) {
  if (target.platform !== 'darwin') {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Could not find a LiveKit release asset');
}

async function prepareBinary(options) {
  const target = normalizeTarget(options.target);
  const outputPath = options.output ? path.resolve(options.output) : defaultOutputPath(target);

  if (!options.force && existsSync(outputPath) && statSync(outputPath).size > 0) {
    console.log(`LiveKit binary already present: ${outputPath}`);
    return outputPath;
  }

  if (options.source) {
    const sourcePath = path.resolve(options.source);
    if (!existsSync(sourcePath)) {
      throw new Error(`LiveKit source binary not found: ${sourcePath}`);
    }
    copyExecutable(sourcePath, outputPath);
    console.log(`Copied LiveKit binary from local source: ${sourcePath}`);
    return outputPath;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  const localBinary = findLocalBinary(target);
  if (localBinary) {
    copyExecutable(localBinary, outputPath);
    console.log(`Copied LiveKit binary from local installation: ${localBinary}`);
    return outputPath;
  }

  let asset;
  try {
    if (!GITHUB_TOKEN) {
      console.warn('GitHub token not provided; LiveKit release lookup is unauthenticated and may be rate limited.');
    }
    asset = await resolveAsset(target);
  } catch (error) {
    if (shouldAllowMissingBinary(target, error)) {
      console.warn(`LiveKit binary is not bundled for ${target.platform}-${target.arch}: ${error.message}`);
      console.warn('Continuing without a bundled LiveKit binary. The app can use a local installation or fall back to ws-compat.');
      return null;
    }
    throw error;
  }
  const archivePath = path.join(CACHE_DIR, asset.name);
  const extractDir = path.join(CACHE_DIR, `${asset.name}.extract`);

  console.log(`Downloading LiveKit ${asset.tag} from ${asset.repo}: ${asset.name}`);
  await downloadFile(asset.url, archivePath);
  rmSync(extractDir, { recursive: true, force: true });
  extractArchive(archivePath, extractDir, target.platform);

  const binaryPath = recursiveFindFile(extractDir, target.exeName);
  if (!binaryPath) {
    throw new Error(`Could not locate ${target.exeName} inside ${asset.name}`);
  }

  copyExecutable(binaryPath, outputPath);
  console.log(`Prepared LiveKit binary: ${outputPath}`);
  return outputPath;
}

prepareBinary(parseArgs(process.argv.slice(2))).catch((error) => {
  console.error(`Failed to prepare LiveKit binary: ${error.message}`);
  console.error('Hint: install livekit-server locally or set LIVEKIT_BINARY_PATH to an existing binary.');
  process.exit(1);
});
