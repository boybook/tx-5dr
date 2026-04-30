import { RealtimeJitterEstimator, type RealtimeJitterEstimatorSnapshot } from '@tx5dr/core';
import { resolveVoiceTxBufferPolicy, type ResolvedVoiceTxBufferPolicy } from '@tx5dr/contracts';
import type { VoiceTxFrameMeta } from '../voice/VoiceTxDiagnostics.js';
import type { Logger } from '../utils/logger.js';

const TARGET_INCREASE_MS = 20;
const TARGET_DECREASE_MS = 20;
const TARGET_INCREASE_COOLDOWN_MS = 0;
const TARGET_DECREASE_AFTER_MS = 30_000;
const TX_JITTER_SEED_TTL_MS = 30 * 60 * 1000;
const TX_JITTER_MAX_LOG_INTERVAL_MS = 2000;
const DEFAULT_VOICE_TX_BUFFER_POLICY = resolveVoiceTxBufferPolicy();

interface TxJitterSeed {
  targetMs: number;
  p95Ms: number;
  updatedAtMs: number;
}

interface ProbeEstimatorEntry {
  estimator: RealtimeJitterEstimator;
  policySignature: string;
  updatedAtMs: number;
}

export interface VoiceTxTimingProbeSeedData {
  participantIdentity: string;
  transport: VoiceTxFrameMeta['transport'];
  codec?: VoiceTxFrameMeta['codec'];
  sequence: number;
  sentAtMs: number;
  receivedAtMs: number;
  intervalMs: number;
  voiceTxBufferPolicy?: ResolvedVoiceTxBufferPolicy;
}

export interface VoiceTxJitterControllerOptions {
  logger: Logger;
  debug: boolean;
  debugRealtimeJitter: boolean;
}

export interface VoiceTxJitterPolicyApplyResult {
  changed: boolean;
  previousTargetMs: number;
  seedTarget: number | null;
  key: string | null;
}

const txJitterSeeds = new Map<string, TxJitterSeed>();
const probeEstimators = new Map<string, ProbeEstimatorEntry>();

function roundUpToFrameMs(valueMs: number): number {
  return Math.ceil(valueMs / 20) * 20;
}

