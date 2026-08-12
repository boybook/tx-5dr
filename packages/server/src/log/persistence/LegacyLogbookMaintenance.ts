import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

import { createLogger } from '../../utils/logger.js';
import { LogbookScanWorker } from './LogbookScanWorker.js';
import type { LogbookScanner } from './LogbookScanTypes.js';
import {
  classifyLegacyLogbookArtifactName,
  inferLegacyMainBasename,
  isKnownQuarantinedName,
  LEGACY_DIRECTORY_NAME,
  LEGACY_RECOVERY_DATA_NAMES,
  LEGACY_RETENTION_MS,
  LEGACY_UNRECOVERABLE_NAME,
  OBSOLETE_RECOVERY_TEMP_NAMES,
} from './legacyLogbookArtifacts.js';

const logger = createLogger('LegacyLogbookMaintenance');
const DEFAULT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface LegacyLogbookMaintenanceOptions {
  intervalMs?: number;
  scanner?: LogbookScanner;
  now?: () => number;
}

export interface LegacyLogbookMaintenanceIssue {
  stage: 'inventory' | 'quarantine' | 'retention';
  code: string;
  path?: string;
  message: string;
}

export interface LegacyLogbookMaintenanceResult {
  startedAt: number;
  completedAt: number;
  discoveredPaths: number;
  processedPaths: number;
  quarantinedArtifacts: number;
  quarantinedOrphans: number;
  deletedObsoleteArtifacts: number;
  preservedUnrecoverable: number;
  removedLegacyDirectories: number;
  issues: LegacyLogbookMaintenanceIssue[];
}

interface DirectoryEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface PassCounters {
  quarantinedArtifacts: number;
  quarantinedOrphans: number;
  deletedObsoleteArtifacts: number;
  preservedUnrecoverable: number;
  removedLegacyDirectories: number;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function legacyPathFingerprint(mainPath: string): string {
  return createHash('sha256').update(path.resolve(mainPath)).digest('hex').slice(0, 24);
}

async function listDirectory(directory: string): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.map(entry => ({
    name: entry.name,
    isFile: entry.isFile(),
    isDirectory: entry.isDirectory(),
  }));
}

