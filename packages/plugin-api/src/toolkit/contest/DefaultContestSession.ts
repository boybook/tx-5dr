import type { PluginPermission, QSORecord } from '@tx5dr/contracts';
import type {
  LogbookBatchMutation,
  LogbookBatchResult,
  LogbookQsoSnapshot,
} from '@tx5dr/core';
import type { PluginContextFor } from '../../context.js';
import type { PluginLogbookSessionAccess, QSOQueryFilter } from '../../helpers.js';
import type { VersionedContestSession } from './ContestSessionRepository.js';
import { ContestSessionRepository } from './ContestSessionRepository.js';
import type { ContestSessionModule } from './FT8ContestPlugin.js';

export const CONTEST_SESSION_PERMISSIONS = [
  'logbook:session',
  'plugin:event-bus',
] as const satisfies readonly PluginPermission[];

export type ContestSessionPermissions = typeof CONTEST_SESSION_PERMISSIONS;
export type ContestSessionContext = PluginContextFor<ContestSessionPermissions>;

export interface ContestSessionIdentity {
  id: string;
  edition: { id: string };
  rulesetVersion: string;
}

/** Plugin-owned configuration/projection state stored outside the QSO logbook. */
export interface ContestSessionStateFacade<TSession extends VersionedContestSession> {
  read(): TSession;
  update(mutator: (current: TSession) => TSession): TSession;
  /** Flushes pending KV writes; this is not a transaction with QSO/logbook writes. */
  flush(): Promise<void>;
}

/** @deprecated Use ContestSessionStateFacade; retained for the initial SDK preview. */
export type ContestSessionFacade<TSession extends VersionedContestSession> =
  ContestSessionStateFacade<TSession>;

export type ContestSessionHealthState = 'opening' | 'healthy' | 'degraded' | 'closed';

export interface ContestSessionHealth {
  state: ContestSessionHealthState;
  readable: boolean;
  writable: boolean;
  updatedAt: number;
  revision?: string;
  qsoCount?: number;
  error?: string;
}

export type ContestSessionChangeReason = 'transaction' | 'import' | 'review' | 'manual';

export interface ContestSessionChangeEvent {
  pluginName: string;
  stationCallsign: string;
  contestId: string;
  editionId: string;
  rulesetVersion: string;
  operatorId: string;
  reason: ContestSessionChangeReason;
  revision?: string;
  timestamp: number;
}

export interface ContestQsoTransactionOptions {
  /** Defaults to the module-level setting, normally 3. */
  maxAttempts?: number;
  /** Publishes Host/UI and plugin event-bus notifications by default. */
  notify?: boolean;
  reason?: ContestSessionChangeReason;
}

export interface ContestQsoTransactionResult {
  attempts: number;
  snapshot: LogbookQsoSnapshot;
  batch: LogbookBatchResult;
  /** The QSO transaction committed even when this best-effort notification failed. */
  notificationError?: string;
}

export type ContestQsoMutationPlanner = (
  snapshot: LogbookQsoSnapshot,
) => readonly LogbookBatchMutation[] | Promise<readonly LogbookBatchMutation[]>;

/**
 * Invocation-bound application facade. It opens the Host session internally,
 * so raw handles never escape and import/review code only supplies mutations.
 */
export interface ContestApplicationSessionFacade {
  getHealth(): ContestSessionHealth;
  query(filter?: QSOQueryFilter): Promise<QSORecord[]>;
  snapshot(filter?: QSOQueryFilter): Promise<LogbookQsoSnapshot>;
  transact(
    planner: ContestQsoMutationPlanner,
    options?: ContestQsoTransactionOptions,
  ): Promise<ContestQsoTransactionResult>;
  notify(reason?: ContestSessionChangeReason, revision?: string): Promise<void>;
  subscribe(handler: (event: ContestSessionChangeEvent) => void | Promise<void>): () => void;
}

export interface DefaultContestSessionOptions<
  TContest extends ContestSessionIdentity,
  TSession extends VersionedContestSession,
> {
  /** Scope of the non-QSO KV state. QSO data always lives in the Host plugin-session. */
  stateScope?: 'operator' | 'global';
  create(contest: TContest, context: ContestSessionContext): TSession;
  /** Overrides the generated durable key for an explicit migration. */
  sessionKey?(contest: TContest, context: ContestSessionContext): string;
  /** Overrides the KV state key for an explicit migration. */
  stateKey?(contest: TContest, context: ContestSessionContext): string;
  title?(contest: TContest, context: ContestSessionContext): string;
  maxTransactionAttempts?: number;
}

export interface DefaultContestSessionModule<
  TContest extends ContestSessionIdentity,
  TSession extends VersionedContestSession,
