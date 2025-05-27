import { z } from 'zod';

// FT8配置更新schema
export const FT8ConfigUpdateSchema = z.object({
  myCallsign: z.string().optional(),
  myGrid: z.string().optional(),
  frequency: z.number().optional(),
  transmitPower: z.number().min(1).max(100).optional(),
  autoReply: z.boolean().optional(),
  maxQSOTimeout: z.number().min(1).optional(),
});

// 服务器配置更新schema
export const ServerConfigUpdateSchema = z.object({
  port: z.number().min(1).max(65535).optional(),
  host: z.string().optional(),
});

export type FT8ConfigUpdate = z.infer<typeof FT8ConfigUpdateSchema>;
export type ServerConfigUpdate = z.infer<typeof ServerConfigUpdateSchema>;