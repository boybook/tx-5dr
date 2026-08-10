import path from 'node:path';

import { createLogger } from '../../utils/logger.js';
import { AdifFileStore, type OpenResult } from './AdifFileStore.js';
import type { LegacyMigrationResult } from './LegacyLogbookMigrator.js';
import {
  LegacyLogbookMigrationWorker,
  type LegacyLogbookMigrationRunner,
} from './LegacyLogbookMigrationWorker.js';
import {
  NodeLegacyLogbookFileStore,
  type LegacyLogbookFileStore,
} from './LegacyLogbookFileStore.js';
import type {
  LegacyRetentionProof,
} from './LegacyLogbookRecovery.js';
import { inventoryOrphanLegacyLogbookArtifacts } from './legacyLogbookArtifacts.js';

const logger = createLogger('LegacyLogbookMaintenance');
const DEFAULT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type LegacyLogbookMaintenanceMigrator = LegacyLogbookMigrationRunner;

export interface LegacyLogbookMaintenanceStore {
  open(): Promise<OpenResult>;
  close(): Promise<void>;
}

export interface LegacyLogbookMaintenanceOptions {
  intervalMs?: number;
  fileStore?: LegacyLogbookFileStore;
  migrator?: LegacyLogbookMaintenanceMigrator;
  storeFactory?: (mainPath: string) => LegacyLogbookMaintenanceStore;
}

export interface LegacyLogbookMaintenanceIssue {
  stage: 'inventory' | 'migration' | 'open' | 'retention' | 'close';
  code: string;
  path?: string;
  message: string;
}

export interface LegacyLogbookMaintenanceResult {
  startedAt: number;
  completedAt: number;
  discoveredPaths: number;
  processedPaths: number;
  migratedOrphans: number;
  removedRecoverySets: number;
  issues: LegacyLogbookMaintenanceIssue[];
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retentionProof(opened: OpenResult): LegacyRetentionProof | undefined {
  if (!opened.scan || !opened.generation) return undefined;
  return {
    complete: opened.scan.incompleteTailRange === undefined
      && opened.scan.safeEnd === opened.scan.byteLength,
    recoveredDuringOpen: opened.recoveredFrom !== undefined,
    recordCount: opened.scan.records.length,
    generation: opened.generation,
  };
}

export class LegacyLogbookMaintenance {
  private readonly logbookDir: string;
  private readonly intervalMs: number;
  private readonly fileStore: LegacyLogbookFileStore;
  private readonly migrator: LegacyLogbookMaintenanceMigrator;
  private readonly storeFactory: (mainPath: string) => LegacyLogbookMaintenanceStore;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<LegacyLogbookMaintenanceResult>;

  constructor(logbookDir: string, options: LegacyLogbookMaintenanceOptions = {}) {
    this.logbookDir = path.resolve(logbookDir);
    this.intervalMs = options.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new RangeError('Legacy logbook maintenance interval must be positive');
    }
    this.fileStore = options.fileStore ?? new NodeLegacyLogbookFileStore();
    this.migrator = options.migrator ?? new LegacyLogbookMigrationWorker({ fileStore: this.fileStore });
    this.storeFactory = options.storeFactory ?? (mainPath => new AdifFileStore(mainPath));
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
    const startedAt = Date.now();
    const run = this.runPass(startedAt)
      .catch((error): LegacyLogbookMaintenanceResult => ({
        startedAt,
        completedAt: Date.now(),
        discoveredPaths: 0,
        processedPaths: 0,
        migratedOrphans: 0,
        removedRecoverySets: 0,
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
        logger.warn('Logbook maintenance completed with isolated issues', {
          discoveredPaths: result.discoveredPaths,
          processedPaths: result.processedPaths,
          issueCount: result.issues.length,
        });
      } else if (result.processedPaths > 0) {
        logger.debug('Logbook maintenance completed', {
          processedPaths: result.processedPaths,
          migratedOrphans: result.migratedOrphans,
          removedRecoverySets: result.removedRecoverySets,
        });
      }
      if (this.inFlight === run) this.inFlight = undefined;
    });
    return run;
  }