> extends ContestSessionModule<TContest, ContestSessionPermissions> {
  /** Access to plugin-owned non-QSO state for an already loaded operator instance. */
  forOperator(operatorId: string): ContestSessionStateFacade<TSession>;
  /** Binds Host operations to the current plugin invocation context. */
  access(context: ContestSessionContext): ContestApplicationSessionFacade;
  getHealth(operatorId: string): ContestSessionHealth;
  /** Returns the destination accepted by strategy QSO completion effects. */
  getDestination(operatorId: string): { kind: 'plugin-session-key'; sessionKey: string };
  /** Rebinds an already loaded operator to another immutable contest edition. */
  rebind(operatorId: string, contest: TContest, context: ContestSessionContext): Promise<void>;
}

function cloneHealth(health: ContestSessionHealth): ContestSessionHealth {
  return { ...health };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRevisionConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'LOGBOOK_REVISION_CONFLICT';
}

function validateAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error('contest_session_invalid_transaction_attempts');
  }
  return value;
}

function encodeIdentitySegment(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => {
    const character = String.fromCharCode(byte);
    if (/^[A-Za-z0-9.-]$/.test(character)) return character;
    if (character === '_') return '__';
    return `_${byte.toString(16).padStart(2, '0')}`;
  }).join('');
}

function defaultSessionKey(contest: ContestSessionIdentity): string {
  const key = [
    'contest',
    encodeIdentitySegment(contest.id),
    encodeIdentitySegment(contest.edition.id),
    encodeIdentitySegment(contest.rulesetVersion),
  ].join(':');
  if (key.length > 128) throw new Error('contest_session_identity_too_long');
  return key;
}

interface ContestSessionOwner {
  pluginName: string;
  stationCallsign: string;
}

function ownedChangeTopic(
  contest: ContestSessionIdentity,
  owner: ContestSessionOwner,
): string {
  return [
    'tx5dr.contest',
    encodeIdentitySegment(owner.pluginName),
    encodeIdentitySegment(owner.stationCallsign),
    encodeIdentitySegment(contest.id),
    encodeIdentitySegment(contest.edition.id),
    encodeIdentitySegment(contest.rulesetVersion),
    'session-changed',
  ].join(':');
}

function isChangeEvent(value: unknown): value is ContestSessionChangeEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<ContestSessionChangeEvent>;
  const reasons: readonly ContestSessionChangeReason[] = ['transaction', 'import', 'review', 'manual'];
  return typeof event.pluginName === 'string'
    && typeof event.stationCallsign === 'string'
    && typeof event.contestId === 'string'
    && typeof event.editionId === 'string'
    && typeof event.rulesetVersion === 'string'
    && typeof event.operatorId === 'string'
    && reasons.includes(event.reason as ContestSessionChangeReason)
    && typeof event.timestamp === 'number'
    && Number.isFinite(event.timestamp);
}

/**
 * Contest application facade backed by Host plugin-sessions and a small KV state store.
 * It hides session keys, event topics, raw handles and revision-conflict retry loops.
 */
export function defaultContestSession<
  TContest extends ContestSessionIdentity,
  TSession extends VersionedContestSession,
