import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type {
  PluginMarketCatalogEntry,
  PluginMarketChannel,
  PluginMarketInstallRecord,
  PluginMarketInstallResult,
} from '@tx5dr/contracts';
import { validatePluginDefinition } from './PluginLoader.js';
import { fetchPluginMarketCatalog } from './marketplace.js';
import { writePluginSource } from './plugin-source.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PluginMarketplaceInstaller');
const execFileAsync = promisify(execFile);
const ENTRY_FILE_CANDIDATES = ['plugin.js', 'plugin.mjs', 'index.js', 'index.mjs'] as const;
const MARKETPLACE_TEMP_DIR_NAME = '.plugin-market-tmp';
const MARKETPLACE_TEMP_DIR_PREFIX = 'install-';

function ensureHexSha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function resolveSafeExtractPath(root: string, relativePath: string): string | null {
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    return null;
  }
  const resolved = path.resolve(root, normalized);
  const normalizedRoot = path.resolve(root);
  const relativeToRoot = path.relative(normalizedRoot, resolved);
  if (relativeToRoot !== '' && (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot))) {
    return null;
  }
  return resolved;
}

function resolveMarketplaceWorkspaceBase(pluginDir: string): string {
  const managedRoot = path.dirname(path.resolve(pluginDir));
  const workspaceBase = resolveSafeExtractPath(managedRoot, MARKETPLACE_TEMP_DIR_NAME);
  if (!workspaceBase) {
    throw new Error(`Invalid plugin workspace root: ${pluginDir}`);
  }
  return workspaceBase;
}

async function createMarketplaceInstallWorkspace(pluginDir: string): Promise<string> {
  const workspaceBase = resolveMarketplaceWorkspaceBase(pluginDir);
  await fs.mkdir(workspaceBase, { recursive: true });
  return fs.mkdtemp(path.join(workspaceBase, MARKETPLACE_TEMP_DIR_PREFIX));
}

async function extractZipArchive(archivePath: string, outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath "${archivePath.replace(/"/g, '`"')}" -DestinationPath "${outputDir.replace(/"/g, '`"')}" -Force`;
    await execFileAsync('powershell', ['-NoLogo', '-NoProfile', '-Command', command]);
    return;
  }

  await execFileAsync('unzip', ['-qq', archivePath, '-d', outputDir]);
}

async function resolveExtractedPluginRoot(extractDir: string): Promise<string> {
  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const topLevelFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const topLevelDirs = entries.filter((entry) => entry.isDirectory());

  const hasEntryAtRoot = ENTRY_FILE_CANDIDATES.some((candidate) => topLevelFiles.includes(candidate));
  if (hasEntryAtRoot) {
    return extractDir;
  }

  if (topLevelDirs.length === 1 && topLevelFiles.length === 0) {
    return path.join(extractDir, topLevelDirs[0]!.name);
  }

  throw new Error('Plugin archive does not contain a valid plugin root');
}

async function resolvePluginEntryPath(pluginRoot: string): Promise<string> {
  for (const candidate of ENTRY_FILE_CANDIDATES) {
    const entryPath = path.join(pluginRoot, candidate);
    try {
      await fs.access(entryPath);
      return entryPath;
    } catch {
      // try next candidate
    }
  }
  throw new Error(`Plugin archive is missing an entry file (${ENTRY_FILE_CANDIDATES.join(', ')})`);
}

