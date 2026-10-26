import { z } from 'zod';
import { PluginDistributionSchema } from './plugin.schema.js';

export const SystemUpdateTargetSchema = z.enum([
  'electron-app',
  'linux-server',
  'docker',
  'android-runtime',
]);
export type SystemUpdateTarget = z.infer<typeof SystemUpdateTargetSchema>;

export const SystemUpdateChannelSchema = z.enum(['release', 'nightly']);
export type SystemUpdateChannel = z.infer<typeof SystemUpdateChannelSchema>;

export const UpdatePreferencesSchema = z.object({ channel: SystemUpdateChannelSchema });
export const UpdateInstallRequestSchema = z.object({
  identity: z.string().min(1),
  allowDowngrade: z.boolean().default(false),
});
export const UpdateSelectionSchema = z.object({
  currentChannel: SystemUpdateChannelSchema.optional(),
  targetChannel: SystemUpdateChannelSchema.optional(),
  availability: z.enum(['available', 'up-to-date', 'empty', 'error']).optional(),
  operation: z.enum(['upgrade', 'switch', 'downgrade', 'reinstall', 'none']).optional(),
  channelEditable: z.boolean().optional(),
  installCommand: z.string().nullable().optional(),
  compatibilityWarnings: z.array(z.string()).optional(),
  stableAvailable: z.boolean().optional(),
});
export type UpdateSelection = z.infer<typeof UpdateSelectionSchema>;

const DownloadUrlSchema = z.string().url().refine(value => new URL(value).protocol === 'https:', 'HTTPS required');
export const ReleaseAssetSchema = z.object({
  name: z.string().min(1).refine(value => !/[\\/]/.test(value) && value !== '..'),
  url: DownloadUrlSchema,
  url_cn: DownloadUrlSchema.optional(),
  url_oss: DownloadUrlSchema.optional(),
  url_global: DownloadUrlSchema.optional(),
  url_github: DownloadUrlSchema.optional(),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  sha512: z.string().optional(),
  platform: z.string(),
  arch: z.string(),
  package_type: z.string(),
  auto_update: z.object({
    supported: z.boolean(), target: z.string().optional(), installerFamily: z.string().optional(),
    sha512: z.string().optional(), blockMapSize: z.number().optional(), minimumSystemVersion: z.string().optional(),
    files: z.array(z.object({ url: z.string().optional(), path: z.string().optional(), sha512: z.string(), size: z.number().optional(), blockMapSize: z.number().optional() }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();

// Absent schema_version identifies the explicitly supported legacy manifest.
export const ReleaseManifestSchema = z.object({
  schema_version: z.literal(1).optional(),
  product: z.enum(['app', 'server', 'docker', 'android-runtime', 'android-bridge']),
  channel: SystemUpdateChannelSchema,
  tag: z.string().min(1),
  version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  commit: z.string().regex(/^[a-fA-F0-9]{7,40}$/),
  published_at: z.string().min(1),
  commit_title: z.string().optional(), release_notes: z.string().optional(),
  docker_digest: z.string().optional(), docker_image: z.string().optional(),
  assets: z.array(ReleaseAssetSchema).default([]),
  recent_commits: z.array(z.object({ id: z.string(), short_id: z.string(), title: z.string(), published_at: z.string().optional() })).optional(),
}).passthrough().superRefine((manifest, context) => {
  if (manifest.schema_version === 1 && manifest.commit.length !== 40) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['commit'], message: 'Versioned manifests require the full source commit' });
  }
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export const SystemUpdateStatusSchema = UpdateSelectionSchema.extend({
  target: SystemUpdateTargetSchema,
  distribution: PluginDistributionSchema,
  channel: SystemUpdateChannelSchema,
  currentVersion: z.string(),
  currentCommit: z.string().nullable(),
  currentPublishedAt: z.string().nullable(),
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
