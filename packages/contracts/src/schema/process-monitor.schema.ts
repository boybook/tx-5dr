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
  lastFailureAt: z.number().optional(),
  restartAttempts: z.number().int().nonnegative().optional(),
  workerEntry: z.string().optional(),
  workerMode: z.enum(['development', 'production']).optional(),
});

export const DecodeWorkerTelemetrySnapshotSchema = z.object({
  summary: DecodeWorkerTelemetrySummarySchema,
  workers: z.array(DecodeWorkerTelemetryWorkerSchema),
});

export const ProcessSnapshotSchema = z.object({
  timestamp: z.number(),
  uptimeSeconds: z.number(),
  memory: ProcessMemorySchema,
  cpu: ProcessCpuSchema,
  hostCpu: HostCpuSchema.optional(),
  eventLoop: EventLoopDelaySchema,
  decodeWorkers: DecodeWorkerTelemetrySnapshotSchema.optional(),
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
export type ProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;
export type ProcessSnapshotHistory = z.infer<typeof ProcessSnapshotHistorySchema>;
