import { z } from 'zod';

export const NoRadioConfigSchema = z.object({
  type: z.literal('none'),
});

export const HamlibNetworkConfigSchema = z.object({
  type: z.literal('network'),
  host: z.string(),
  port: z.number(),
});

export const HamlibSerialConfigSchema = z.object({
  type: z.literal('serial'),
  rigModel: z.number(),
  path: z.string(),
  baudRate: z.number().optional(),
});

export const HamlibConfigSchema = z.discriminatedUnion('type', [
  NoRadioConfigSchema,
  HamlibNetworkConfigSchema,
  HamlibSerialConfigSchema,
]);

export const RadioConfigSchema = z.object({
  rig: HamlibConfigSchema,
});

export type HamlibConfig = z.infer<typeof HamlibConfigSchema>;
export type RadioConfig = z.infer<typeof RadioConfigSchema>;
