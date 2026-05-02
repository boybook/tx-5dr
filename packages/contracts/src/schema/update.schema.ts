import { z } from 'zod';
import { PluginDistributionSchema } from './plugin.schema.js';

export const SystemUpdateTargetSchema = z.enum([
  'electron-app',
  'linux-server',
  'docker',
]);
export type SystemUpdateTarget = z.infer<typeof SystemUpdateTargetSchema>;

export const SystemUpdateChannelSchema = z.enum(['release', 'nightly']);
export type SystemUpdateChannel = z.infer<typeof SystemUpdateChannelSchema>;

export const SystemUpdateStatusSchema = z.object({
  target: SystemUpdateTargetSchema,
  distribution: PluginDistributionSchema,
  channel: SystemUpdateChannelSchema,
  currentVersion: z.string(),
  currentCommit: z.string().nullable(),
  currentDigest: z.string().nullable().optional(),
  latestVersion: z.string().nullable(),
  latestCommit: z.string().nullable(),
  latestDigest: z.string().nullable().optional(),
  latestCommitTitle: z.string().nullable(),
  publishedAt: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  updateAvailable: z.boolean(),
  identity: z.string().nullable(),
  websiteUrl: z.string().url(),
  metadataSource: z.enum(['oss', 'github']).nullable(),
  errorMessage: z.string().nullable(),
});
export type SystemUpdateStatus = z.infer<typeof SystemUpdateStatusSchema>;
