import { encodeCheckpoint } from './encode-checkpoint.js';
import { createHash, randomUUID } from 'node:crypto';
import type { QSORecord } from '@tx5dr/contracts';
import { normalizeQsoModeForStorage } from '@tx5dr/core';
import {
  convertQSOToADIF, createSyncFailure, normalizeCallsign, SyncStatusSchema,
  type PluginContextFor, type SyncStatus, type SyncUploadResult, type SyncDownloadResult,
} from '@tx5dr/plugin-api';
import { SyncBusyError, SyncOperationGate } from '../_shared/sync-operation-gate.js';
import { reconcileLogbookBatch, type LogbookBatchMutation } from '../_shared/logbook-sync-reconcile.js';
import { buildWavelogQslStatusUpdates, confirmationIdentity, qsoIdentity } from './qso-identity.js';
import { WavelogProtocol, WavelogError, protocolVersion, type WaveLogPluginConfig } from './protocol.js';

type Context = PluginContextFor<readonly ['network', 'logbook:read', 'logbook:write']>;
type Operation = SyncStatus['operation'];
const WEEK = 7 * 86400_000;
const MAX_CONFIRMATION_PAGES = 500;
const LEASE = 3000;
interface Session {
  status: SyncStatus;
  step: number;
  cursor: number;
  full: boolean;
  phase: 'prepare' | 'download' | 'upload' | 'recover' | 'confirm' | 'done';
  confirmationPage: number;
  confirmationSince: string;
  pending: string[];
  /** Full scan clears the inventory only after the first page is actually readable. */
  rebuildKnown?: boolean;
  uncertain?: { keys: string[]; rounds: number; message: string; retryable?: boolean };
  blockingFailure?: boolean;
  retryBatches?: Array<{ keys: string[]; rounds: number }>;
  details?: Array<{ code: string; message: string; qsoCallsign?: string }>;
}
interface Checkpoint {
  version: 1;
  target: string;
  cursor: number;
  /** Remote identity inventory and locally applied records advance independently. */
  appliedCursor?: number;
  initialized: boolean;
  known: string[];
  lastSuccessAt?: number;
  lastConfirmationAt?: number;
  lastFullAt?: number;
  lastInventoryAt?: number;
  session?: Session;
  autoStatus?: SyncStatus;
  autoUncertain?: string[];
  stationCheckedAt?: number;
  receipts?: Record<string, string>;
  pendingReceipts?: Record<string, string>;
  /** QSO ids the remote refused permanently, keyed by the identity that was refused. */
  rejected?: Record<string, { key: string; reason: string; at: number }>;
  launches?: Record<string, { operationId: string; operation: Operation; result?: SyncStatus; step?: number }>;
}
const MAX_REJECTIONS = 2000;

