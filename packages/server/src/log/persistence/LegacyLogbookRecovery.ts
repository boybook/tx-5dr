import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  NodeLegacyLogbookFileStore,
  type LegacyLogbookFileStore,
} from './LegacyLogbookFileStore.js';
import {
  classifyLegacyLogbookArtifactName,
  type LegacyLogbookArtifact,
} from './legacyLogbookArtifacts.js';

const MANIFEST_VERSION = 1;
export const LEGACY_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface LegacyRecoveryArtifact {
  name: string;
  size: number;
  sha256: string;
}

export interface LegacyRecoveryManifest {
  schemaVersion: 1;
  mainPath: string;
  pathHash: string;
  state: 'cleanup_pending' | 'complete';
  createdAt: number;
  completedAt?: number;
  expiresAt?: number;
  candidateSha256: string;
  candidateRecordCount: number;
  artifacts: LegacyRecoveryArtifact[];
}

export interface LegacyRecoveryIssue {
  code: string;
  path?: string;
  message: string;
}

export interface LegacyRecoveryResult {
  state: 'NONE' | 'CLEANUP_PENDING' | 'COMPLETE';
  /** A durable manifest proves these exact artifacts were already folded into the formal ADIF. */
  legacyStateCommitted: boolean;
  recoveryPath?: string;
  issues: LegacyRecoveryIssue[];
}

export interface LegacyRetentionResult {
  removedRecoverySets: number;
  issues: LegacyRecoveryIssue[];
}

export interface LegacyRetentionProof {
  complete: boolean;
  recoveredDuringOpen: boolean;
  recordCount: number;
  generation: {
    size: number;
    mtimeMs: number;
    contentHash: string;
    dev?: number;
    ino?: number;
  };
}

function hashBuffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function legacyLogbookPathHash(mainPath: string): string {
  return createHash('sha256').update(path.resolve(mainPath)).digest('hex').slice(0, 24);
}

function isManifest(value: unknown): value is LegacyRecoveryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Partial<LegacyRecoveryManifest>;
  const mainBasename = typeof manifest.mainPath === 'string'
    ? path.basename(manifest.mainPath)
    : '';
  return manifest.schemaVersion === MANIFEST_VERSION
    && typeof manifest.mainPath === 'string'
    && typeof manifest.pathHash === 'string'
    && (manifest.state === 'cleanup_pending' || manifest.state === 'complete')
    && typeof manifest.createdAt === 'number'
    && typeof manifest.candidateSha256 === 'string'
    && typeof manifest.candidateRecordCount === 'number'
    && Number.isSafeInteger(manifest.candidateRecordCount)
    && manifest.candidateRecordCount >= 0
    && Array.isArray(manifest.artifacts)
    && manifest.artifacts.every(artifact => Boolean(artifact)
      && typeof artifact.name === 'string'
      && path.basename(artifact.name) === artifact.name
      && Boolean(classifyLegacyLogbookArtifactName(mainBasename, artifact.name))
      && typeof artifact.size === 'number'
      && Number.isSafeInteger(artifact.size)
      && artifact.size >= 0
      && typeof artifact.sha256 === 'string');
}

