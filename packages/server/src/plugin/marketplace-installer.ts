import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PluginArtifactManifestSchema,
  type PluginArtifactManifest,
  type PluginMarketInstallRecord,
  type PluginMarketInstallResult,
  type PluginMarketVersion,
  type PluginSource,
} from '@tx5dr/contracts';
import {
  fetchPluginMarketIndex,
  findPluginMarketPlugin,
  selectPluginMarketInstallVersion,
  type PluginMarketFetchOptions,
} from './marketplace.js';
import { readPluginSource, writePluginSource } from './plugin-source.js';
import {
  resolveSafeRelativePath,
  validateArchiveRelativePath,
  validateExtractedTree,
} from './path-security.js';
import { createLogger } from '../utils/logger.js';
import { assertPluginApiCompatible } from './runtime-info.js';
import { SERVER_BUILD_INFO } from '../generated/buildInfo.js';

const logger = createLogger('PluginMarketplaceInstaller');
const execFileAsync = promisify(execFile);
const ENTRY_FILE_CANDIDATES = ['plugin.js', 'plugin.mjs', 'index.js', 'index.mjs'] as const;
const ARTIFACT_MANIFEST_FILE = 'tx5dr-plugin.json';
const MARKETPLACE_TEMP_DIR_NAME = '.plugin-market-tmp';
const MARKETPLACE_TEMP_DIR_PREFIX = 'install-';
const LEGACY_INSTALL_RECORD_CHANNEL = 'nightly';

function ensureHexSha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function resolveMarketplaceWorkspaceBase(pluginDir: string): string {
  const managedRoot = path.dirname(path.resolve(pluginDir));
  const workspaceBase = resolveSafeRelativePath(managedRoot, MARKETPLACE_TEMP_DIR_NAME);
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

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertHttpsMarketplaceAsset(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Plugin marketplace assets must use HTTPS: ${url}`);
  }
}

async function listZipArchiveEntries(archivePath: string): Promise<string[]> {
  if (process.platform === 'win32') {
    const command = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
      `$zip=[System.IO.Compression.ZipFile]::OpenRead(${quotePowerShellString(archivePath)});`,
      'try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }',
    ].join(' ');
    const { stdout } = await execFileAsync('powershell', ['-NoLogo', '-NoProfile', '-Command', command]);
    return stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  }

  const { stdout } = await execFileAsync('unzip', ['-Z', '-1', archivePath]);
  return stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
}

async function validateZipArchiveBeforeExtraction(archivePath: string): Promise<void> {
  const entries = await listZipArchiveEntries(archivePath);
  if (entries.length === 0) {
    throw new Error('Plugin archive is empty');
  }
  for (const entry of entries) {
    validateArchiveRelativePath(entry);
  }
}

async function extractZipArchive(archivePath: string, outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
  await validateZipArchiveBeforeExtraction(archivePath);

  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath "${archivePath.replace(/"/g, '`"')}" -DestinationPath "${outputDir.replace(/"/g, '`"')}" -Force`;
    await execFileAsync('powershell', ['-NoLogo', '-NoProfile', '-Command', command]);
  } else {
    await execFileAsync('unzip', ['-qq', archivePath, '-d', outputDir]);
  }

  await validateExtractedTree(outputDir);
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

/** The exact marketplace artifact selected for installation. */
type MarketplaceArtifact = PluginMarketVersion & { name: string };

