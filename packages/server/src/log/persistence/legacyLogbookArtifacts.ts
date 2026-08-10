import path from 'node:path';

import {
  NodeLegacyLogbookFileStore,
  type LegacyLogbookFileStore,
} from './LegacyLogbookFileStore.js';

const SAFE_TIMESTAMP_SOURCE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z';
const TEMP_SUFFIX_SOURCE = 'tmp-\\d+-\\d+-\\d+';

export type LegacyJournalFamily = 'current' | 'adi-prefixed';
export type LegacyJournalStream = 'current' | 'archive';

export type LegacyLogbookArtifactKind =
  | 'snapshot-backup'
  | 'snapshot-temp'
  | 'snapshot-corrupt'
  | 'journal-current'
  | 'journal-current-copy'
  | 'journal-archive'
  | 'journal-archive-copy'
  | 'meta';

export interface LegacyLogbookArtifact {
  name: string;
  path: string;
  kind: LegacyLogbookArtifactKind;
  size: number;
  mtimeMs: number;
  journalFamily?: LegacyJournalFamily;
  journalStream?: LegacyJournalStream;
  archiveAtMs?: number;
}

export interface LegacyLogbookArtifactInventory {
  mainPath: string;
  mainExists: boolean;
  mainStat?: { size: number; mtimeMs: number };
  artifacts: LegacyLogbookArtifact[];
}

export interface OrphanLegacyLogbookArtifacts {
  mainPath: string;
  artifacts: LegacyLogbookArtifact[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSafeTimestamp(value: string): number | undefined {
  const iso = value.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1:$2:$3.$4Z',
  );
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function classifyJournal(
  name: string,
  prefix: string,
  family: LegacyJournalFamily,
): Omit<LegacyLogbookArtifact, 'name' | 'path' | 'size' | 'mtimeMs'> | null {
  const core = `${prefix}.journal.jsonl`;
  if (name === core) {
    return { kind: 'journal-current', journalFamily: family, journalStream: 'current' };
  }

  const escapedCore = escapeRegExp(core);
  const currentCopy = new RegExp(
    `^${escapedCore}(?:\\.corrupt-${SAFE_TIMESTAMP_SOURCE}(?:\\.${TEMP_SUFFIX_SOURCE})?|\\.${TEMP_SUFFIX_SOURCE})$`,
  );
  if (currentCopy.test(name)) {
    return { kind: 'journal-current-copy', journalFamily: family, journalStream: 'current' };
  }

  const archive = new RegExp(`^${escapedCore}\\.(${SAFE_TIMESTAMP_SOURCE})$`).exec(name);
  if (archive) {
    return {
      kind: 'journal-archive',
      journalFamily: family,
      journalStream: 'archive',
      archiveAtMs: parseSafeTimestamp(archive[1]),
    };
  }

  const archiveCopy = new RegExp(
    `^${escapedCore}\\.(${SAFE_TIMESTAMP_SOURCE})\\.corrupt-${SAFE_TIMESTAMP_SOURCE}(?:\\.${TEMP_SUFFIX_SOURCE})?$`,
  ).exec(name);
  if (archiveCopy) {
    return {
      kind: 'journal-archive-copy',
      journalFamily: family,
      journalStream: 'archive',
      archiveAtMs: parseSafeTimestamp(archiveCopy[1]),
    };
  }

  return null;
}

function isMetaArtifact(name: string, prefix: string): boolean {
  const core = escapeRegExp(`${prefix}.meta.json`);
  return new RegExp(
    `^${core}(?:|\\.bak\\.[12]|\\.${TEMP_SUFFIX_SOURCE}|\\.corrupt-${SAFE_TIMESTAMP_SOURCE}(?:\\.${TEMP_SUFFIX_SOURCE})?)$`,
  ).test(name);
}

export function classifyLegacyLogbookArtifactName(
  mainBasename: string,
  name: string,
): Omit<LegacyLogbookArtifact, 'name' | 'path' | 'size' | 'mtimeMs'> | null {
  const escapedMain = escapeRegExp(mainBasename);
  if (new RegExp(`^${escapedMain}\\.bak\\.[123]$`).test(name)) {
    return { kind: 'snapshot-backup' };
  }
  if (new RegExp(`^${escapedMain}\\.${TEMP_SUFFIX_SOURCE}$`).test(name)) {
    return { kind: 'snapshot-temp' };
  }
  if (new RegExp(`^${escapedMain}\\.corrupt-${SAFE_TIMESTAMP_SOURCE}$`).test(name)) {
    return { kind: 'snapshot-corrupt' };
  }
  const stem = mainBasename.replace(/\.adi$/i, '');
  const journal = classifyJournal(name, stem, 'current')
    ?? classifyJournal(name, mainBasename, 'adi-prefixed');
  if (journal) return journal;

  if (isMetaArtifact(name, stem) || isMetaArtifact(name, mainBasename)) {
    return { kind: 'meta' };
  }

  return null;
}

export async function inventoryLegacyLogbookArtifacts(
  mainPath: string,
  fileStore: LegacyLogbookFileStore = new NodeLegacyLogbookFileStore(),
): Promise<LegacyLogbookArtifactInventory> {
  const dir = path.dirname(mainPath);
  const mainBasename = path.basename(mainPath);
  const entries = await fileStore.listDirectory(dir).catch(() => []);
  const artifacts: LegacyLogbookArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isFile || entry.name === mainBasename) continue;
    const classified = classifyLegacyLogbookArtifactName(mainBasename, entry.name);
    if (!classified) continue;
    const artifactPath = path.join(dir, entry.name);
    const stat = await fileStore.stat(artifactPath).catch(() => null);
    if (!stat) continue;
    artifacts.push({
      ...classified,
      name: entry.name,
      path: artifactPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  const mainStat = await fileStore.stat(mainPath).catch(() => undefined);
  return {
    mainPath,
    mainExists: Boolean(mainStat),
    mainStat,
    artifacts: artifacts.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function inferMainBasename(name: string): string | null {
  const snapshotMatch = /^(.+\.adi)\.(?:bak\.[123]|tmp-\d+-\d+-\d+|corrupt-\d{4}-)/i.exec(name);
  if (snapshotMatch) return snapshotMatch[1];

  const sidecarMatch = /^(.+?)(?:\.journal\.jsonl|\.meta\.json)(?:$|\.)/i.exec(name);
  if (!sidecarMatch) return null;
  return sidecarMatch[1].toLowerCase().endsWith('.adi')
    ? sidecarMatch[1]
    : `${sidecarMatch[1]}.adi`;
}

export async function inventoryOrphanLegacyLogbookArtifacts(
  logbookDir: string,
  fileStore: LegacyLogbookFileStore = new NodeLegacyLogbookFileStore(),
): Promise<OrphanLegacyLogbookArtifacts[]> {
  const entries = await fileStore.listDirectory(logbookDir).catch(() => []);
  const fileNames = new Set(entries.filter(entry => entry.isFile).map(entry => entry.name));
  const candidateMainNames = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile) continue;
    const inferred = inferMainBasename(entry.name);
    if (inferred && !fileNames.has(inferred)) candidateMainNames.add(inferred);
  }

  const groups: OrphanLegacyLogbookArtifacts[] = [];
  for (const mainBasename of [...candidateMainNames].sort()) {
    const inventory = await inventoryLegacyLogbookArtifacts(
      path.join(logbookDir, mainBasename),
      fileStore,
    );
    if (!inventory.mainExists && inventory.artifacts.length > 0) {
      groups.push({ mainPath: inventory.mainPath, artifacts: inventory.artifacts });
    }
  }
  return groups;
}
