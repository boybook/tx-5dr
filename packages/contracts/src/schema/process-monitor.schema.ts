import { RttyDecoderStateSchema } from './rtty.schema.js';
import { z } from 'zod';

export const ProcessMemorySchema = z.object({
  heapUsed: z.number(),
  heapTotal: z.number(),
  rss: z.number(),
  external: z.number(),
  arrayBuffers: z.number(),
});

export const ProcessCpuSchema = z.object({
  user: z.number(),
  system: z.number(),
  total: z.number(),
  capacity: z.number().positive().optional(),
  normalizedTotal: z.number().optional(),
});

export const HostCpuSchema = z.object({
  logicalCores: z.number().int().positive(),
  availableParallelism: z.number().int().positive(),
  totalUsage: z.number().optional(),
});

export const EventLoopDelaySchema = z.object({
  mean: z.number(),
  p50: z.number(),
  p99: z.number(),
});

export const DecodeWorkerCurrentJobSchema = z.object({
  jobId: z.number(),
  slotId: z.string(),
  windowIdx: z.number(),
  mode: z.string(),
  startedAt: z.number(),
  elapsedMs: z.number(),
  requestAudioDurationMs: z.number().optional(),
  decodeDepth: z.number().int().min(1).max(3).optional(),
  decodeStage: z.union([
    z.literal(41), z.literal(47), z.literal(49), z.literal(50),
    z.enum(['ft4-partial', 'ft4-final']),
  ]).optional(),
  decisionDeadlineMs: z.number().optional(),
});

export const DecodeWorkerTelemetryWorkerSchema = z.object({
  workerId: z.number(),
  pid: z.number().optional(),
  ready: z.boolean(),
  busy: z.boolean(),
  nativeThreads: z.number().int().positive(),
  uptimeSeconds: z.number(),
  memory: ProcessMemorySchema,
  cpu: ProcessCpuSchema,
  currentJob: DecodeWorkerCurrentJobSchema.optional(),
  lastSeenAt: z.number(),
  reservedSessionId: z.string().optional(),
  sessionCleanupPending: z.boolean().optional(),
});

export const DecodeWorkerTelemetrySummarySchema = z.object({
  status: z.enum(['stopped', 'starting', 'ready', 'degraded', 'unavailable']).optional(),
  workerCount: z.number().int().nonnegative(),
  desiredWorkers: z.number().int().nonnegative().optional(),
  readyCount: z.number().int().nonnegative(),
  busyCount: z.number().int().nonnegative(),
  totalRss: z.number().nonnegative(),
  totalCpu: z.number().nonnegative(),
  nativeThreadsPerWorker: z.number().int().positive(),
  pendingJobs: z.number().int().nonnegative(),
  activeJobs: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  unavailableReason: z.enum(['worker-unavailable', 'queue-stalled']).optional(),
  oldestPendingMs: z.number().nonnegative().optional(),
  noProgressMs: z.number().nonnegative().optional(),
  lastFailureAt: z.number().optional(),
  restartAttempts: z.number().int().nonnegative().optional(),
  workerEntry: z.string().optional(),
  workerMode: z.enum(['development', 'production']).optional(),
  nativeDecodeTiming: z.object({
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    sampleCount: z.number().int().nonnegative(),
  }).optional(),
});

export const DecodeWorkerTelemetrySnapshotSchema = z.object({
  summary: DecodeWorkerTelemetrySummarySchema,
  workers: z.array(DecodeWorkerTelemetryWorkerSchema),
});

export const WorkerPoolTelemetryWorkerSchema = DecodeWorkerTelemetryWorkerSchema;
export const WorkerPoolTelemetrySummarySchema = DecodeWorkerTelemetrySummarySchema;

export const WorkerPoolTelemetrySnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  summary: WorkerPoolTelemetrySummarySchema,
  workers: z.array(WorkerPoolTelemetryWorkerSchema),
});

export const WorkerPoolTelemetryListSchema = z.array(WorkerPoolTelemetrySnapshotSchema);

/** RTTY receive/transmit counters (present while the RTTY service runs). */
export const RttyTelemetrySnapshotSchema = z.object({
  rx: z.object({
    state: RttyDecoderStateSchema,
    sampleRate: z.number().nullable(),
    historySeconds: z.number().nonnegative(),
    samplesDecoded: z.number().nonnegative(),
    samplesLost: z.number().nonnegative(),
    overruns: z.number().int().nonnegative(),
    restarts: z.number().int().nonnegative(),
    replays: z.number().int().nonnegative(),
    lastReplayMs: z.number().nonnegative().nullable(),
    backlogChunks: z.number().int().nonnegative(),
    nativeQueuedSamples: z.number().nonnegative(),
    scannerChannels: z.number().int().nonnegative().optional(),
    scannerDroppedChunks: z.number().int().nonnegative().optional(),
  }),
  tx: z.object({
    phase: z.string(),
    sessions: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
  }),
});

export const ProcessSnapshotSchema = z.object({
  timestamp: z.number(),
  uptimeSeconds: z.number(),
  memory: ProcessMemorySchema,
  cpu: ProcessCpuSchema,
  hostCpu: HostCpuSchema.optional(),
  eventLoop: EventLoopDelaySchema,
  decodeWorkers: DecodeWorkerTelemetrySnapshotSchema.optional(),
  workerPools: WorkerPoolTelemetryListSchema.optional(),
  rtty: RttyTelemetrySnapshotSchema.optional(),
});

export const ProcessSnapshotHistorySchema = z.object({
  snapshots: z.array(ProcessSnapshotSchema),
  intervalMs: z.number(),
  maxHistory: z.number(),
});

export type ProcessMemory = z.infer<typeof ProcessMemorySchema>;
export type ProcessCpu = z.infer<typeof ProcessCpuSchema>;
export type HostCpu = z.infer<typeof HostCpuSchema>;
export type EventLoopDelay = z.infer<typeof EventLoopDelaySchema>;
export type DecodeWorkerCurrentJob = z.infer<typeof DecodeWorkerCurrentJobSchema>;
export type DecodeWorkerTelemetryWorker = z.infer<typeof DecodeWorkerTelemetryWorkerSchema>;
export type DecodeWorkerTelemetrySummary = z.infer<typeof DecodeWorkerTelemetrySummarySchema>;
export type DecodeWorkerTelemetrySnapshot = z.infer<typeof DecodeWorkerTelemetrySnapshotSchema>;
export type WorkerPoolTelemetryWorker = z.infer<typeof WorkerPoolTelemetryWorkerSchema>;
export type WorkerPoolTelemetrySummary = z.infer<typeof WorkerPoolTelemetrySummarySchema>;
export type WorkerPoolTelemetrySnapshot = z.infer<typeof WorkerPoolTelemetrySnapshotSchema>;
export type WorkerPoolTelemetryList = z.infer<typeof WorkerPoolTelemetryListSchema>;
export type RttyTelemetrySnapshot = z.infer<typeof RttyTelemetrySnapshotSchema>;
export type ProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;
export type ProcessSnapshotHistory = z.infer<typeof ProcessSnapshotHistorySchema>;
