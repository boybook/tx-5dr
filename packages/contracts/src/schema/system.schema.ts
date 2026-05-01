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
  autoApplyOffset: z.boolean(),
});
export type ClockStatusDetail = z.infer<typeof ClockStatusDetailSchema>;

export const SetClockOffsetRequestSchema = z.object({
  offsetMs: z.number().finite(),
});
export type SetClockOffsetRequest = z.infer<typeof SetClockOffsetRequestSchema>;

export const SetClockAutoApplyRequestSchema = z.object({
  enabled: z.boolean(),
});
export type SetClockAutoApplyRequest = z.infer<typeof SetClockAutoApplyRequestSchema>;

// ===== NTP server list settings =====

function isValidIPv4Address(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    return Number.isInteger(num) && num >= 0 && num <= 255;
  });
}

function isValidHostname(value: string): boolean {
  if (value === 'localhost') return true;
  if (value.length > 253) return false;
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(value)) return false;

  const labels = value.split('.');
  return labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && !label.startsWith('-')
    && !label.endsWith('-')
    && /^[A-Za-z0-9-]+$/.test(label)
  ));
}

export function isValidNtpServerHost(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (
    trimmed.includes('://')
    || trimmed.includes('/')
    || trimmed.includes('?')
    || trimmed.includes('#')
    || trimmed.includes(':')
    || trimmed.includes('[')
    || trimmed.includes(']')
  ) {
    return false;
  }

  return isValidIPv4Address(trimmed) || isValidHostname(trimmed);
}

export const NtpServerHostSchema = z.string().trim().min(1).refine(isValidNtpServerHost, {
  message: 'Invalid NTP server host',
});

const NtpServerArraySchema = z.array(NtpServerHostSchema).min(1).superRefine((servers, ctx) => {
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate NTP server: ${server}`,
      });
      return;
    }
    seen.add(server);
  }
});

export const NtpServerListSettingsSchema = z.object({
  servers: NtpServerArraySchema,
  defaultServers: NtpServerArraySchema,
});
export type NtpServerListSettings = z.infer<typeof NtpServerListSettingsSchema>;

export const UpdateNtpServerListRequestSchema = z.object({
  servers: NtpServerArraySchema,
});
export type UpdateNtpServerListRequest = z.infer<typeof UpdateNtpServerListRequestSchema>;