async function validateExtractedPlugin(pluginRoot: string, expectedPluginName: string): Promise<void> {
  const entryPath = await resolvePluginEntryPath(pluginRoot);
  const entryUrl = pathToFileURL(path.resolve(entryPath));
  entryUrl.searchParams.set('tx5dr_market_validate', `${Date.now()}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(entryUrl.href);
  const definition = mod.default ?? mod;
  validatePluginDefinition(definition);
  if (definition.name !== expectedPluginName) {
    throw new Error(`Plugin archive name mismatch: expected ${expectedPluginName}, received ${definition.name}`);
  }
}

async function replacePluginDirectory(nextPluginRoot: string, destinationDir: string): Promise<void> {
  const parentDir = path.dirname(destinationDir);
  await fs.mkdir(parentDir, { recursive: true });

  const backupDir = path.join(parentDir, `.${path.basename(destinationDir)}.bak-${Date.now()}`);
  const hadExistingDestination = await fs.access(destinationDir).then(() => true).catch(() => false);

  if (hadExistingDestination) {
    await fs.rename(destinationDir, backupDir);
  }

  try {
    await fs.rename(nextPluginRoot, destinationDir);
    if (hadExistingDestination) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (hadExistingDestination) {
      await fs.rename(backupDir, destinationDir).catch(() => {});
    }
    throw error;
  }
}

async function downloadArchiveToTempFile(
  artifact: PluginMarketCatalogEntry,
  pluginDir: string,
  options: {
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ archivePath: string; checksum: string; tempRoot: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(artifact.artifactUrl, {
    headers: {
      accept: 'application/octet-stream,application/zip',
    },
  });

  if (!response.ok) {
    throw new Error(`Plugin asset request failed: ${response.status} ${response.statusText}`);
  }

  const tempRoot = await createMarketplaceInstallWorkspace(pluginDir);
  const archivePath = path.join(tempRoot, `${artifact.name}-${artifact.latestVersion}.zip`);
  const payload = new Uint8Array(await response.arrayBuffer());
  const checksum = ensureHexSha256(payload);
  await fs.writeFile(archivePath, payload);
  return { archivePath, checksum, tempRoot };
}

async function fetchMarketPluginEntry(
  pluginName: string,
  channel: PluginMarketChannel,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<PluginMarketCatalogEntry> {
  const result = await fetchPluginMarketCatalog(channel, options);
  const plugin = result.catalog.plugins.find((entry) => entry.name === pluginName);
  if (!plugin) {
    throw new Error(`Plugin not found in marketplace catalog: ${pluginName}`);
  }
  return plugin;
}

export async function installPluginFromMarketplace(
  pluginName: string,
  pluginDir: string,
  channel: PluginMarketChannel,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<PluginMarketInstallResult> {
  const artifact = await fetchMarketPluginEntry(pluginName, channel, options);
  const { archivePath, checksum, tempRoot } = await downloadArchiveToTempFile(artifact, pluginDir, options);

  try {
    if (checksum.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error(`Plugin asset checksum mismatch for ${pluginName}`);
    }

    const extractDir = path.join(tempRoot, 'extract');
    await extractZipArchive(archivePath, extractDir);
    const extractedRoot = await resolveExtractedPluginRoot(extractDir);
    await validateExtractedPlugin(extractedRoot, pluginName);

    const destinationDir = resolveSafeExtractPath(pluginDir, pluginName);
    if (!destinationDir) {
      throw new Error(`Invalid plugin destination path: ${pluginName}`);
    }

    const stagingDir = path.join(tempRoot, 'staging', pluginName);
    await fs.mkdir(path.dirname(stagingDir), { recursive: true });
    await fs.cp(extractedRoot, stagingDir, { recursive: true });
    await replacePluginDirectory(stagingDir, destinationDir);

    const record: PluginMarketInstallRecord = {
      version: artifact.latestVersion,
      channel,
      artifactUrl: artifact.artifactUrl,
      sha256: artifact.sha256,
      installedAt: Date.now(),
    };
    await writePluginSource(destinationDir, {
      kind: 'marketplace',
      ...record,
    });
    logger.info('Plugin installed from marketplace', { pluginName, version: record.version, channel });
    return {
      success: true,
      action: 'install',
      pluginName,
      record,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function updatePluginFromMarketplace(
  pluginName: string,
  pluginDir: string,
  channel: PluginMarketChannel,
  options: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<PluginMarketInstallResult> {
  const result = await installPluginFromMarketplace(pluginName, pluginDir, channel, options);
  return {
    ...result,
    action: 'update',
  };
}

export async function uninstallPluginFromMarketplace(
  pluginName: string,
  pluginDir: string,
): Promise<PluginMarketInstallResult> {
  const destinationDir = resolveSafeExtractPath(pluginDir, pluginName);
  if (!destinationDir) {
    throw new Error(`Invalid plugin destination path: ${pluginName}`);
  }

  await fs.rm(destinationDir, { recursive: true, force: true });
  logger.info('Plugin uninstalled from marketplace', { pluginName });
  return {
    success: true,
    action: 'uninstall',
    pluginName,
  };
}