  private async runPass(startedAt: number): Promise<LegacyLogbookMaintenanceResult> {
    const issues: LegacyLogbookMaintenanceIssue[] = [];
    const entries = await this.fileStore.listDirectory(this.logbookDir);
    const existingMainPaths = entries
      .filter(entry => entry.isFile && entry.name.toLowerCase().endsWith('.adi'))
      .map(entry => path.join(this.logbookDir, entry.name));
    const orphanGroups = await inventoryOrphanLegacyLogbookArtifacts(this.logbookDir, this.fileStore);
    const orphanPaths = new Set(orphanGroups.map(group => path.resolve(group.mainPath)));
    const targets = [
      ...orphanPaths,
      ...existingMainPaths.map(mainPath => path.resolve(mainPath))
        .filter(mainPath => !orphanPaths.has(mainPath)),
    ];
    let processedPaths = 0;
    let migratedOrphans = 0;
    let removedRecoverySets = 0;

    for (const mainPath of targets) {
      processedPaths += 1;
      const migration = await this.migrateOne(mainPath, issues);
      if (!migration || migration.status === 'FAILED') continue;
      if (!await this.fileStore.exists(mainPath)) {
        issues.push({
          stage: 'migration',
          code: 'LEGACY_MIGRATION_MAIN_MISSING',
          path: mainPath,
          message: 'Legacy migration did not produce a formal ADIF file; empty-file recovery was deferred',
        });
        continue;
      }
      if (orphanPaths.has(mainPath)) {
        migratedOrphans += 1;
      }

      let store: LegacyLogbookMaintenanceStore | undefined;
      try {
        store = this.storeFactory(mainPath);
        const opened = await store.open();
        if (opened.status === 'unavailable' || opened.status === 'uncertain' || opened.status === 'read-only') {
          issues.push({
            stage: 'open',
            code: 'LOGBOOK_MAINTENANCE_OPEN_DEGRADED',
            path: mainPath,
            message: `Inactive logbook opened as ${opened.status}; destructive retention was deferred`,
          });
        }
        for (const issue of opened.issues) {
          issues.push({
            stage: 'open',
            code: issue.code,
            path: issue.path ?? mainPath,
            message: issue.message,
          });
        }

        const proof = retentionProof(opened);
        if (proof) {
          const cleanup = await this.migrator.cleanupExpired(mainPath, proof);
          removedRecoverySets += cleanup.removedRecoverySets;
          for (const issue of cleanup.issues) {
            issues.push({
              stage: 'retention',
              code: issue.code,
              path: issue.path ?? mainPath,
              message: issue.message,
            });
          }
        }
      } catch (error) {
        issues.push({
          stage: 'open',
          code: 'LOGBOOK_MAINTENANCE_OPEN_FAILED',
          path: mainPath,
          message: asMessage(error),
        });
      } finally {
        if (store) {
          try {
            await store.close();
          } catch (error) {
            issues.push({
              stage: 'close',
              code: 'LOGBOOK_MAINTENANCE_CLOSE_FAILED',
              path: mainPath,
              message: asMessage(error),
            });
          }
        }
      }
    }

    return {
      startedAt,
      completedAt: Date.now(),
      discoveredPaths: targets.length,
      processedPaths,
      migratedOrphans,
      removedRecoverySets,
      issues,
    };
  }

  private async migrateOne(
    mainPath: string,
    issues: LegacyLogbookMaintenanceIssue[],
  ): Promise<LegacyMigrationResult | undefined> {
    try {
      const migration = await this.migrator.migrate(mainPath);
      for (const issue of migration.issues) {
        issues.push({
          stage: 'migration',
          code: issue.code,
          path: issue.path ?? mainPath,
          message: issue.message,
        });
      }
      if (migration.status === 'FAILED' && migration.issues.length === 0) {
        issues.push({
          stage: 'migration',
          code: 'LEGACY_MIGRATION_FAILED',
          path: mainPath,
          message: 'Legacy migration failed without a detailed issue',
        });
      }
      return migration;
    } catch (error) {
      issues.push({
        stage: 'migration',
        code: 'LEGACY_MIGRATION_FAILED',
        path: mainPath,
        message: asMessage(error),
      });
      return undefined;
    }
  }
}