function createEstimator(policy: ResolvedVoiceTxBufferPolicy, initialTargetMs: number, nowMs: number): RealtimeJitterEstimator {
  return new RealtimeJitterEstimator({
    minTargetMs: policy.minMs,
    initialTargetMs,
    softFloorMs: policy.targetMs,
    maxTargetMs: policy.maxMs,
    frameDurationMs: 20,
    basePreRollMs: Math.max(policy.minMs, policy.targetMs - 10),
    schedulingMarginMs: 10,
    decreaseAfterMs: TARGET_DECREASE_AFTER_MS,
    decreaseStepMs: TARGET_DECREASE_MS,
    underrunIncreaseMs: TARGET_INCREASE_MS,
    nowMs,
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function getStableVoiceTxParticipantIdentity(identity: string): string {
  const parts = identity.split(':');
  if (parts.length >= 3 && isUuid(parts[parts.length - 1]!)) {
    return parts.slice(0, -1).join(':');
  }
  return identity;
}

export function getVoiceTxJitterSeedKey(
  meta: Pick<VoiceTxFrameMeta, 'participantIdentity' | 'transport' | 'codec'>,
  policy: ResolvedVoiceTxBufferPolicy,
): string {
  return [
    getStableVoiceTxParticipantIdentity(meta.participantIdentity),
    meta.transport,
    meta.codec ?? 'unknown',
    policy.profile,
    policy.targetMs,
  ].join(':');
}

export function clearVoiceTxJitterSeedsForTests(): void {
  txJitterSeeds.clear();
  probeEstimators.clear();
}

export class VoiceTxJitterController {
  private currentPolicy: ResolvedVoiceTxBufferPolicy = DEFAULT_VOICE_TX_BUFFER_POLICY;
  private currentPolicySignature = this.policySignature(DEFAULT_VOICE_TX_BUFFER_POLICY);
  private adaptiveTargetMs = DEFAULT_VOICE_TX_BUFFER_POLICY.targetMs;
  private jitterEstimator: RealtimeJitterEstimator | null = null;
  private activeSeedKey: string | null = null;
  private jitterEstimatorSource: 'probe' | 'packet' | null = null;
  private lastJitterSnapshot: RealtimeJitterEstimatorSnapshot | null = null;
  private lastLoggedJitterTargetMs: number | null = null;
  private lastLoggedJitterMaxAtMs = 0;
  private lastTargetChangeAt = 0;

  constructor(private readonly options: VoiceTxJitterControllerOptions) {}

  get policy(): ResolvedVoiceTxBufferPolicy {
    return this.currentPolicy;
  }

  get targetMs(): number {
    return this.adaptiveTargetMs;
  }

  get snapshot(): RealtimeJitterEstimatorSnapshot | null {
    return this.lastJitterSnapshot;
  }

  get source(): 'probe' | 'packet' | null {
    return this.jitterEstimatorSource;
  }

  get seedKey(): string | null {
    return this.activeSeedKey;
  }

  clear(): void {
    this.currentPolicy = DEFAULT_VOICE_TX_BUFFER_POLICY;
    this.currentPolicySignature = this.policySignature(DEFAULT_VOICE_TX_BUFFER_POLICY);
    this.adaptiveTargetMs = DEFAULT_VOICE_TX_BUFFER_POLICY.targetMs;
    this.jitterEstimator = null;
    this.activeSeedKey = null;
    this.jitterEstimatorSource = null;
    this.lastJitterSnapshot = null;
    this.lastLoggedJitterTargetMs = null;
    this.lastLoggedJitterMaxAtMs = 0;
    this.lastTargetChangeAt = 0;
  }

  recordProbeSeed(data: VoiceTxTimingProbeSeedData): RealtimeJitterEstimatorSnapshot | null {
    const policy = data.voiceTxBufferPolicy ?? DEFAULT_VOICE_TX_BUFFER_POLICY;
    if (policy.profile !== 'auto') {
      return null;
    }
    const now = data.receivedAtMs;
    const key = getVoiceTxJitterSeedKey({
      participantIdentity: data.participantIdentity,
      transport: data.transport,
      codec: data.codec,
    }, policy);
    const signature = this.policySignature(policy);
    const seedTarget = this.loadSeedTarget(key, policy, now);
    const initialTargetMs = Math.max(policy.targetMs, seedTarget ?? 0);
    let entry = probeEstimators.get(key);
    if (!entry || entry.policySignature !== signature || (now - entry.updatedAtMs) > TX_JITTER_SEED_TTL_MS) {
      entry = {
        estimator: createEstimator(policy, initialTargetMs, now),
        policySignature: signature,
        updatedAtMs: now,
      };
      probeEstimators.set(key, entry);
    }
    entry.updatedAtMs = now;
    const snapshot = entry.estimator.recordProbe({
      sequence: data.sequence,
      sentAtMs: data.sentAtMs,
      arrivalTimeMs: now,
      intervalMs: data.intervalMs,
    });
    this.saveSeed(key, policy, snapshot, now);
    this.logProbeSeed('seed-only', key, policy, snapshot);
    return snapshot;
  }

  applyMediaPolicy(
    policy: ResolvedVoiceTxBufferPolicy | undefined,
    now: number,
    meta: VoiceTxFrameMeta,
  ): VoiceTxJitterPolicyApplyResult {
    const nextPolicy = policy ?? DEFAULT_VOICE_TX_BUFFER_POLICY;
    const nextSignature = this.policySignature(nextPolicy);
    const nextSeedKey = getVoiceTxJitterSeedKey(meta, nextPolicy);
    const needsEstimator = nextPolicy.profile === 'auto' && !this.jitterEstimator;
    if (
      nextSignature !== this.currentPolicySignature
      || nextSeedKey !== this.activeSeedKey
      || needsEstimator
    ) {
      const previousPolicy = this.currentPolicy;
      const previousTargetMs = this.adaptiveTargetMs;
      this.currentPolicy = nextPolicy;
      this.currentPolicySignature = nextSignature;
      this.activeSeedKey = nextSeedKey;
      const seedTarget = nextPolicy.profile === 'auto'
        ? this.loadSeedTarget(nextSeedKey, nextPolicy, now)
        : null;
      this.adaptiveTargetMs = nextPolicy.profile === 'auto'
        ? Math.max(nextPolicy.targetMs, seedTarget ?? 0)
        : nextPolicy.targetMs;
      this.jitterEstimator = nextPolicy.profile === 'auto'
        ? createEstimator(nextPolicy, this.adaptiveTargetMs, now)
        : null;
      this.lastJitterSnapshot = this.jitterEstimator?.getSnapshot(now) ?? null;
      this.jitterEstimatorSource = null;
      this.lastLoggedJitterTargetMs = null;
      this.lastLoggedJitterMaxAtMs = 0;
      this.lastTargetChangeAt = now;
      this.logPolicyApplied({
        key: nextSeedKey,
        previousPolicy,
        nextPolicy,
        previousTargetMs,
        seedTarget,
        meta,
      });
      return {
        changed: true,
        previousTargetMs,
        seedTarget,
        key: nextSeedKey,
      };
    }
    return {
      changed: false,
      previousTargetMs: this.adaptiveTargetMs,
      seedTarget: null,
      key: nextSeedKey,
    };
  }

  notePacket(meta: VoiceTxFrameMeta, now: number): RealtimeJitterEstimatorSnapshot | null {
    if (!this.jitterEstimator || this.currentPolicy.profile !== 'auto') {
      return this.lastJitterSnapshot;
    }
    if (this.jitterEstimatorSource !== 'packet') {
      this.jitterEstimator.reset({
        initialTargetMs: this.adaptiveTargetMs,
        nowMs: meta.serverReceivedAtMs,
      });
      this.jitterEstimatorSource = 'packet';
    }
    const frameDurationMs = typeof meta.frameDurationMs === 'number' && meta.frameDurationMs > 0
      ? meta.frameDurationMs
      : meta.sampleRate > 0
        ? (meta.samplesPerChannel / meta.sampleRate) * 1000
        : 20;
    this.lastJitterSnapshot = this.jitterEstimator.recordPacket({
      sequence: meta.sequence,
      arrivalTimeMs: meta.serverReceivedAtMs,
      frameDurationMs,
    });
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.saveCurrentSeed(now);
    this.logJitterSnapshot('packet');
    return this.lastJitterSnapshot;
  }

  noteUnderrun(now: number): boolean {
    const previousTargetMs = this.adaptiveTargetMs;
    if (this.jitterEstimator && this.currentPolicy.profile === 'auto' && (now - this.lastTargetChangeAt) >= TARGET_INCREASE_COOLDOWN_MS) {
      this.lastJitterSnapshot = this.jitterEstimator.noteUnderrun(now);
      this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
      this.saveCurrentSeed(now);
      this.logJitterSnapshot('underrun');
      this.lastTargetChangeAt = now;
      return this.adaptiveTargetMs !== previousTargetMs;
    }
    return false;
  }

  maybeUpdate(now: number): boolean {
    if (!this.jitterEstimator || this.currentPolicy.profile !== 'auto') {
      return false;
    }
    const previousTargetMs = this.adaptiveTargetMs;
    this.lastJitterSnapshot = this.jitterEstimator.maybeUpdate(now);
    this.adaptiveTargetMs = this.lastJitterSnapshot.activeTargetMs;
    this.saveCurrentSeed(now);
    this.logJitterSnapshot('timer');
    return this.adaptiveTargetMs !== previousTargetMs;
  }

  private policySignature(policy: ResolvedVoiceTxBufferPolicy): string {
    return [
      policy.profile,
      policy.targetMs,
      policy.minMs,
      policy.maxMs,
      policy.headroomMs,
      policy.staleFrameMs,
      policy.uplinkMaxBufferedAudioMs,
      policy.uplinkDegradedBufferedAudioMs,
    ].join(':');
  }

  private loadSeedTarget(key: string, policy: ResolvedVoiceTxBufferPolicy, now: number): number | null {
    const seed = txJitterSeeds.get(key);
    if (!seed || (now - seed.updatedAtMs) > TX_JITTER_SEED_TTL_MS) {
      txJitterSeeds.delete(key);
      return null;
    }
    return this.resolveSeedTargetForPolicy(policy, seed);
  }

  private saveCurrentSeed(now: number): void {
    if (!this.activeSeedKey || !this.lastJitterSnapshot) {
      return;
    }
    this.saveSeed(this.activeSeedKey, this.currentPolicy, this.lastJitterSnapshot, now);
  }

  private saveSeed(
    key: string,
    policy: ResolvedVoiceTxBufferPolicy,
    snapshot: RealtimeJitterEstimatorSnapshot,
    now: number,
  ): void {
    txJitterSeeds.set(key, {
      targetMs: this.resolveSeedTargetForPolicy(policy, {
        targetMs: snapshot.activeTargetMs,
        p95Ms: snapshot.relativeDelayP95Ms,
        updatedAtMs: now,
      }),
      p95Ms: snapshot.relativeDelayP95Ms,
      updatedAtMs: now,
    });
  }

  private resolveSeedTargetForPolicy(policy: ResolvedVoiceTxBufferPolicy, seed: TxJitterSeed): number {
    const boundedTarget = Math.max(policy.minMs, Math.min(policy.maxMs, Math.round(seed.targetMs)));
    if (policy.profile !== 'auto') {
      return boundedTarget;
    }

    const p95Ms = Number(seed.p95Ms);
    if (!Number.isFinite(p95Ms)) {
      return boundedTarget;
    }
    const basePreRollMs = Math.max(policy.minMs, policy.targetMs - 10);
    const recommended = roundUpToFrameMs(basePreRollMs + Math.max(0, p95Ms) + 10);
    return Math.min(
      boundedTarget,
      Math.max(policy.targetMs, Math.min(policy.maxMs, recommended)),
    );
  }

  private logPolicyApplied(data: {
    key: string;
    previousPolicy: ResolvedVoiceTxBufferPolicy;
    nextPolicy: ResolvedVoiceTxBufferPolicy;
    previousTargetMs: number;
    seedTarget: number | null;
    meta: VoiceTxFrameMeta;
  }): void {
    if (!this.options.debug) {
      return;
    }
    this.options.logger.info('Voice TX output policy applied', {
      reason: 'active-media',
      stableSeedKey: data.key,
      incomingParticipantIdentity: data.meta.participantIdentity,
      previousPolicy: this.policySummary(data.previousPolicy),
      nextPolicy: this.policySummary(data.nextPolicy),
      targetBefore: data.previousTargetMs,
      targetAfter: this.adaptiveTargetMs,
      seedTarget: data.seedTarget,
      source: this.jitterEstimatorSource,
    });
  }

  private logProbeSeed(
    action: 'seed-only' | 'ignored' | 'active',
    key: string,
    policy: ResolvedVoiceTxBufferPolicy,
    snapshot: RealtimeJitterEstimatorSnapshot,
  ): void {
    if (!this.options.debugRealtimeJitter) {
      return;
    }
    this.options.logger.debug('Voice TX timing probe handled', {
      probeAction: action,
      stableSeedKey: key,
      targetMs: snapshot.activeTargetMs,
      recommendedMs: snapshot.recommendedTargetMs,
      p95Ms: snapshot.relativeDelayP95Ms,
      jitterEwmaMs: snapshot.jitterEwmaMs,
      sampleCount: snapshot.sampleCount,
      policy: this.policySummary(policy),
    });
  }

  private logJitterSnapshot(reason: 'packet' | 'underrun' | 'timer'): void {
    if (!this.lastJitterSnapshot) {
      return;
    }
    const targetChanged = this.lastLoggedJitterTargetMs !== this.lastJitterSnapshot.activeTargetMs;
    const isAtMax = this.lastJitterSnapshot.activeTargetMs >= this.currentPolicy.maxMs;
    const now = Date.now();
    const shouldRepeatMaxLog = isAtMax && (now - this.lastLoggedJitterMaxAtMs) >= TX_JITTER_MAX_LOG_INTERVAL_MS;
    if ((!targetChanged && !shouldRepeatMaxLog) || (!this.options.debugRealtimeJitter && !(isAtMax && this.currentPolicy.maxMs >= 220))) {
      return;
    }
    this.lastLoggedJitterTargetMs = this.lastJitterSnapshot.activeTargetMs;
    if (isAtMax) {
      this.lastLoggedJitterMaxAtMs = now;
    }
    const payload = {
      reason,
      source: this.jitterEstimatorSource,
      stableSeedKey: this.activeSeedKey,
      targetMs: this.lastJitterSnapshot.activeTargetMs,
      recommendedMs: this.lastJitterSnapshot.recommendedTargetMs,
      p95Ms: this.lastJitterSnapshot.relativeDelayP95Ms,
      jitterEwmaMs: this.lastJitterSnapshot.jitterEwmaMs,
      sampleCount: this.lastJitterSnapshot.sampleCount,
      lastSample: this.lastJitterSnapshot.lastSample,
      policy: this.policySummary(this.currentPolicy),
    };
    if (isAtMax) {
      this.options.logger.warn('TX jitter target reached max', payload);
    } else if (this.options.debugRealtimeJitter) {
      this.options.logger.debug('TX jitter target changed', payload);
    }
  }

  private policySummary(policy: ResolvedVoiceTxBufferPolicy): {
    profile: ResolvedVoiceTxBufferPolicy['profile'];
    targetMs: number;
    minMs: number;
    maxMs: number;
  } {
    return {
      profile: policy.profile,
      targetMs: policy.targetMs,
      minMs: policy.minMs,
      maxMs: policy.maxMs,
    };
  }
}
