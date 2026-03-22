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
});

export const EventLoopDelaySchema = z.object({
  mean: z.number(),
  p50: z.number(),
  p99: z.number(),
});

export const ProcessSnapshotSchema = z.object({
  timestamp: z.number(),
  uptimeSeconds: z.number(),
  memory: ProcessMemorySchema,
  cpu: ProcessCpuSchema,
  eventLoop: EventLoopDelaySchema,
});

export const ProcessSnapshotHistorySchema = z.object({
  snapshots: z.array(ProcessSnapshotSchema),
  intervalMs: z.number(),
  maxHistory: z.number(),
});

export type ProcessMemory = z.infer<typeof ProcessMemorySchema>;
export type ProcessCpu = z.infer<typeof ProcessCpuSchema>;
export type EventLoopDelay = z.infer<typeof EventLoopDelaySchema>;
export type ProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;
export type ProcessSnapshotHistory = z.infer<typeof ProcessSnapshotHistorySchema>;