async function pathIsDirectory(directory: string): Promise<boolean> {
  try {
    return (await fs.lstat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (leftStat.size !== rightStat.size) return false;
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash === rightHash;
}

async function removeDirectoryIfEmpty(directory: string): Promise<boolean> {
  try {
    await fs.rmdir(directory);
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  }
}

export class LegacyLogbookMaintenance {
  private readonly logbookDir: string;
  private readonly intervalMs: number;
  private readonly scanner: LogbookScanner;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<LegacyLogbookMaintenanceResult>;

  constructor(logbookDir: string, options: LegacyLogbookMaintenanceOptions = {}) {
    this.logbookDir = path.resolve(logbookDir);
    this.intervalMs = options.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError('Legacy logbook maintenance interval must be positive');
    }
    this.scanner = options.scanner ?? new LogbookScanWorker();
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runNow();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.runNow();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  runNow(): Promise<LegacyLogbookMaintenanceResult> {
    if (this.inFlight) return this.inFlight;
    const startedAt = this.now();
    const run = this.runPass(startedAt).catch((error): LegacyLogbookMaintenanceResult => ({
      startedAt,
      completedAt: this.now(),
      discoveredPaths: 0,
      processedPaths: 0,
      quarantinedArtifacts: 0,
      quarantinedOrphans: 0,
      deletedObsoleteArtifacts: 0,
      preservedUnrecoverable: 0,
      removedLegacyDirectories: 0,
      issues: [{
        stage: 'inventory',
        code: 'LEGACY_MAINTENANCE_FAILED',
        path: this.logbookDir,
        message: asMessage(error),
      }],
    }));
    this.inFlight = run;
    void run.then((result) => {
      if (result.issues.length > 0) {
        logger.warn('Legacy logbook cleanup completed with isolated issues', {
          processedPaths: result.processedPaths,
          issueCount: result.issues.length,
        });
      } else if (result.processedPaths > 0) {
        logger.debug('Legacy logbook cleanup completed', {
          processedPaths: result.processedPaths,
          quarantinedArtifacts: result.quarantinedArtifacts,
          removedLegacyDirectories: result.removedLegacyDirectories,
        });
      }
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  private async runPass(startedAt: number): Promise<LegacyLogbookMaintenanceResult> {
    const issues: LegacyLogbookMaintenanceIssue[] = [];
    const entries = await listDirectory(this.logbookDir);
    const mainBasenames = await this.discoverMainBasenames(entries);
    const counters: PassCounters = {
      quarantinedArtifacts: 0,
      quarantinedOrphans: 0,
      deletedObsoleteArtifacts: 0,
      preservedUnrecoverable: 0,
      removedLegacyDirectories: 0,
    };
    let processedPaths = 0;

    for (const mainBasename of mainBasenames) {
      const mainPath = path.join(this.logbookDir, mainBasename);
      processedPaths += 1;
      try {
        await this.processLogbook(mainPath, entries, counters, issues);
      } catch (error) {
        issues.push({
          stage: 'quarantine',
          code: 'LEGACY_LOGBOOK_CLEANUP_FAILED',
          path: mainPath,
          message: asMessage(error),
        });
      }
    }

    return {
      startedAt,
      completedAt: this.now(),
      discoveredPaths: mainBasenames.length,
      processedPaths,
      ...counters,
      issues,
    };
  }

  private async discoverMainBasenames(entries: DirectoryEntry[]): Promise<string[]> {
    const names = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (/\.adi$/i.test(entry.name)) names.add(entry.name);
      const inferred = inferLegacyMainBasename(entry.name);
      if (inferred) names.add(inferred);
    }

    const backupBase = path.join(this.logbookDir, '.tx5dr-backups');
    if (await pathIsDirectory(backupBase)) {
      for (const entry of await listDirectory(backupBase).catch(() => [])) {
        if (entry.isDirectory && /\.adi$/i.test(entry.name)) names.add(entry.name);
      }
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }

  private async processLogbook(
    mainPath: string,
    topLevelEntries: DirectoryEntry[],
    counters: PassCounters,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<void> {
    const mainBasename = path.basename(mainPath);
    const backupDirectory = path.join(this.logbookDir, '.tx5dr-backups', mainBasename);
    const legacyDirectory = path.join(backupDirectory, LEGACY_DIRECTORY_NAME);
    const oldRecoveryBase = path.join(this.logbookDir, '.tx5dr-recovery');
    const oldRecoveryRoot = path.join(oldRecoveryBase, legacyPathFingerprint(mainPath));
    const mainExists = await pathIsFile(mainPath);
    const artifacts = topLevelEntries.filter(entry => entry.isFile
      && classifyLegacyLogbookArtifactName(mainBasename, entry.name));
    const hasExistingLegacy = await pathIsDirectory(legacyDirectory);
    const hasOldRecovery = await pathIsDirectory(oldRecoveryRoot);
    if (artifacts.length === 0 && !hasExistingLegacy && !hasOldRecovery) return;

    let quarantinedForOrphan = 0;
    for (const artifact of artifacts) {
      const moved = await this.moveToLegacy(
        path.join(this.logbookDir, artifact.name),
        artifact.name,
        backupDirectory,
        legacyDirectory,
        issues,
      );
      if (moved) {
        counters.quarantinedArtifacts += 1;
        quarantinedForOrphan += 1;
      }
    }
    if (!mainExists && quarantinedForOrphan > 0) counters.quarantinedOrphans += 1;

    if (hasOldRecovery) {
      await this.convergeOldRecovery(
        mainBasename,
        oldRecoveryRoot,
        backupDirectory,
        legacyDirectory,
        counters,
        issues,
      );
      await removeDirectoryIfEmpty(oldRecoveryRoot);
      await removeDirectoryIfEmpty(oldRecoveryBase);
    }

    await this.applyRetention(mainPath, backupDirectory, legacyDirectory, counters, issues);
  }

  private async convergeOldRecovery(
    mainBasename: string,
    oldRecoveryRoot: string,
    backupDirectory: string,
    legacyDirectory: string,
    counters: PassCounters,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<void> {
    const entries = await listDirectory(oldRecoveryRoot).catch(() => []);
    for (const entry of entries) {
      const source = path.join(oldRecoveryRoot, entry.name);
      if (entry.isFile && OBSOLETE_RECOVERY_TEMP_NAMES.has(entry.name)) {
        await fs.unlink(source);
        counters.deletedObsoleteArtifacts += 1;
      } else if (entry.isFile && entry.name === LEGACY_UNRECOVERABLE_NAME) {
        if (await this.preserveUnrecoverable(source, backupDirectory, issues)) {
          counters.preservedUnrecoverable += 1;
        }
      } else if (entry.isFile && (
        LEGACY_RECOVERY_DATA_NAMES.has(entry.name)
        || classifyLegacyLogbookArtifactName(mainBasename, entry.name)
      )) {
        if (await this.moveToLegacy(
          source,
          entry.name,
          backupDirectory,
          legacyDirectory,
          issues,
        )) counters.quarantinedArtifacts += 1;
      } else if (entry.isDirectory && entry.name === LEGACY_DIRECTORY_NAME) {
        await this.convergeOldLegacyDirectory(
          mainBasename,
          source,
          backupDirectory,
          legacyDirectory,
          counters,
          issues,
        );
      }
    }
  }

  private async convergeOldLegacyDirectory(
    mainBasename: string,
    oldLegacyDirectory: string,
    backupDirectory: string,
    legacyDirectory: string,
    counters: PassCounters,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<void> {
    for (const entry of await listDirectory(oldLegacyDirectory).catch(() => [])) {
      if (!entry.isFile) continue;
      const source = path.join(oldLegacyDirectory, entry.name);
      if (entry.name === LEGACY_UNRECOVERABLE_NAME) {
        if (await this.preserveUnrecoverable(source, backupDirectory, issues)) {
          counters.preservedUnrecoverable += 1;
        }
      } else if (isKnownQuarantinedName(mainBasename, entry.name)) {
        if (await this.moveToLegacy(
          source,
          entry.name,
          backupDirectory,
          legacyDirectory,
          issues,
        )) counters.quarantinedArtifacts += 1;
      }
    }
    await removeDirectoryIfEmpty(oldLegacyDirectory);
  }

  private async ensureRecoveryDirectories(backupDirectory: string, legacyDirectory?: string): Promise<void> {
    await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await fs.chmod(backupDirectory, 0o700).catch(() => undefined);
    if (legacyDirectory) {
      await fs.mkdir(legacyDirectory, { recursive: true, mode: 0o700 });
      await fs.chmod(legacyDirectory, 0o700).catch(() => undefined);
    }
  }

  private async moveToLegacy(
    source: string,
    name: string,
    backupDirectory: string,
    legacyDirectory: string,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<boolean> {
    if (!await pathIsFile(source)) return false;
    await this.ensureRecoveryDirectories(backupDirectory, legacyDirectory);
    const target = path.join(legacyDirectory, name);
    if (await pathIsFile(target)) {
      if (!await filesMatch(source, target)) {
        issues.push({
          stage: 'quarantine',
          code: 'LEGACY_QUARANTINE_CONFLICT',
          path: source,
          message: `A different quarantined artifact already exists with the fixed name ${name}`,
        });
        return false;
      }
      await fs.unlink(source);
      return true;
    }
    await fs.rename(source, target);
    return true;
  }

  private async preserveUnrecoverable(
    source: string,
    backupDirectory: string,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<boolean> {
    if (!await pathIsFile(source)) return false;
    await this.ensureRecoveryDirectories(backupDirectory);
    const target = path.join(backupDirectory, LEGACY_UNRECOVERABLE_NAME);
    if (await pathIsFile(target)) {
      if (await filesMatch(source, target)) {
        await fs.unlink(source);
        return true;
      }
      issues.push({
        stage: 'quarantine',
        code: 'UNRECOVERABLE_ORIGINAL_CONFLICT',
        path: source,
        message: 'A different unrecoverable original is already preserved; neither file was overwritten',
      });
      return false;
    }
    await fs.rename(source, target);
    return true;
  }

  private async applyRetention(
    mainPath: string,
    backupDirectory: string,
    legacyDirectory: string,
    counters: PassCounters,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<void> {
    if (!await pathIsDirectory(legacyDirectory)) return;
    const latestPath = path.join(backupDirectory, 'latest.adi');
    const [mainSafe, latestSafe] = await Promise.all([
      this.isSafeAdif(mainPath),
      this.isSafeAdif(latestPath),
    ]);
    if (!mainSafe || !latestSafe) {
      const date = new Date(this.now());
      await fs.utimes(legacyDirectory, date, date).catch((error) => {
        issues.push({
          stage: 'retention',
          code: 'LEGACY_RETENTION_ANCHOR_FAILED',
          path: legacyDirectory,
          message: asMessage(error),
        });
      });
      return;
    }

    const stat = await fs.stat(legacyDirectory);
    if (this.now() - stat.mtimeMs < LEGACY_RETENTION_MS) return;

    const mainBasename = path.basename(mainPath);
    for (const entry of await listDirectory(legacyDirectory)) {
      if (!entry.isFile || !isKnownQuarantinedName(mainBasename, entry.name)) continue;
      await fs.unlink(path.join(legacyDirectory, entry.name));
    }
    if (await removeDirectoryIfEmpty(legacyDirectory)) {
      counters.removedLegacyDirectories += 1;
    } else {
      issues.push({
        stage: 'retention',
        code: 'LEGACY_RETENTION_UNKNOWN_CONTENT',
        path: legacyDirectory,
        message: 'Unknown content remains in the legacy directory and was not deleted',
      });
    }
  }

  private async isSafeAdif(filePath: string): Promise<boolean> {
    try {
      const result = await this.scanner.scan(filePath);
      return result.scan.incompleteTailRange === undefined
        && result.scan.safeEnd === result.scan.byteLength;
    } catch {
      return false;
    }
  }
}
