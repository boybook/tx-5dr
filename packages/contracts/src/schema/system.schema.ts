import { z } from 'zod';

// ===== 网络信息 =====

export const NetworkAddressSchema = z.object({
  ip: z.string(),
  url: z.string(),
});

export type NetworkAddress = z.infer<typeof NetworkAddressSchema>;

export const NetworkInfoSchema = z.object({
  addresses: z.array(NetworkAddressSchema),
  hostname: z.string(),
  webPort: z.number(),
});

export type NetworkInfo = z.infer<typeof NetworkInfoSchema>;

// ===== 时钟状态 =====

export const ClockSyncStateSchema = z.enum(['synced', 'stale', 'never', 'failed']);
export type ClockSyncState = z.infer<typeof ClockSyncStateSchema>;

export const ClockIndicatorStateSchema = z.enum(['ok', 'warn', 'alert', 'stale', 'failed', 'never']);
export type ClockIndicatorState = z.infer<typeof ClockIndicatorStateSchema>;

export const ClockStatusSummarySchema = z.object({
  appliedOffsetMs: z.number(),
  indicatorState: ClockIndicatorStateSchema,
});
export type ClockStatusSummary = z.infer<typeof ClockStatusSummarySchema>;

export const ClockStatusDetailSchema = ClockStatusSummarySchema.extend({
  measuredOffsetMs: z.number(),
  lastSyncTime: z.number().nullable(),
  syncState: ClockSyncStateSchema,
  serverUsed: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type ClockStatusDetail = z.infer<typeof ClockStatusDetailSchema>;

export const SetClockOffsetRequestSchema = z.object({
  offsetMs: z.number().finite(),
});
export type SetClockOffsetRequest = z.infer<typeof SetClockOffsetRequestSchema>;