/** Bound the rejection ledger without letting an old entry displace a recent one. */
function pruneRejections(cp: Checkpoint): void {
  const entries = Object.entries(cp.rejected ?? {});
  if (entries.length <= MAX_REJECTIONS) return;
  entries.sort((left, right) => left[1].at - right[1].at);
  for (const [id] of entries.slice(0, entries.length - MAX_REJECTIONS)) delete cp.rejected![id];
}
interface Runtime {
  checkpoint: Checkpoint;
  known: Set<string>;
  /** In-memory identity→row-id map: avoids a full logbook scan per upload batch. */
  pendingIds?: Map<string, string>;
  leaseOwner?: string;
  leaseUntil: number;
  inFlight: boolean;
  pauseRequested: boolean;
  automatic: boolean;
}
function unfinished(session: Session): boolean { return session.phase !== 'done'; }
function emptyStatus(operation: Operation): SyncStatus {
  return { operationId: randomUUID(), revision: 0, operation, trigger: 'manual', state: 'idle', stage: 'preparing',
    startedAt: Date.now(), updatedAt: Date.now(), processed: 0, downloaded: 0, imported: 0, updated: 0,
    uploaded: 0, skipped: 0, failed: 0, conflicts: 0, rejected: 0, resumable: false, errors: [] };
}
function requiredConfig(config: WaveLogPluginConfig | null): WaveLogPluginConfig {
  if (!config?.url || !config.apiKey || !config.stationId) throw new WavelogError('Wavelog is not configured');
  return config;
}
function decodeCheckpoint(value: unknown, target: string): Checkpoint {
  if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint');
  const cp = value as Checkpoint;
  if (cp.version !== 1 || cp.target !== target || !Number.isSafeInteger(cp.cursor) || cp.cursor < 0
    || typeof cp.initialized !== 'boolean' || !Array.isArray(cp.known) || cp.known.some(key => typeof key !== 'string')) throw new Error('Invalid checkpoint');
  if (cp.appliedCursor !== undefined && (!Number.isSafeInteger(cp.appliedCursor) || cp.appliedCursor < 0)) throw new Error('Invalid applied cursor');
  cp.appliedCursor ??= cp.cursor;
  for (const field of ['lastSuccessAt', 'lastConfirmationAt', 'lastFullAt', 'lastInventoryAt', 'stationCheckedAt'] as const) {
    if (cp[field] !== undefined && !Number.isFinite(cp[field])) throw new Error('Invalid checkpoint date');
  }
  if (cp.autoUncertain && (!Array.isArray(cp.autoUncertain) || cp.autoUncertain.some(key => typeof key !== 'string'))) throw new Error('Invalid automatic checkpoint');
  for (const field of ['receipts', 'pendingReceipts'] as const) {
    const ledger = cp[field];
    if (ledger && (typeof ledger !== 'object' || Array.isArray(ledger) || Object.values(ledger).some(key => typeof key !== 'string'))) throw new Error('Invalid receipt ledger');
    cp[field] = Object.assign(Object.create(null), ledger ?? {});
  }
  {
    const ledger = cp.rejected;
    if (ledger && (typeof ledger !== 'object' || Array.isArray(ledger) || Object.values(ledger).some(entry =>
      !entry || typeof entry.key !== 'string' || typeof entry.reason !== 'string' || !Number.isFinite(entry.at)))) throw new Error('Invalid rejection ledger');
    cp.rejected = Object.assign(Object.create(null), ledger ?? {});
    pruneRejections(cp);
  }
  if (cp.autoStatus) {
    cp.autoStatus = SyncStatusSchema.parse(cp.autoStatus);
    if (cp.autoStatus.state === 'running') {
      cp.autoStatus.state = 'failed'; cp.autoStatus.failed = Math.max(cp.autoStatus.failed, cp.autoUncertain?.length ?? 1);
      cp.autoStatus.errors = [{ code: 'wavelog_auto_interrupted', message: 'Automatic upload was interrupted. Run sync to reconcile its result.' }];
    }
  }
  if (cp.launches) {
    if (typeof cp.launches !== 'object' || Array.isArray(cp.launches)) throw new Error('Invalid launch receipt');
    for (const launch of Object.values(cp.launches)) {
      if (!launch || typeof launch.operationId !== 'string' || !['upload', 'download', 'full_sync', 'reconcile'].includes(launch.operation)) throw new Error('Invalid launch receipt');
      if (launch.result) {
        launch.result = SyncStatusSchema.parse(launch.result);
        if (launch.result.operationId !== launch.operationId || launch.result.operation !== launch.operation || launch.result.resumable) throw new Error('Invalid launch result');
      }
      if (launch.step !== undefined && (!Number.isSafeInteger(launch.step) || launch.step < 0)) throw new Error('Invalid launch step');
    }
    cp.launches = Object.assign(Object.create(null), cp.launches);
  }
  if (cp.session) {
    const s = cp.session;
    s.status = SyncStatusSchema.parse(s.status);
    if (!['prepare', 'download', 'upload', 'recover', 'confirm', 'done'].includes(s.phase) || !Number.isSafeInteger(s.step) || s.step < 0
      || !Number.isSafeInteger(s.cursor) || s.cursor < 0 || typeof s.full !== 'boolean' || !Number.isSafeInteger(s.confirmationPage) || s.confirmationPage < 1
      || !/^\d{4}-\d{2}-\d{2}$/.test(s.confirmationSince) || !Array.isArray(s.pending) || s.pending.some(key => typeof key !== 'string')) throw new Error('Invalid session checkpoint');
    if (s.rebuildKnown !== undefined && typeof s.rebuildKnown !== 'boolean') throw new Error('Invalid inventory checkpoint');
    if (s.uncertain && (!Array.isArray(s.uncertain.keys) || s.uncertain.keys.some(key => typeof key !== 'string')
      || !Number.isSafeInteger(s.uncertain.rounds) || s.uncertain.rounds < 0 || typeof s.uncertain.message !== 'string'
      || s.uncertain.retryable !== undefined && typeof s.uncertain.retryable !== 'boolean')) throw new Error('Invalid request checkpoint');
    if (s.retryBatches && (!Array.isArray(s.retryBatches) || s.retryBatches.some(batch => !Array.isArray(batch.keys) || batch.keys.some(key => typeof key !== 'string')
      || !Number.isSafeInteger(batch.rounds) || batch.rounds < 0 || batch.rounds > 2))) throw new Error('Invalid retry checkpoint');
    if (s.details && (!Array.isArray(s.details) || s.details.some(detail => typeof detail.code !== 'string' || typeof detail.message !== 'string'
      || detail.qsoCallsign !== undefined && typeof detail.qsoCallsign !== 'string'))) throw new Error('Invalid sync details');
    if (s.phase !== 'done') { s.status.state = 'interrupted'; s.status.resumable = true; }
  }
  return cp;
}

/** Plugin-owned resumable synchronizer. Each page advance stays in its caller's invocation. */
export class WavelogSyncService {
  private readonly instanceId = randomUUID();
  private runtimes = new Map<string, Runtime>();
  private gate = new SyncOperationGate();
  constructor(private ctx: Context, private readConfig: (callsign: string) => WaveLogPluginConfig | null) {}