async function readArtifactManifest(pluginRoot: string): Promise<PluginArtifactManifest> {
  const manifestPath = path.join(pluginRoot, ARTIFACT_MANIFEST_FILE);
  try {
    return PluginArtifactManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(`Plugin archive is missing ${ARTIFACT_MANIFEST_FILE}`);
    }
    throw new Error(
      `Plugin archive manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertArtifactMetadata(
  manifest: PluginArtifactManifest,
  expected: MarketplaceArtifact,
  pluginApiVersion: string,
): void {
  if (manifest.name !== expected.name) {
    throw new Error(`Plugin archive name mismatch: expected ${expected.name}, received ${manifest.name}`);
  }
  if (manifest.version !== expected.version) {
    throw new Error(
      `Plugin archive version mismatch: expected ${expected.version}, received ${manifest.version}`,
    );
  }
  if (manifest.minPluginApiVersion !== expected.minPluginApiVersion) {
    throw new Error(
      `Plugin archive Plugin API requirement mismatch: expected ${expected.minPluginApiVersion}, `
      + `received ${manifest.minPluginApiVersion}`,
    );
  }
  assertPluginApiCompatible(manifest.minPluginApiVersion, manifest.name, pluginApiVersion);
  const actualPermissions = [...manifest.permissions].sort();
  const catalogPermissions = [...expected.permissions].sort();
  if (JSON.stringify(actualPermissions) !== JSON.stringify(catalogPermissions)) {
    throw new Error(
      `Plugin archive permission mismatch for ${expected.name}: catalog and archive declarations differ`,
    );
  }
}

// Installer validation reads only the static manifest; plugin code is never
// executed before the Host loader takes ownership of the installed directory.
async function validateExtractedPlugin(
  pluginRoot: string,
  expected: MarketplaceArtifact,
  pluginApiVersion: string,
): Promise<void> {
  await resolvePluginEntryPath(pluginRoot);
  assertArtifactMetadata(await readArtifactManifest(pluginRoot), expected, pluginApiVersion);
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
  artifact: MarketplaceArtifact,
  pluginDir: string,
  options: {
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ archivePath: string; checksum: string; tempRoot: string }> {
  assertHttpsMarketplaceAsset(artifact.artifactUrl);
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
  const archivePath = path.join(tempRoot, `${artifact.name}-${artifact.version}.zip`);
  const payload = new Uint8Array(await response.arrayBuffer());
  const checksum = ensureHexSha256(payload);
  await fs.writeFile(archivePath, payload);
  return { archivePath, checksum, tempRoot };
}

export interface PluginMarketInstallOptions extends PluginMarketFetchOptions {
  /** Exact version confirmed by the user; omitted selects the newest compatible one. */
  version?: string;
  pluginApiVersion?: string;
}

/**
 * Installs or replaces a marketplace plugin with the version resolved for the
 * Host's Plugin API. Replacement may be a lower version when the installed one
 * is incompatible; callers own the user confirmation for that downgrade.
 */
export async function installPluginFromMarketplace(
  pluginName: string,
  pluginDir: string,
  options: PluginMarketInstallOptions = {},
  action: 'install' | 'update' = 'install',
): Promise<PluginMarketInstallResult> {
  const pluginApiVersion = options.pluginApiVersion ?? SERVER_BUILD_INFO.pluginApiVersion;
  const { index } = await fetchPluginMarketIndex(options);
  const plugin = findPluginMarketPlugin(index, pluginName);
  const artifact: MarketplaceArtifact = {
    ...selectPluginMarketInstallVersion(plugin, pluginApiVersion, options.version),
    name: plugin.name,
  };
  const { archivePath, checksum, tempRoot } = await downloadArchiveToTempFile(artifact, pluginDir, options);

  try {
    if (checksum.toLowerCase() !== artifact.sha256.toLowerCase()) {
      throw new Error(`Plugin asset checksum mismatch for ${pluginName}`);
    }

    const extractDir = path.join(tempRoot, 'extract');
    await extractZipArchive(archivePath, extractDir);
    const extractedRoot = await resolveExtractedPluginRoot(extractDir);
    await validateExtractedPlugin(extractedRoot, artifact, pluginApiVersion);

    const destinationDir = resolveSafeRelativePath(pluginDir, pluginName);
    if (!destinationDir) {
      throw new Error(`Invalid plugin destination path: ${pluginName}`);
    }

    const stagingDir = path.join(tempRoot, 'staging', pluginName);
    await fs.mkdir(path.dirname(stagingDir), { recursive: true });
    await fs.cp(extractedRoot, stagingDir, { recursive: true });
    await replacePluginDirectory(stagingDir, destinationDir);

    const record: PluginMarketInstallRecord = {
      version: artifact.version,
      // Hosts up to v1.0.1 require this field when reading the record. Keep it
      // so a station downgraded to such a Host still recognizes marketplace
      // plugins; this Host ignores it. Remove once those Hosts are unsupported.
      channel: LEGACY_INSTALL_RECORD_CHANNEL,
      artifactUrl: artifact.artifactUrl,
      sha256: artifact.sha256,
      installedAt: Date.now(),
    };
    await writePluginSource(destinationDir, {
      kind: 'marketplace',
      ...record,
    });
    logger.info('Plugin installed from marketplace', { pluginName, version: record.version, action });
    return {
      success: true,
      action,
      pluginName,
      record,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Reads the marketplace install record from disk. This is independent of the
 * loader, so an installed plugin rejected as incompatible is still visible.
 */
export async function readInstalledMarketplaceSource(
  pluginDir: string,
  pluginName: string,
): Promise<PluginSource | undefined> {
  const destinationDir = resolveSafeRelativePath(pluginDir, pluginName);
  if (!destinationDir) return undefined;
  const source = await readPluginSource(destinationDir);
  return source?.kind === 'marketplace' ? source : undefined;
}

export async function readInstalledMarketplaceVersions(
  pluginDir: string,
  pluginNames: readonly string[],
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  await Promise.all(pluginNames.map(async (pluginName) => {
    const source = await readInstalledMarketplaceSource(pluginDir, pluginName);
    if (source) versions.set(pluginName, source.version);
  }));
  return versions;
}

export async function uninstallPluginFromMarketplace(
  pluginName: string,
  pluginDir: string,
): Promise<PluginMarketInstallResult> {
  const destinationDir = resolveSafeRelativePath(pluginDir, pluginName);
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
