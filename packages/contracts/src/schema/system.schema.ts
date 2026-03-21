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