async function readManifest(
  fileStore: LegacyLogbookFileStore,
  manifestPath: string,
): Promise<LegacyRecoveryManifest | null> {
  try {
    const parsed = JSON.parse((await fileStore.readFile(manifestPath)).toString('utf8')) as unknown;
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export class LegacyLogbookRecoveryManager {
  constructor(
    private readonly fileStore: LegacyLogbookFileStore = new NodeLegacyLogbookFileStore(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  getRecoveryRoot(mainPath: string): string {
    return path.join(
      path.dirname(mainPath),
      '.tx5dr-recovery',
      legacyLogbookPathHash(mainPath),
    );
  }

  private async writeManifest(root: string, manifest: LegacyRecoveryManifest): Promise<void> {
    const manifestPath = path.join(root, 'manifest.json');
    const tempPath = path.join(root, 'manifest.json.tmp');
    await this.fileStore.writeFileDurable(
      tempPath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    );
    await this.fileStore.rename(tempPath, manifestPath);
    await this.fileStore.syncDirectory(root);
  }

  private async buildPlannedArtifacts(
    artifacts: LegacyLogbookArtifact[],
  ): Promise<LegacyRecoveryArtifact[]> {
    const planned: LegacyRecoveryArtifact[] = [];
    for (const artifact of artifacts) {
      if (!await this.fileStore.exists(artifact.path)) continue;
      const data = await this.fileStore.readFile(artifact.path);
      planned.push({ name: artifact.name, size: data.length, sha256: hashBuffer(data) });
    }
    return planned.sort((left, right) => left.name.localeCompare(right.name));
  }

  async quarantine(
    mainPath: string,
    candidateSha256: string,
    candidateRecordCount: number,
    artifacts: LegacyLogbookArtifact[],
  ): Promise<LegacyRecoveryResult> {
    const root = this.getRecoveryRoot(mainPath);
    const legacyDir = path.join(root, 'legacy');
    const issues: LegacyRecoveryIssue[] = [];
    let manifestDurable = false;

    try {
      await this.fileStore.makeDirectory(legacyDir);
      const planned = await this.buildPlannedArtifacts(artifacts);
      const existing = await readManifest(this.fileStore, path.join(root, 'manifest.json'));
      if (existing && !this.manifestMatchesMainPath(existing, mainPath)) {
        return {
          state: 'CLEANUP_PENDING',
          legacyStateCommitted: false,
          recoveryPath: root,
          issues: [{
            code: 'RECOVERY_MANIFEST_PATH_MISMATCH',
            path: path.join(root, 'manifest.json'),
            message: 'Recovery manifest does not belong to this logbook path',
          }],
        };
      }
      const mergedArtifacts = new Map<string, LegacyRecoveryArtifact>();
      for (const artifact of existing?.artifacts ?? []) mergedArtifacts.set(artifact.name, artifact);
      for (const artifact of planned) mergedArtifacts.set(artifact.name, artifact);

      const manifest: LegacyRecoveryManifest = {
        schemaVersion: MANIFEST_VERSION,
        mainPath: path.resolve(mainPath),
        pathHash: legacyLogbookPathHash(mainPath),
        state: 'cleanup_pending',
        createdAt: existing?.createdAt ?? this.now(),
        candidateSha256,
        candidateRecordCount,
        artifacts: [...mergedArtifacts.values()].sort((left, right) => left.name.localeCompare(right.name)),
      };
      await this.writeManifest(root, manifest);
      manifestDurable = true;
      return this.finishPendingManifest(mainPath, manifest);
    } catch (error) {
      issues.push({
        code: 'RECOVERY_PREPARE_FAILED',
        path: root,
        message: (error as Error).message,
      });
      return {
        state: 'CLEANUP_PENDING',
        legacyStateCommitted: manifestDurable,
        recoveryPath: root,
        issues,
      };
    }
  }

  async resumePending(mainPath: string): Promise<LegacyRecoveryResult> {
    const root = this.getRecoveryRoot(mainPath);
    const manifestPath = path.join(root, 'manifest.json');
    if (!await this.fileStore.exists(manifestPath)) {
      return { state: 'NONE', legacyStateCommitted: false, issues: [] };
    }

    const manifest = await readManifest(this.fileStore, manifestPath);
    if (!manifest || !this.manifestMatchesMainPath(manifest, mainPath)) {
      return {
        state: 'CLEANUP_PENDING',
        legacyStateCommitted: false,
        recoveryPath: root,
        issues: [{ code: 'RECOVERY_MANIFEST_INVALID', path: manifestPath, message: 'Recovery manifest is invalid' }],
      };
    }
    if (manifest.state === 'complete') {
      return {
        state: 'COMPLETE',
        legacyStateCommitted: true,
        recoveryPath: root,
        issues: [],
      };
    }
    return this.finishPendingManifest(mainPath, manifest);
  }

  private async finishPendingManifest(
    mainPath: string,
    manifest: LegacyRecoveryManifest,
  ): Promise<LegacyRecoveryResult> {
    const root = this.getRecoveryRoot(mainPath);
    const legacyDir = path.join(root, 'legacy');
    const issues: LegacyRecoveryIssue[] = [];

    for (const artifact of manifest.artifacts) {
      const sourcePath = path.join(path.dirname(mainPath), artifact.name);
      const targetPath = path.join(legacyDir, artifact.name);
      try {
        const sourceExists = await this.fileStore.exists(sourcePath);
        const targetExists = await this.fileStore.exists(targetPath);
        if (targetExists) {
          const target = await this.fileStore.readFile(targetPath);
          if (target.length !== artifact.size || hashBuffer(target) !== artifact.sha256) {
            throw new Error('Recovery target does not match the manifest');
          }
          if (sourceExists) {
            const source = await this.fileStore.readFile(sourcePath);
            if (source.length !== artifact.size || hashBuffer(source) !== artifact.sha256) {
              throw new Error('Source changed after migration commit');
            }
            await this.fileStore.unlink(sourcePath);
          }
          continue;
        }
        if (!sourceExists) throw new Error('Both source and recovery target are missing');

        const source = await this.fileStore.readFile(sourcePath);
        if (source.length !== artifact.size || hashBuffer(source) !== artifact.sha256) {
          throw new Error('Source changed after migration commit');
        }
        await this.fileStore.rename(sourcePath, targetPath);
      } catch (error) {
        issues.push({ code: 'RECOVERY_MOVE_FAILED', path: sourcePath, message: (error as Error).message });
      }
    }

    await this.fileStore.syncDirectory(path.dirname(mainPath));
    await this.fileStore.syncDirectory(legacyDir);
    if (issues.length > 0) {
      return {
        state: 'CLEANUP_PENDING',
        legacyStateCommitted: true,
        recoveryPath: root,
        issues,
      };
    }

    const completedAt = this.now();
    const complete: LegacyRecoveryManifest = {
      ...manifest,
      state: 'complete',
      completedAt,
      expiresAt: completedAt + LEGACY_RECOVERY_RETENTION_MS,
    };
    try {
      await this.writeManifest(root, complete);
      return {
        state: 'COMPLETE',
        legacyStateCommitted: true,
        recoveryPath: root,
        issues: [],
      };
    } catch (error) {
      return {
        state: 'CLEANUP_PENDING',
        legacyStateCommitted: true,
        recoveryPath: root,
        issues: [{ code: 'RECOVERY_MANIFEST_WRITE_FAILED', path: root, message: (error as Error).message }],
      };
    }
  }

  private manifestMatchesMainPath(
    manifest: LegacyRecoveryManifest,
    mainPath: string,
  ): boolean {
    const resolvedMainPath = path.resolve(mainPath);
    return path.resolve(manifest.mainPath) === resolvedMainPath
      && manifest.pathHash === legacyLogbookPathHash(resolvedMainPath);
  }

  private async removeIfPresent(filePath: string): Promise<void> {
    try {
      await this.fileStore.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async removeDirectoryIfPresent(dirPath: string): Promise<void> {
    try {
      await this.fileStore.removeDirectory(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async cleanupCompleteRecoverySet(
    mainPath: string,
    root: string,
    manifestPath: string,
    manifest: LegacyRecoveryManifest,
  ): Promise<void> {
    const legacyDir = path.join(root, 'legacy');
    for (const artifact of manifest.artifacts) {
      if (!classifyLegacyLogbookArtifactName(path.basename(mainPath), artifact.name)) {
        throw new Error(`Recovery manifest contains an unrecognized artifact: ${artifact.name}`);
      }
      const artifactPath = path.join(legacyDir, artifact.name);
      if (await this.fileStore.exists(artifactPath)) {
        const current = await this.fileStore.readFile(artifactPath);
        if (current.length !== artifact.size || hashBuffer(current) !== artifact.sha256) {
          throw new Error(`Recovery artifact changed after quarantine: ${artifact.name}`);
        }
      }
      await this.removeIfPresent(artifactPath);
    }
    await this.removeIfPresent(path.join(root, 'manifest.json.tmp'));
    await this.removeDirectoryIfPresent(legacyDir);
    await this.removeIfPresent(manifestPath);
    await this.fileStore.syncDirectory(root);

    await this.cleanupEmptyRecoveryDirectories(root);
  }

  private async validateCompleteRecoveryArtifacts(
    mainPath: string,
    root: string,
    manifest: LegacyRecoveryManifest,
  ): Promise<LegacyRecoveryIssue[]> {
    const legacyDir = path.join(root, 'legacy');
    const mainBasename = path.basename(mainPath);
    const issues: LegacyRecoveryIssue[] = [];

    for (const artifact of manifest.artifacts) {
      const artifactPath = path.join(legacyDir, artifact.name);
      if (!classifyLegacyLogbookArtifactName(mainBasename, artifact.name)) {
        issues.push({
          code: 'RECOVERY_MANIFEST_INVALID',
          path: artifactPath,
          message: 'Recovery manifest contains an unrecognized artifact',
        });
        continue;
      }
      if (!await this.fileStore.exists(artifactPath)) continue;

      try {
        const current = await this.fileStore.readFile(artifactPath);
        if (current.length !== artifact.size || hashBuffer(current) !== artifact.sha256) {
          issues.push({
            code: 'RECOVERY_RETENTION_ARTIFACT_CHANGED',
            path: artifactPath,
            message: 'Recovery artifact changed after quarantine; automatic cleanup was deferred',
          });
        }
      } catch (error) {
        issues.push({
          code: 'RECOVERY_RETENTION_ARTIFACT_UNREADABLE',
          path: artifactPath,
          message: `Recovery artifact could not be verified; automatic cleanup was deferred: ${(error as Error).message}`,
        });
      }
    }

    return issues;
  }

  private async cleanupEmptyRecoveryDirectories(root: string): Promise<void> {
    // The root is shared with the active store's bounded recovery files. Those
    // files must survive legacy retention cleanup, so directory removal is only
    // a best-effort empty-directory cleanup and is not part of success.
    const recoveryBase = path.dirname(root);
    await this.fileStore.removeDirectory(root).catch(() => undefined);
    await this.fileStore.syncDirectory(recoveryBase);
    await this.fileStore.removeDirectory(recoveryBase).catch(() => undefined);
    await this.fileStore.syncDirectory(path.dirname(recoveryBase));
  }

  private retentionProofIsSafe(
    proof: LegacyRetentionProof,
  ): boolean {
    return proof.complete
      && !proof.recoveredDuringOpen
      && Number.isSafeInteger(proof.recordCount)
      && proof.recordCount >= 0;
  }

  private async currentMainMatchesProof(
    mainPath: string,
    proof: LegacyRetentionProof,
  ): Promise<boolean> {
    const current = await this.fileStore.stat(mainPath);
    if (!(current.size === proof.generation.size
      && current.mtimeMs === proof.generation.mtimeMs
      && (proof.generation.dev === undefined || current.dev === proof.generation.dev)
      && (proof.generation.ino === undefined || current.ino === proof.generation.ino)
      && Boolean(proof.generation.contentHash))) {
      return false;
    }
    return hashBuffer(await this.fileStore.readFile(mainPath)) === proof.generation.contentHash;
  }

  private async invalidManifestRetentionAnchor(
    root: string,
    manifestPath: string,
  ): Promise<number> {
    const legacyDir = path.join(root, 'legacy');
    const stats = await Promise.all([
      this.fileStore.stat(manifestPath).catch(() => undefined),
      this.fileStore.stat(legacyDir).catch(() => undefined),
    ]);
    return Math.max(...stats.map(stat => stat?.mtimeMs ?? 0));
  }

  private async cleanupInvalidManifestRecoverySet(
    mainPath: string,
    proof: LegacyRetentionProof,
    root: string,
    manifestPath: string,
  ): Promise<LegacyRetentionResult> {
    const retainedIssue: LegacyRecoveryIssue = {
      code: 'RECOVERY_MANIFEST_INVALID',
      path: manifestPath,
      message: 'Recovery manifest is invalid; cleanup was deferred using recovery directory age',
    };
    const retentionAnchor = await this.invalidManifestRetentionAnchor(root, manifestPath);
    if (
      retentionAnchor <= 0
      || this.now() - retentionAnchor < LEGACY_RECOVERY_RETENTION_MS
      || !this.retentionProofIsSafe(proof)
    ) {
      return { removedRecoverySets: 0, issues: [retainedIssue] };
    }
    if (!await this.currentMainMatchesProof(mainPath, proof)) {
      return {
        removedRecoverySets: 0,
        issues: [{
          code: 'RECOVERY_RETENTION_PROOF_STALE',
          path: mainPath,
          message: 'The logbook changed after its retention safety scan; invalid legacy recovery was retained',
        }],
      };
    }

    const legacyDir = path.join(root, 'legacy');
    const entries = await this.fileStore.listDirectory(legacyDir).catch(() => []);
    const unknownNames: string[] = [];
    for (const entry of entries) {
      if (entry.isFile && classifyLegacyLogbookArtifactName(path.basename(mainPath), entry.name)) {
        await this.removeIfPresent(path.join(legacyDir, entry.name));
      } else {
        unknownNames.push(entry.name);
      }
    }
    await this.removeIfPresent(path.join(root, 'manifest.json.tmp'));
    await this.removeIfPresent(manifestPath);
    if (unknownNames.length === 0) await this.removeDirectoryIfPresent(legacyDir);
    await this.fileStore.syncDirectory(root);
    await this.cleanupEmptyRecoveryDirectories(root);

    return {
      removedRecoverySets: 1,
      issues: unknownNames.length === 0 ? [] : [{
        code: 'RECOVERY_RETENTION_UNKNOWN_FILES',
        path: legacyDir,
        message: `Preserved ${unknownNames.length} unrecognized recovery file(s)`,
      }],
    };
  }

  async cleanupExpiredFor(
    mainPath: string,
    proof: LegacyRetentionProof,
  ): Promise<LegacyRetentionResult> {
    const resolvedMainPath = path.resolve(mainPath);
    const root = this.getRecoveryRoot(resolvedMainPath);
    const manifestPath = path.join(root, 'manifest.json');
    if (!await this.fileStore.exists(manifestPath)) {
      return { removedRecoverySets: 0, issues: [] };
    }
    const manifest = await readManifest(this.fileStore, manifestPath);
    if (!manifest) {
      try {
        return await this.cleanupInvalidManifestRecoverySet(
          resolvedMainPath,
          proof,
          root,
          manifestPath,
        );
      } catch (error) {
        return {
          removedRecoverySets: 0,
          issues: [{ code: 'RECOVERY_RETENTION_FAILED', path: root, message: (error as Error).message }],
        };
      }
    }
    if (!this.manifestMatchesMainPath(manifest, resolvedMainPath)) {
      return {
        removedRecoverySets: 0,
        issues: [{
          code: 'RECOVERY_MANIFEST_PATH_MISMATCH',
          path: manifestPath,
          message: 'Recovery manifest does not belong to this logbook path',
        }],
      };
    }
    if (manifest.state !== 'complete' || !manifest.expiresAt || manifest.expiresAt > this.now()) {
      return { removedRecoverySets: 0, issues: [] };
    }

    if (!this.retentionProofIsSafe(proof)) {
      return { removedRecoverySets: 0, issues: [] };
    }

    try {
      if (!await this.currentMainMatchesProof(resolvedMainPath, proof)) {
        return {
          removedRecoverySets: 0,
          issues: [{
            code: 'RECOVERY_RETENTION_PROOF_STALE',
            path: resolvedMainPath,
            message: 'The logbook changed after its retention safety scan; legacy recovery was retained',
          }],
        };
      }
      const artifactIssues = await this.validateCompleteRecoveryArtifacts(
        resolvedMainPath,
        root,
        manifest,
      );
      if (artifactIssues.length > 0) {
        return { removedRecoverySets: 0, issues: artifactIssues };
      }
      await this.cleanupCompleteRecoverySet(resolvedMainPath, root, manifestPath, manifest);
      return { removedRecoverySets: 1, issues: [] };
    } catch (error) {
      return {
        removedRecoverySets: 0,
        issues: [{ code: 'RECOVERY_RETENTION_FAILED', path: root, message: (error as Error).message }],
      };
    }
  }

}
