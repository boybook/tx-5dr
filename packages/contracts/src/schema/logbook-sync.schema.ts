import { z } from 'zod';

/** Page parameters are presentation input, never authorization or credentials. */
export const SyncPageParamsSchema = z.record(z.string().max(100), z.string().max(1000)).superRefine((params, ctx) => {
  if (Object.keys(params).length > 20) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many page parameters' });
  for (const key of Object.keys(params)) {
    if (key.startsWith('_') || ['callsign', 'operatorId', 'launchId', 'auth_token', 'token', 'apiKey', 'pageSessionId'].includes(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reserved page parameter', path: [key] });
    }
  }
});
export const SyncActionSchema = z.object({
  id: z.string().min(1), label: z.string(), description: z.string().optional(),
  icon: z.enum(['download', 'upload', 'sync']).optional(), pageId: z.string().optional(),
  pageParams: SyncPageParamsSchema.optional(), operation: z.enum(['upload', 'download', 'full_sync']).optional(),
}).strict().superRefine((action, ctx) => {
  if (!!action.pageId === !!action.operation || action.pageParams && !action.pageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Declare one operation or page, with parameters only for pages' });
  }
});

/** Provider-owned state. The Host validates and projects it without scheduling work. */
export const SyncStatusSchema = z.object({
  operationId: z.string().min(1).max(200),
  trigger: z.enum(['manual', 'auto']).optional(),
  launchId: z.string().min(1).max(200).optional(),
  /** Changes when the provider instance is recreated, so cached revisions can be discarded. */
  instanceId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  operation: z.enum(['upload', 'download', 'full_sync', 'reconcile']),
  state: z.enum(['idle', 'running', 'waiting', 'pausing', 'paused', 'completed', 'partial_failure', 'failed', 'interrupted']),
  stage: z.enum(['preparing', 'downloading', 'reconciling', 'uploading', 'confirming', 'committing', 'finished']),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  downloaded: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  uploaded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Reserved for provider-reported conflicts; WaveLog reports terminal refusals as `rejected`. */
  conflicts: z.number().int().nonnegative(),
  /** Records the remote refused permanently (duplicate or invalid); they are not retried until edited. */
  rejected: z.number().int().nonnegative().default(0),
  resumable: z.boolean(),
  nextAttemptAt: z.number().finite().optional(),
  lastSuccessAt: z.number().finite().optional(),
  lastConfirmationAt: z.number().finite().optional(),
  autoUploading: z.boolean().optional(),
  automaticUpload: z.object({
    state: z.enum(['running', 'completed', 'partial_failure', 'failed']),
    uploaded: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), updatedAt: z.number().finite(),
  }).strict().optional(),
  // Extra failure fields are tolerated so a public createSyncFailure() value can be
  // projected without silently turning the whole provider status into "unavailable".
  errors: z.array(z.object({ code: z.string().max(100), message: z.string().max(1000), qsoCallsign: z.string().max(100).optional() })).max(20),
}).strict();
export type SyncStatus = z.infer<typeof SyncStatusSchema>;

export const SyncStatusProjectionSchema = z.object({
  supported: z.boolean(),
  available: z.boolean(),
  status: SyncStatusSchema.nullable(),
}).strict();
export type SyncStatusProjection = z.infer<typeof SyncStatusProjectionSchema>;

export const SyncStatusesResponseSchema = z.object({
  providers: z.record(z.string(), SyncStatusProjectionSchema),
}).strict();
export type SyncStatusesResponse = z.infer<typeof SyncStatusesResponseSchema>;