>(
  options: DefaultContestSessionOptions<TContest, TSession>,
): DefaultContestSessionModule<TContest, TSession> {
  if ((options as { retention?: unknown }).retention === 'runtime') {
    throw new Error('contest_session_runtime_retention_not_supported');
  }
  const repositories = new Map<string, ContestSessionRepository<TSession>>();
  const contests = new Map<string, TContest>();
  const owners = new Map<string, ContestSessionOwner>();
  const sessionKeys = new Map<string, string>();
  const health = new Map<string, ContestSessionHealth>();
  const subscriptions = new Map<string, Set<() => void>>();
  const defaultAttempts = validateAttempts(options.maxTransactionAttempts ?? 3);

  function setHealth(
    operatorId: string,
    patch: Partial<ContestSessionHealth> & Pick<ContestSessionHealth, 'state'>,
  ): ContestSessionHealth {
    const current = health.get(operatorId);
    const next: ContestSessionHealth = {
      ...current,
      ...patch,
      state: patch.state,
      readable: patch.readable ?? (patch.state === 'healthy' ? true : current?.readable ?? false),
      writable: patch.writable ?? (patch.state === 'healthy' ? true : current?.writable ?? false),
      updatedAt: Date.now(),
      error: patch.error ?? (patch.state === 'healthy' ? undefined : current?.error),
    };
    health.set(operatorId, next);
    return next;
  }

  function requireContest(operatorId: string): TContest {
    const contest = contests.get(operatorId);
    if (!contest) throw new Error('contest_session_not_open');
    return contest;
  }

  function requireOwner(operatorId: string): ContestSessionOwner {
    const owner = owners.get(operatorId);
    if (!owner) throw new Error('contest_session_not_open');
    return owner;
  }

  async function openHostSession(
    contest: TContest,
    context: ContestSessionContext,
    owner: ContestSessionOwner,
  ): Promise<PluginLogbookSessionAccess> {
    const access = await context.logbook.sessions.open({
      sessionKey: options.sessionKey?.(contest, context) ?? defaultSessionKey(contest),
      stationCallsign: owner.stationCallsign,
      title: options.title?.(contest, context)
        ?? `${contest.id} ${contest.edition.id} - ${owner.stationCallsign}`,
    });
    await access.awaitReady();
    return access;
  }

  async function publishChange(
    contest: TContest,
    context: ContestSessionContext,
    owner: ContestSessionOwner,
    reason: ContestSessionChangeReason,
    revision?: string,
    hostAccess?: PluginLogbookSessionAccess,
  ): Promise<void> {
    const access = hostAccess ?? await openHostSession(contest, context, owner);
    await access.notifyUpdated(context.operator.id);
    context.eventBus.publish(ownedChangeTopic(contest, owner), {
      pluginName: owner.pluginName,
      stationCallsign: owner.stationCallsign,
      contestId: contest.id,
      editionId: contest.edition.id,
      rulesetVersion: contest.rulesetVersion,
      operatorId: context.operator.id,
      reason,
      revision,
      timestamp: Date.now(),
    } satisfies ContestSessionChangeEvent);
  }

  return {
    id: 'default-contest-session',
    forOperator(operatorId) {
      const repository = repositories.get(operatorId);
      if (!repository) throw new Error('contest_session_not_open');
      return repository;
    },
    getHealth(operatorId) {
      return cloneHealth(health.get(operatorId) ?? {
        state: 'closed',
        readable: false,
        writable: false,
        updatedAt: Date.now(),
      });
    },
    getDestination(operatorId) {
      const key = sessionKeys.get(operatorId);
      if (!key) throw new Error('contest_session_not_open');
      return { kind: 'plugin-session-key', sessionKey: key };
    },
    async rebind(operatorId, contest, context) {
      const currentRepository = repositories.get(operatorId);
      const owner = owners.get(operatorId);
      if (!currentRepository || !owner) throw new Error('contest_session_not_open');
      for (const unsubscribe of subscriptions.get(operatorId) ?? []) unsubscribe();
      subscriptions.delete(operatorId);
      await currentRepository.flush();

      const store = options.stateScope === 'global' ? context.store.global : context.store.operator;
      const durableKey = options.sessionKey?.(contest, context) ?? defaultSessionKey(contest);
      const repository = new ContestSessionRepository(
        store,
        options.stateKey?.(contest, context) ?? durableKey,
        () => options.create(contest, context),
      );
      repositories.set(operatorId, repository);
      contests.set(operatorId, contest);
      sessionKeys.set(operatorId, durableKey);
      setHealth(operatorId, { state: 'opening', readable: false, writable: false });
      try {
        const access = await openHostSession(contest, context, owner);
        const snapshot = await access.readQsoSnapshot();
        setHealth(operatorId, {
          state: 'healthy',
          revision: snapshot.revision,
          qsoCount: snapshot.records.length,
        });
      } catch (error) {
        setHealth(operatorId, {
          state: 'degraded',
          readable: false,
          writable: false,
          error: errorMessage(error),
        });
        throw error;
      }
    },
    access(context) {
      const operatorId = context.operator.id;
      const contest = requireContest(operatorId);
      const owner = requireOwner(operatorId);
      return {
        getHealth: () => cloneHealth(health.get(operatorId) ?? setHealth(operatorId, {
          state: 'closed',
          readable: false,
          writable: false,
        })),
        async query(filter = {}) {
          try {
            const access = await openHostSession(contest, context, owner);
            const records = await access.queryQSOs(filter);
            setHealth(operatorId, { state: 'healthy' });
            return records;
          } catch (error) {
            setHealth(operatorId, {
              state: 'degraded',
              readable: false,
              writable: false,
              error: errorMessage(error),
            });
            throw error;
          }
        },
        async snapshot(filter = {}) {
          try {
            const access = await openHostSession(contest, context, owner);
            const snapshot = await access.readQsoSnapshot(filter);
            setHealth(operatorId, {
              state: 'healthy',
              revision: snapshot.revision,
              qsoCount: snapshot.records.length,
            });
            return snapshot;
          } catch (error) {
            setHealth(operatorId, {
              state: 'degraded',
              readable: false,
              writable: false,
              error: errorMessage(error),
            });
            throw error;
          }
        },
        async transact(planner, transactionOptions = {}) {
          const maxAttempts = validateAttempts(transactionOptions.maxAttempts ?? defaultAttempts);
          let access: PluginLogbookSessionAccess;
          try {
            access = await openHostSession(contest, context, owner);
          } catch (error) {
            setHealth(operatorId, {
              state: 'degraded',
              readable: false,
              writable: false,
              error: errorMessage(error),
            });
            throw error;
          }
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            let snapshot: LogbookQsoSnapshot | undefined;
            try {
              snapshot = await access.readQsoSnapshot();
              const mutations = await planner(structuredClone(snapshot));
              const batch = await access.applyQsoBatch(mutations, {
                expectedRevision: snapshot.revision,
              });
              const added = batch.outcomes.filter((outcome) => outcome.status === 'added').length;
              setHealth(operatorId, {
                state: 'healthy',
                revision: batch.revision,
                qsoCount: snapshot.records.length + added,
              });
              let notificationError: string | undefined;
              if (transactionOptions.notify !== false) {
                try {
                  await publishChange(
                    contest,
                    context,
                    owner,
                    transactionOptions.reason ?? 'transaction',
                    batch.revision,
                    access,
                  );
                } catch (error) {
                  notificationError = errorMessage(error);
                  setHealth(operatorId, {
                    state: 'degraded',
                    readable: true,
                    writable: true,
                    revision: batch.revision,
                    qsoCount: snapshot.records.length + added,
                    error: notificationError,
                  });
                }
              }
              return { attempts: attempt, snapshot, batch, notificationError };
            } catch (error) {
              if (isRevisionConflict(error) && attempt < maxAttempts) continue;
              setHealth(operatorId, {
                state: 'degraded',
                readable: snapshot !== undefined,
                writable: false,
                revision: snapshot?.revision,
                qsoCount: snapshot?.records.length,
                error: errorMessage(error),
              });
              throw error;
            }
          }
          throw new Error('contest_session_transaction_exhausted');
        },
        notify(reason = 'manual', revision) {
          return publishChange(contest, context, owner, reason, revision);
        },
        subscribe(handler) {
          const unsubscribe = context.eventBus.subscribe(ownedChangeTopic(contest, owner), (message) => {
            if (!isChangeEvent(message.payload)) return;
            if (message.publisher.pluginName !== owner.pluginName
              || message.payload.pluginName !== owner.pluginName
              || message.payload.stationCallsign !== owner.stationCallsign
              || message.payload.contestId !== contest.id
              || message.payload.editionId !== contest.edition.id
              || message.payload.rulesetVersion !== contest.rulesetVersion) return;
            return handler(message.payload);
          });
          const operatorSubscriptions = subscriptions.get(operatorId) ?? new Set<() => void>();
          operatorSubscriptions.add(unsubscribe);
          subscriptions.set(operatorId, operatorSubscriptions);
          return () => {
            operatorSubscriptions.delete(unsubscribe);
            unsubscribe();
          };
        },
      };
    },
    async setup({ contest, context, pluginName }) {
      const operatorId = context.operator.id;
      if (repositories.has(operatorId)) throw new Error('contest_session_already_open');
      const owner = {
        pluginName: pluginName.trim(),
        stationCallsign: context.operator.callsign.trim().toUpperCase(),
      };
      if (!owner.pluginName || !owner.stationCallsign) throw new Error('contest_session_owner_invalid');
      const store = options.stateScope === 'global' ? context.store.global : context.store.operator;
      const durableKey = options.sessionKey?.(contest, context) ?? defaultSessionKey(contest);
      const repository = new ContestSessionRepository(
        store,
        options.stateKey?.(contest, context) ?? durableKey,
        () => options.create(contest, context),
      );
      repositories.set(operatorId, repository);
      contests.set(operatorId, contest);
      owners.set(operatorId, owner);
      sessionKeys.set(operatorId, durableKey);
      setHealth(operatorId, { state: 'opening', readable: false, writable: false });
      try {
        const access = await openHostSession(contest, context, owner);
        const snapshot = await access.readQsoSnapshot();
        setHealth(operatorId, {
          state: 'healthy',
          revision: snapshot.revision,
          qsoCount: snapshot.records.length,
        });
      } catch (error) {
        setHealth(operatorId, {
          state: 'degraded',
          readable: false,
          writable: false,
          error: errorMessage(error),
        });
        repositories.delete(operatorId);
        contests.delete(operatorId);
        owners.delete(operatorId);
        sessionKeys.delete(operatorId);
        throw error;
      }
      return async () => {
        try {
          for (const unsubscribe of subscriptions.get(operatorId) ?? []) unsubscribe();
          subscriptions.delete(operatorId);
          await (repositories.get(operatorId) ?? repository).flush();
        } finally {
          repositories.delete(operatorId);
          contests.delete(operatorId);
          owners.delete(operatorId);
          sessionKeys.delete(operatorId);
          setHealth(operatorId, { state: 'closed', readable: false, writable: false });
        }
      };
    },
  };
}