  isActive(callsign: string): boolean {
    const key = normalizeCallsign(callsign);
    if (this.gate.isBusy(key)) return true;
    const runtime = this.runtimes.get(key);
    return !!runtime && (runtime.inFlight || runtime.automatic || (runtime.checkpoint.session?.phase !== 'done' && runtime.leaseUntil > Date.now()));
  }
  private serial<T>(callsign: string, action: () => Promise<T>): Promise<T> {
    return this.gate.run(callsign, action, true);
  }
  /** An unfinished session owns pending receipts that a config change would orphan. */
  hasUnfinishedSession(callsign: string): boolean {
    const runtime = this.runtimes.get(normalizeCallsign(callsign));
    return !!runtime?.checkpoint.session && runtime.checkpoint.session.phase !== 'done';
  }
  private async target(callsign: string, config: WaveLogPluginConfig): Promise<string> {
    const logbookId = await this.ctx.logbook.forCallsign(callsign).getLogBookId();
    if (!logbookId) throw new WavelogError('Local logbook is unavailable');
    return JSON.stringify([new URL(config.url).toString().replace(/\/+$/, ''), config.stationId, protocolVersion(config), normalizeCallsign(callsign), logbookId]);
  }
  private path(target: string): string { return `sync/${createHash('sha256').update(target).digest('hex')}.json`; }
  private async runtime(callsign: string, config: WaveLogPluginConfig, rebuild = false): Promise<Runtime> {
    const key = normalizeCallsign(callsign); const target = await this.target(callsign, config);
    const cached = this.runtimes.get(key);
    if (!rebuild && cached?.checkpoint.target === target) return cached;
    let checkpoint: Checkpoint = { version: 1, target, cursor: 0, appliedCursor: 0, initialized: false, known: [], receipts: Object.create(null), pendingReceipts: Object.create(null) };
    if (!rebuild) {
      const bytes = await this.ctx.files.read(this.path(target));
      if (bytes) {
        try { checkpoint = decodeCheckpoint(JSON.parse(bytes.toString('utf8')), target); }
        catch { throw new WavelogError('Sync checkpoint is invalid. Open Reconcile to rebuild it.'); }
      }
    }
    const concurrent = this.runtimes.get(key);
    if (!rebuild && concurrent?.checkpoint.target === target) return concurrent;
    const runtime: Runtime = { checkpoint, known: new Set(checkpoint.known), leaseUntil: 0, inFlight: false, pauseRequested: false, automatic: false };
    this.runtimes.set(key, runtime);
    return runtime;
  }
  private async save(runtime: Runtime): Promise<void> {
    const cp = runtime.checkpoint;
    const snapshot = { ...cp,
      session: cp.session ? { ...cp.session, status: structuredClone(cp.session.status) } : undefined,
      autoStatus: cp.autoStatus ? structuredClone(cp.autoStatus) : undefined,
    };
    try {
      const bytes = runtime.automatic ? await encodeCheckpoint(snapshot, runtime.known)
        : Buffer.from(JSON.stringify({ ...snapshot, known: [...runtime.known] }));
      await this.ctx.files.write(this.path(cp.target), bytes);
    }
    catch (error) {
      // Never continue from an uncommitted in-memory cursor or POST receipt.
      for (const [key, current] of this.runtimes) if (current === runtime) this.runtimes.delete(key);
      throw error;
    }
  }
  private protocol(config: WaveLogPluginConfig): WavelogProtocol {
    if (!this.ctx.fetch) throw new WavelogError('Network permission is unavailable');
    return new WavelogProtocol(this.ctx.fetch, config);
  }
  private bump(status: SyncStatus): void { status.revision++; status.updatedAt = Date.now(); }
  private acknowledged(runtime: Runtime, record: QSORecord, callsign: string): boolean {
    const key = qsoIdentity(record, callsign);
    const rejection = runtime.checkpoint.rejected?.[record.id];
    // A remote refusal is terminal for that exact identity; editing the QSO reopens it.
    if (rejection && rejection.key === key) return true;
    const original = runtime.checkpoint.receipts?.[record.id];
    // Identity edits are local-only. An unchanged record can repair a missing remote copy.
    return original ? original !== key || runtime.known.has(original) : runtime.known.has(key);
  }
  private settleReceipts(runtime: Runtime): void {
    const cp = runtime.checkpoint;
    cp.receipts ??= Object.create(null); cp.pendingReceipts ??= Object.create(null);
    for (const [id, key] of Object.entries(cp.pendingReceipts!)) {
      if (runtime.known.has(key)) { cp.receipts![id] ??= key; delete cp.pendingReceipts![id]; }
    }
  }
  private index(callsign: string, records: readonly QSORecord[], runtime: Runtime) {
    const byId = new Map(records.map(record => [record.id, record]));
    const byKey = new Map(records.map(record => [qsoIdentity(record, callsign), record.id]));
    for (const [id, key] of Object.entries({ ...runtime.checkpoint.pendingReceipts, ...runtime.checkpoint.receipts })) {
      if (byId.has(id)) byKey.set(key, id);
    }
    return { byId, byKey };
  }
  private error(status: SyncStatus, error: unknown, config: WaveLogPluginConfig, callsign?: string): { code: string; message: string; qsoCallsign?: string } {
    const failure = createSyncFailure({ code: 'wavelog_sync_failed', message: error instanceof Error ? error.message : 'Sync failed', secrets: [config.apiKey], qsoCallsign: callsign });
    status.failed++;
    const detail = { code: failure.code, message: failure.message.slice(0, 1000), ...(callsign ? { qsoCallsign: callsign } : {}) };
    if (status.errors.length < 20) status.errors.push(detail);
    return detail;
  }
  async getDetails(callsign: string, offset: number, operationId: string): Promise<{ errors: Array<{ code: string; message: string; qsoCallsign?: string }>; total: number }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new WavelogError('Invalid details offset');
    const runtime = await this.runtime(callsign, requiredConfig(this.readConfig(callsign)));
    const cp = runtime.checkpoint;
    const details = cp.session?.status.operationId === operationId ? cp.session.details ?? cp.session.status.errors
      : cp.autoStatus?.operationId === operationId ? cp.autoStatus.errors : undefined;
    if (!details) throw new WavelogError('Unknown sync operation details');
    return { errors: structuredClone(details.slice(offset, offset + 50)), total: details.length };
  }
  async getAutomaticStatus(callsign: string): Promise<SyncStatus | null> {
    const config = this.readConfig(callsign);
    if (!config?.url || !config.apiKey || !config.stationId) return null;
    const status = (await this.runtime(callsign, config)).checkpoint.autoStatus;
    return status ? SyncStatusSchema.parse({ ...structuredClone(status), instanceId: this.instanceId }) : null;
  }
  async getStatus(callsign: string): Promise<SyncStatus | null> {
    const config = this.readConfig(callsign);
    if (!config?.stationId || !config.url || !config.apiKey) return null;
    const runtime = await this.runtime(callsign, config);
    const cp = runtime.checkpoint; const session = cp.session;
    const manual = session && unfinished(session);
    const original = session?.status ?? cp.autoStatus;
    const status = structuredClone(original ?? emptyStatus('full_sync'));
    // Stable idle identity avoids creating a new operation every time the UI polls.
    if (!original) status.operationId = createHash('sha256').update(cp.target).digest('hex');
    if (manual && !runtime.inFlight && runtime.leaseUntil <= Date.now() && ['running', 'waiting', 'pausing'].includes(status.state)) {
      status.state = 'paused'; status.resumable = true;
    }
    if (manual && runtime.inFlight && runtime.leaseUntil <= Date.now() && status.state === 'running') status.state = 'pausing';
    status.autoUploading = runtime.automatic;
    status.instanceId = this.instanceId;
    if (cp.autoStatus) {
      const automatic = cp.autoStatus;
      status.automaticUpload = { state: automatic.state as 'running' | 'completed' | 'partial_failure' | 'failed',
        uploaded: automatic.uploaded, skipped: automatic.skipped, failed: automatic.failed, updatedAt: automatic.updatedAt };
    }
    status.resumable = !!manual;
    status.lastSuccessAt = cp.lastSuccessAt;
    status.lastConfirmationAt = cp.lastConfirmationAt;
    return SyncStatusSchema.parse(status);
  }
  private clearBlockingFailure(session: Session): void {
    if (!session.blockingFailure) return;
    session.status.failed = Math.max(session.status.conflicts, session.status.failed - 1);
    // The summary may be full; only remove the blocking detail if it was included.
    const detail = session.details?.pop();
    if (detail && session.status.errors.at(-1)?.message === detail.message) session.status.errors.pop();
    delete session.blockingFailure;
  }
  private response(runtime: Runtime): { status: SyncStatus; step: number } {
    const session = runtime.checkpoint.session!;
    return { status: { ...structuredClone(session.status), instanceId: this.instanceId }, step: session.step };
  }
  async begin(callsign: string, operation: Operation, owner: string, launchId?: string): Promise<{ status: SyncStatus; step: number }> {
    return this.gate.run(callsign, async () => {
      const config = requiredConfig(this.readConfig(callsign));
      let runtime: Runtime;
      try { runtime = await this.runtime(callsign, config); }
      catch (error) { if (operation !== 'reconcile') throw error; runtime = await this.runtime(callsign, config, true); }
      if (launchId !== undefined && (!launchId || launchId.length > 200)) throw new WavelogError('Invalid launch ID');
      const previousLaunch = launchId ? runtime.checkpoint.launches?.[launchId] : undefined;
      if (previousLaunch) {
        if (previousLaunch.operation !== operation) throw new WavelogError('Launch ID belongs to another operation');
        if (runtime.checkpoint.session?.status.operationId !== previousLaunch.operationId) {
          if (previousLaunch.result && previousLaunch.step !== undefined) return { status: { ...structuredClone(previousLaunch.result), instanceId: this.instanceId }, step: previousLaunch.step };
          throw new WavelogError('This launch has already completed; inspect the latest result');
        }
        if (runtime.checkpoint.session && unfinished(runtime.checkpoint.session)) {
          if (runtime.leaseUntil > Date.now() && runtime.leaseOwner !== owner) throw new SyncBusyError('Another page is driving this sync');
          runtime.leaseOwner = owner; runtime.leaseUntil = Date.now() + LEASE; runtime.pauseRequested = false;
          this.clearBlockingFailure(runtime.checkpoint.session);
          runtime.checkpoint.session.status.state = 'running'; this.bump(runtime.checkpoint.session.status);
          await this.save(runtime);
        }
        return this.response(runtime);
      }
      if (runtime.leaseUntil > Date.now() && runtime.leaseOwner !== owner) throw new SyncBusyError('Another page is driving this sync');
      if (runtime.checkpoint.session?.phase !== 'done' && runtime.checkpoint.session) {
        if (runtime.checkpoint.session.status.operation !== operation) throw new WavelogError('A different sync operation is paused. Continue that operation first.');
        runtime.leaseOwner = owner; runtime.leaseUntil = Date.now() + LEASE; runtime.pauseRequested = false;
        const session = runtime.checkpoint.session;
        if (launchId) {
          session.status.launchId = launchId; session.status.trigger = 'manual';
          runtime.checkpoint.launches ??= Object.create(null);
          runtime.checkpoint.launches![launchId] = { operationId: session.status.operationId, operation };
        }
        this.clearBlockingFailure(session);
        session.status.state = 'running'; this.bump(session.status);
        await this.save(runtime); return this.response(runtime);
      }
      const cp = runtime.checkpoint;
      if (cp.session?.phase === 'done') {
        for (const launch of Object.values(cp.launches ?? {})) {
          if (launch.operationId === cp.session.status.operationId) { launch.result = structuredClone(cp.session.status); launch.step = cp.session.step; }
        }
      }
      const lastScan = operation === 'upload' ? cp.lastInventoryAt : cp.lastFullAt;
      const full = !cp.initialized || operation === 'reconcile' || !lastScan || Date.now() - lastScan >= WEEK;
      // Keep the persisted inventory until a page proves the remote is readable again.
      if (full) cp.initialized = false;
      // An explicit reconcile re-verifies every record, including previously rejected ones.
      if (operation === 'reconcile') cp.rejected = Object.create(null);
      const status = emptyStatus(operation); status.state = 'running';
      if (launchId) { status.launchId = launchId; cp.launches ??= Object.create(null); cp.launches![launchId] = { operationId: status.operationId, operation }; } status.resumable = true;
      cp.session = { status, step: 0, cursor: full ? 0 : operation === 'upload' ? cp.cursor : cp.appliedCursor ?? 0, full, rebuildKnown: full, phase: 'prepare', confirmationPage: 1,
        confirmationSince: new Date((cp.lastConfirmationAt ?? 0) - (cp.lastConfirmationAt ? 2 * 86400_000 : 0)).toISOString().slice(0, 10), pending: [] };
      runtime.pendingIds = undefined;
      runtime.leaseOwner = owner; runtime.leaseUntil = Date.now() + LEASE; runtime.pauseRequested = false;
      await this.save(runtime); return this.response(runtime);
    });
  }
  async renew(callsign: string, operationId: string, owner: string): Promise<void> {
    const runtime = await this.runtime(callsign, requiredConfig(this.readConfig(callsign)));
    if (runtime.checkpoint.session?.status.operationId !== operationId || runtime.leaseOwner !== owner) throw new WavelogError('Sync execution lease is not owned by this page');
    if (!runtime.pauseRequested) runtime.leaseUntil = Date.now() + LEASE;
  }
  async pause(callsign: string, operationId: string, owner: string): Promise<void> {
    const runtime = await this.runtime(callsign, requiredConfig(this.readConfig(callsign)));
    if (runtime.checkpoint.session?.status.operationId !== operationId || runtime.leaseOwner !== owner) throw new WavelogError('Sync execution lease is not owned by this page');
    if (runtime.checkpoint.session.phase === 'done') return;
    runtime.pauseRequested = true; runtime.leaseUntil = 0;
    const status = runtime.checkpoint.session.status;
    status.state = runtime.inFlight ? 'pausing' : 'paused'; this.bump(status);
    // The active step saves the authoritative checkpoint once its commit settles.
    if (!runtime.inFlight && !runtime.automatic) await this.save(runtime);
  }
  async advance(callsign: string, operationId: string, step: number, owner: string): Promise<{ status: SyncStatus; step: number }> {
    return this.serial(callsign, async () => {
      const config = requiredConfig(this.readConfig(callsign)); const runtime = await this.runtime(callsign, config);
      const session = runtime.checkpoint.session;
      if (!session || session.status.operationId !== operationId) throw new WavelogError('Unknown sync operation');
      if (step < session.step) return this.response(runtime);
      if (step !== session.step || runtime.leaseOwner !== owner || runtime.leaseUntil <= Date.now() || runtime.pauseRequested) throw new WavelogError('Sync step or execution lease is invalid');
      if (session.phase === 'done') return this.response(runtime);
      if (session.status.nextAttemptAt && session.status.nextAttemptAt > Date.now()) return this.response(runtime);
      runtime.inFlight = true; session.status.state = 'running'; delete session.status.nextAttemptAt;
      try {
        await this.executeStep(callsign, runtime, config);
        session.step++;
        if (session.phase === 'confirm') delete session.status.total;
        if (unfinished(session)) {
          session.status.state = 'waiting';
          session.status.stage = session.phase === 'prepare' ? 'preparing' : session.phase === 'upload' ? 'uploading'
            : session.phase === 'recover' ? 'reconciling' : session.phase === 'confirm' ? 'confirming' : 'downloading';
        }
      } catch (error) {
        const knownError = error instanceof WavelogError ? error : undefined;
        if (knownError?.nextAttemptAt) {
          session.status.state = 'waiting'; session.status.nextAttemptAt = knownError.nextAttemptAt;
        } else {
          session.details ??= [];
          session.details.push(this.error(session.status, error, config));
          session.blockingFailure = true;
          session.status.state = session.status.imported || session.status.uploaded ? 'partial_failure' : 'failed';
          session.status.resumable = true;
          runtime.leaseUntil = 0;
        }
      } finally {
        runtime.inFlight = false;
        if (unfinished(session) && (runtime.pauseRequested || runtime.leaseUntil <= Date.now()) && ['running', 'waiting', 'pausing'].includes(session.status.state)) session.status.state = 'paused';
        this.bump(session.status);
        await this.save(runtime);
      }
      return this.response(runtime);
    });
  }
  private async merge(callsign: string, records: readonly QSORecord[], runtime: Runtime): Promise<{ imported: number; updated: number }> {
    const logbook = this.ctx.logbook.forCallsign(callsign);
    const result = await reconcileLogbookBatch(logbook, snapshot => {
      const index = this.index(callsign, snapshot.records, runtime);
      const receipts: Record<string, string> = Object.create(null);
      const additionKeys = new Map<number, string>();
      const mutations: LogbookBatchMutation[] = [];
      for (const remote of records) {
        const key = qsoIdentity(remote, callsign);
        const local = index.byId.get(index.byKey.get(key) ?? '');
        if (!local) { additionKeys.set(mutations.length, key); mutations.push({ type: 'add', record: remote }); index.byKey.set(key, remote.id); index.byId.set(remote.id, remote); }
        else {
          receipts[local.id] = key;
          const updates = buildWavelogQslStatusUpdates(local, remote);
          if (updates) { mutations.push({ type: 'update', qsoId: local.id, updates }); index.byId.set(local.id, { ...local, ...updates }); }
        }
      }
      return { mutations, value: { receipts, additionKeys } };
    });
    const cp = runtime.checkpoint; cp.receipts ??= Object.create(null);
    for (const [id, key] of Object.entries(result.value.receipts)) cp.receipts![id] ??= key;
    for (const outcome of result.batch.outcomes) {
      const key = result.value.additionKeys.get(outcome.inputIndex);
      if (key) cp.receipts![outcome.record.id] ??= key;
    }
    const imported = result.batch.outcomes.filter(outcome => outcome.status === 'added').length;
    const updated = result.batch.outcomes.filter(outcome => outcome.status === 'updated').length;
    if (imported || updated) {
      try { await logbook.notifyUpdated(); }
      catch (error) { this.ctx.log.warn('Logbook sync notification failed after durable commit', { error: error instanceof Error ? error.message : 'Unknown error' }); }
    }
    return { imported, updated };
  }
  private async executeStep(callsign: string, runtime: Runtime, config: WaveLogPluginConfig): Promise<void> {
    const cp = runtime.checkpoint; const session = cp.session!; const status = session.status; const api = this.protocol(config);
    if (session.phase === 'prepare') {
      status.stage = 'preparing';
      const scopes = ['station:read', 'qso:read', ...(status.operation !== 'download' ? ['qso:write'] : []),
        ...(protocolVersion(config) === 'v2' && status.operation !== 'upload' ? ['confirmation:read'] : [])];
      const stations = await api.stations(scopes);
      const station = stations.find(item => item.station_id === config.stationId);
      if (!station || normalizeCallsign(station.station_callsign) !== normalizeCallsign(callsign)) throw new WavelogError('Station profile callsign does not match the local logbook');
      cp.stationCheckedAt = Date.now(); session.phase = 'download'; return;
    }
    if (session.phase === 'download' || session.phase === 'recover') {
      const recovery = session.phase === 'recover'; status.stage = recovery ? 'reconciling' : 'downloading';
      const page = await api.download(session.cursor);
      // Only a readable page proves the inventory can be rebuilt; a failed run keeps it.
      if (session.rebuildKnown) { runtime.known.clear(); delete session.rebuildKnown; }
      if (!recovery && status.downloaded === 0 && page.total !== undefined) status.total = page.total;
      status.stage = 'committing';
      const merged = status.operation === 'upload' ? { imported: 0, updated: 0 } : await this.merge(callsign, page.records, runtime);
      for (const record of page.records) runtime.known.add(qsoIdentity(record, callsign));
      this.settleReceipts(runtime);
      status.downloaded += page.records.length; status.imported += merged.imported; status.updated += merged.updated;
      if (!recovery) status.processed += page.records.length;
      // Invalid remote records were skipped by the wire adapter; surface them once,
      // bounded, instead of failing the page and pinning the cursor.
      for (const skipped of page.invalid) {
        status.failed++;
        const detail = {
          code: 'wavelog_remote_record_invalid',
          message: `Remote record skipped: ${skipped.reason}`.slice(0, 1000),
          ...(skipped.qsoCallsign ? { qsoCallsign: skipped.qsoCallsign } : {}),
        };
        if (status.errors.length < 20) status.errors.push(detail);
        session.details ??= [];
        if (session.details.length < 200) session.details.push(detail);
      }
      if (!recovery) status.processed += page.invalid.length;
      session.cursor = page.cursor; cp.cursor = Math.max(cp.cursor, page.cursor);
      if (status.operation !== 'upload') cp.appliedCursor = Math.max(cp.appliedCursor ?? 0, page.cursor);
      if (page.records.length || page.invalid.length) return;
      if (recovery) {
        const uncertain = session.uncertain!;
        const resolved = uncertain.keys.filter(key => runtime.known.has(key));
        status.uploaded += resolved.length; status.processed += resolved.length;
        session.pending = session.pending.filter(key => !runtime.known.has(key));
        const missing = uncertain.keys.filter(key => !runtime.known.has(key));
        if (missing.length && uncertain.rounds >= 2 && uncertain.retryable) {
          // The outcome was never confirmed by the remote. Keep the records pending and
          // end this run as a retryable failure instead of blacklisting them.
          delete session.uncertain;
          session.phase = 'upload';
          throw new WavelogError('Wavelog did not confirm the last batch; it stays pending and will be retried');
        }
        if (missing.length && uncertain.rounds >= 2) {
          // The remote answered and refused these identities twice: retrying cannot change the outcome.
          const reason = (uncertain.message || 'Remote records could not be confirmed. Different QSOs in the same minute may conflict.').slice(0, 1000);
          const rejected = (cp.rejected ??= Object.create(null));
          const pendingByKey = new Map<string, string>();
          for (const [id, key] of Object.entries(cp.pendingReceipts ?? {})) pendingByKey.set(key, id);
          session.details ??= [];
          const at = Date.now();
          for (const key of missing) {
            const identity = JSON.parse(key) as unknown[];
            const id = pendingByKey.get(key);
            if (id) {
              rejected[id] = { key, reason, at };
              // A stale receipt would otherwise keep an edited record from ever being retried.
              delete cp.pendingReceipts![id]; delete cp.receipts![id];
            }
            if (session.details.length < 200) session.details.push({ code: 'wavelog_upload_rejected', message: reason, qsoCallsign: String(identity[1]) });
          }
          pruneRejections(cp);
          if (Object.keys(cp.rejected!).length >= MAX_REJECTIONS) {
            this.ctx.log.warn('Rejected-record ledger is full; the oldest entries will be retried', { size: MAX_REJECTIONS, callsign });
          }
          status.rejected += missing.length; status.processed += missing.length;
          this.ctx.log.info('Remote refused records permanently; they will not be retried until edited', { count: missing.length, callsign });
          session.pending = session.pending.filter(key => !missing.includes(key));
          delete session.uncertain;
        } else if (missing.length) {
          const middle = Math.ceil(missing.length / 2);
          session.retryBatches ??= [];
          session.retryBatches.unshift(...[missing.slice(0, middle), missing.slice(middle)].filter(keys => keys.length).map(keys => ({ keys, rounds: uncertain.rounds + 1 })));
          delete session.uncertain;
        }
        else delete session.uncertain;
        session.phase = 'upload'; return;
      }
      cp.initialized = true;
      if (session.full) {
        cp.cursor = session.cursor; cp.lastInventoryAt = Date.now();
        if (status.operation !== 'upload') { cp.appliedCursor = session.cursor; cp.lastFullAt = Date.now(); cp.lastConfirmationAt = Date.now(); }
      }
      cp.autoUncertain = cp.autoUncertain?.filter(key => !runtime.known.has(key));
      if (status.operation === 'download') { session.phase = 'confirm'; return; }
      const local = await this.ctx.logbook.forCallsign(callsign).queryQSOs({});
      cp.receipts ??= Object.create(null);
      for (const record of local) { const key = qsoIdentity(record, callsign); if (runtime.known.has(key)) cp.receipts![record.id] ??= key; }
      if (cp.rejected) {
        const present = new Set(local.map(record => record.id));
        for (const id of Object.keys(cp.rejected)) if (!present.has(id)) delete cp.rejected[id];
      }
      const pendingRecords = local.filter(record => !this.acknowledged(runtime, record, callsign));
      session.pending = [...new Set(pendingRecords.map(record => qsoIdentity(record, callsign)))];
      // Remember which local row owns each pending identity so each batch can fetch
      // only its own records instead of cloning the whole logbook per batch.
      runtime.pendingIds = new Map(pendingRecords.map(record => [qsoIdentity(record, callsign), record.id]));
      status.skipped = local.length - session.pending.length; status.total = session.pending.length; status.processed = 0;
      session.phase = 'upload'; return;
    }
    if (session.phase === 'upload') {
      status.stage = 'uploading';
      if (!session.pending.length) { session.phase = 'confirm'; return; }
      const retry = session.retryBatches?.shift();
      const candidates = (retry?.keys ?? session.pending).slice(0, 100);
      const candidateIds = runtime.pendingIds ? candidates.map(key => runtime.pendingIds!.get(key)).filter((id): id is string => !!id) : [];
      // Fetch only the rows this batch can send; fall back to a full query for a
      // checkpoint written before id mapping existed.
      const local = candidateIds.length === candidates.length
        ? await this.ctx.logbook.forCallsign(callsign).queryQSOs({ ids: candidateIds })
        : await this.ctx.logbook.forCallsign(callsign).queryQSOs({});
      const records = new Map(local.map(record => [qsoIdentity(record, callsign), record]));
      const batch: QSORecord[] = []; const keys: string[] = []; const parts: string[] = [];
      let payloadBytes = Buffer.byteLength(JSON.stringify(api.payload('')));
      for (const key of candidates) {
        const record = records.get(key);
        if (!record || runtime.known.has(key)) { session.pending = session.pending.filter(item => item !== key); status.skipped++; status.processed++; continue; }
        const adif = convertQSOToADIF(record);
        const addedBytes = Buffer.byteLength(JSON.stringify(adif)) - 2 + (parts.length ? 2 : 0);
        if (payloadBytes + addedBytes > 512 * 1024) {
          if (batch.length) break;
          session.details ??= [];
          session.details.push(this.error(status, new Error('QSO exceeds the upload payload limit'), config, record.callsign));
          session.pending = session.pending.filter(item => item !== key); status.processed++; continue;
        }
        batch.push(record); keys.push(key); parts.push(adif);
        payloadBytes += addedBytes;
      }
      if (!batch.length) return;
      const rounds = retry?.rounds ?? 0;
      session.uncertain = { keys, rounds, message: 'Upload result is uncertain' };
      cp.pendingReceipts ??= Object.create(null);
      batch.forEach((record, index) => { cp.pendingReceipts![record.id] = keys[index]!; });
      session.phase = 'recover'; session.cursor = cp.cursor;
      await this.save(runtime); // Record POST intent before network I/O.
      try {
        const result = await api.upload(parts.join('\n'), batch.length);
        if (result.complete && result.skipped === 0) {
          keys.forEach(key => runtime.known.add(key));
          this.settleReceipts(runtime);
          status.uploaded += result.imported; status.processed += keys.length;
          session.pending = session.pending.filter(key => !keys.includes(key));
          delete session.uncertain; session.phase = 'upload';
        } else session.uncertain.message = result.message || 'Remote batch needs identity reconciliation';
      } catch (error) {
        if (error instanceof WavelogError && [401, 403, 404, 429].includes(error.httpStatus ?? 0)) {
          session.phase = 'upload'; delete session.uncertain; throw error;
        }
        if (session.uncertain) {
          session.uncertain.message = error instanceof Error ? error.message : 'Upload result is uncertain';
          // A 2xx status with an unreadable body is not a refusal: the remote may have
          // imported the batch already. Keep those records pending instead of blacklisting
          // them, exactly like transport loss, timeouts and 5xx.
          const status = error instanceof WavelogError ? error.httpStatus : undefined;
          session.uncertain.retryable = status === undefined || status < 400 || status === 408 || status >= 500;
        }
      }
      return;
    }
    status.stage = 'confirming';
    if (protocolVersion(config) === 'v2' && !session.full && status.operation !== 'upload') {
      const page = await api.confirmations(session.confirmationSince, session.confirmationPage);
      const local = await this.ctx.logbook.forCallsign(callsign).queryQSOs({});
      const index = this.index(callsign, local, runtime);
      // Fallback identity without band: remote band strings outside the local band
      // table (4m/23cm/...) must still find their contact when it is unambiguous.
      const byBandless = new Map<string, string | null>();
      for (const record of local) {
        const key = confirmationIdentity(record, callsign, '');
        const existing = byBandless.get(key);
        byBandless.set(key, existing === undefined ? record.id : null);
      }
      const updates: QSORecord[] = [];
      for (const confirmation of page.records) {
        const mode = normalizeQsoModeForStorage({ mode: confirmation.mode, submode: confirmation.submode });
        const key = confirmationIdentity({ callsign: confirmation.callsign, startTime: confirmation.time, ...mode }, callsign, confirmation.band);
        const bandless = confirmationIdentity({ callsign: confirmation.callsign, startTime: confirmation.time, ...mode }, callsign, '');
        const match = index.byId.get(index.byKey.get(key) ?? '')
          ?? index.byId.get(byBandless.get(bandless) ?? '');
        if (match) updates.push({ ...match, ...(confirmation.type === 'lotw'
          ? { lotwQslReceived: 'Y' as const, lotwQslReceivedDate: confirmation.date }
          : { qrzQslReceived: 'Y' as const, qrzQslReceivedDate: confirmation.date }) });
      }
      for (const skipped of page.invalid) {
        status.failed++;
        const detail = { code: 'wavelog_remote_confirmation_invalid', message: `Remote confirmation skipped: ${skipped.reason}`.slice(0, 1000) };
        if (status.errors.length < 20) status.errors.push(detail);
        session.details ??= [];
        if (session.details.length < 200) session.details.push(detail);
      }
      const merged = await this.merge(callsign, updates, runtime); status.updated += merged.updated; status.processed += page.records.length;
      if (page.more && session.confirmationPage < MAX_CONFIRMATION_PAGES) { session.confirmationPage++; return; }
      if (page.more) {
        // A remote that never stops paging must fail visibly instead of looping forever.
        status.failed++;
        const detail = { code: 'wavelog_confirmation_page_limit', message: 'Remote confirmation paging did not finish within the page limit' };
        if (status.errors.length < 20) status.errors.push(detail);
        session.details ??= [];
        if (session.details.length < 200) session.details.push(detail);
      }
      cp.lastConfirmationAt = Date.now();
    }
    session.phase = 'done'; status.stage = 'finished'; status.state = status.failed ? 'partial_failure' : 'completed'; status.resumable = false;
    runtime.leaseUntil = 0;
    if (!status.failed) cp.lastSuccessAt = Date.now();
  }
  async automaticUpload(callsign: string, records: readonly QSORecord[]): Promise<SyncUploadResult> {
    return this.serial(callsign, async () => {
      const config = requiredConfig(this.readConfig(callsign)); const runtime = await this.runtime(callsign, config); const cp = runtime.checkpoint;
      if (!cp.stationCheckedAt || Date.now() - cp.stationCheckedAt >= WEEK) {
        const stations = await this.protocol(config).stations(['station:read', 'qso:write']);
        const station = stations.find(item => item.station_id === config.stationId);
        if (!station || normalizeCallsign(station.station_callsign) !== normalizeCallsign(callsign)) throw new WavelogError('Station profile callsign does not match the local logbook');
        cp.stationCheckedAt = Date.now();
      }
      runtime.automatic = true;
      const status = emptyStatus('upload'); status.trigger = 'auto'; status.state = 'running'; status.stage = 'uploading'; cp.autoStatus = status;
      // A manual session that lost its response owns these identities until it reconciles.
      const manualPending = new Set<string>(cp.session?.uncertain?.keys ?? []);
      try {
        for (let offset = 0; offset < records.length; offset += 100) {
          cp.receipts ??= Object.create(null);
          for (const record of records.slice(offset, offset + 100)) {
            const key = qsoIdentity(record, callsign);
            if (runtime.known.has(key)) cp.receipts![record.id] ??= key;
          }
          let batch = records.slice(offset, offset + 100).filter(record => !this.acknowledged(runtime, record, callsign)
            && !manualPending.has(qsoIdentity(record, callsign)));
          status.skipped += Math.min(100, records.length - offset) - batch.length;
          if (!batch.length) continue;
          const unresolved = batch.filter(record => cp.autoUncertain?.includes(qsoIdentity(record, callsign)));
          if (unresolved.length) {
            status.failed += unresolved.length - 1; this.error(status, new Error('Previous upload is uncertain; run sync to reconcile it'), config);
            batch = batch.filter(record => !cp.autoUncertain?.includes(qsoIdentity(record, callsign)));
          }
          if (!batch.length) continue;
          const keys = batch.map(record => qsoIdentity(record, callsign));
          cp.autoUncertain = [...new Set([...(cp.autoUncertain ?? []), ...keys])];
          cp.pendingReceipts ??= Object.create(null);
          batch.forEach((record, index) => { cp.pendingReceipts![record.id] = keys[index]!; });
          await this.save(runtime);
          try {
            const api = this.protocol(config); const adif = batch.map(record => convertQSOToADIF(record)).join('\n');
            if (Buffer.byteLength(JSON.stringify(api.payload(adif))) > 512 * 1024) throw new WavelogError('Automatic upload batch exceeds the payload limit');
            const result = await api.upload(adif, batch.length);
            if (!result.complete || result.skipped) throw new WavelogError('Automatic upload needs identity reconciliation; run sync');
            keys.forEach(key => runtime.known.add(key)); status.uploaded += result.imported;
            this.settleReceipts(runtime);
            cp.autoUncertain = cp.autoUncertain.filter(key => !keys.includes(key));
            // The final result below commits the final accepted batch and terminal status together.
            if (offset + 100 < records.length) await this.save(runtime);
          } catch (error) {
            status.failed += batch.length - 1; this.error(status, error, config);
            status.failed += records.slice(offset + 100).filter(record => !runtime.known.has(qsoIdentity(record, callsign))).length;
            break;
          }
        }
        status.state = status.failed ? (status.uploaded ? 'partial_failure' : 'failed') : 'completed'; status.stage = 'finished';
        if (!status.failed) cp.lastSuccessAt = Date.now();
        this.bump(status); await this.save(runtime);
        return { uploaded: status.uploaded, skipped: status.skipped, failed: status.failed,
          failures: status.errors.length ? status.errors.map(error => createSyncFailure({ ...error, providerId: 'wavelog', operation: 'upload' })) : undefined };
      } finally { runtime.automatic = false; }
    });
  }
  /** Legacy Host routes use the same steps without owning the orchestration. */
  async run(callsign: string, operation: 'upload' | 'download'): Promise<SyncStatus> {
    const owner = `provider:${randomUUID()}`;
    let current = await this.begin(callsign, operation, owner);
    const runtime = await this.runtime(callsign, requiredConfig(this.readConfig(callsign)));
    // An awaited Provider call has no page heartbeat; its invocation owns the lease.
    runtime.leaseUntil = Number.POSITIVE_INFINITY;
    try {
      while (current.status.resumable && !['failed', 'partial_failure'].includes(current.status.state)
        && !(current.status.nextAttemptAt && current.status.nextAttemptAt > Date.now())) {
        current = await this.advance(callsign, current.status.operationId, current.step, owner);
      }
    } finally {
      if (runtime.leaseOwner === owner) runtime.leaseUntil = 0;
    }
    return current.status;
  }
  downloadResult(status: SyncStatus): SyncDownloadResult {
    return { downloaded: status.downloaded, imported: status.imported, matched: Math.max(0, status.downloaded - status.imported), updated: status.updated,
      failures: status.errors.length ? status.errors.map(error => createSyncFailure({ ...error, providerId: 'wavelog', operation: 'download' }))
        : status.resumable ? [createSyncFailure({ code: 'wavelog_sync_paused', message: 'Sync is waiting. Open the plugin page to continue.', providerId: 'wavelog', retryable: true })] : undefined };
  }
}
