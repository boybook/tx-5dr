import { z } from 'zod';

export const IncompleteQsoMessageSchema = z.object({
  slotStartMs: z.number().int().nonnegative(),
  direction: z.enum(['rx', 'tx']),
  text: z.string().min(1),
  audioOffsetHz: z.number(),
  snr: z.number().optional(),
  confidence: z.number().optional(),
});

export const IncompleteQsoCandidateSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  logBookId: z.string().min(1),
  operatorId: z.string().min(1),
  myCallsign: z.string().min(1),
  callsign: z.string().min(1),
  mode: z.enum(['FT8', 'FT4']),
  frequency: z.number().positive(),
  startTime: z.number().int().nonnegative(),
  endTime: z.number().int().nonnegative(),
  reportSent: z.string(),
  reportReceived: z.string(),
  messages: z.array(IncompleteQsoMessageSchema),
  status: z.enum(['pending', 'recorded', 'dismissed']),
  linkedQsoId: z.string().optional(),
  commitRequested: z.boolean().optional(),
  syncQueued: z.boolean().optional(),
});

export const IncompleteQsoQuerySchema = z.object({
  status: z.enum(['pending', 'recorded', 'dismissed']).default('pending'),
  callsign: z.string().optional(),
  mode: z.enum(['FT8', 'FT4']).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const IncompleteQsoSummarySchema = IncompleteQsoCandidateSchema.pick({
  id: true, revision: true, logBookId: true, myCallsign: true, callsign: true,
  mode: true, frequency: true, startTime: true, endTime: true, status: true,
  linkedQsoId: true, commitRequested: true, syncQueued: true,
});

export const IncompleteQsoSelectionSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }))
    .min(1).max(100),
}).refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, {
  message: 'Candidate IDs must be unique',
});

export const IncompleteQsoPreviewItemSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  disposition: z.enum(['ready', 'duplicate', 'changed', 'invalid', 'recorded']),
  qsoId: z.string().optional(),
  candidate: IncompleteQsoCandidateSchema.nullable(),
});

export const IncompleteQsoJobItemSchema = z.object({
  id: z.string().uuid(),
  disposition: z.enum(['pending', 'recorded', 'duplicate', 'changed', 'invalid', 'failed', 'not_attempted']),
  qsoId: z.string().optional(),
  error: z.string().optional(),
});

export const IncompleteQsoJobSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(['running', 'finished']),
  items: z.array(IncompleteQsoJobItemSchema),
});

export const IncompleteQsoListResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({ items: z.array(IncompleteQsoSummarySchema), nextCursor: z.string().optional() }),
});
export const IncompleteQsoDetailResponseSchema = z.object({
  success: z.boolean(), data: IncompleteQsoCandidateSchema.nullable(),
});
export const IncompleteQsoPreviewResponseSchema = z.object({
  success: z.boolean(), data: z.object({ items: z.array(IncompleteQsoPreviewItemSchema) }),
});
export const IncompleteQsoJobResponseSchema = z.object({
  success: z.boolean(), data: IncompleteQsoJobSchema.nullable(),
});
export const IncompleteQsoHealthResponseSchema = z.object({
  success: z.boolean(), data: z.object({
    state: z.enum(['ready', 'loading', 'unavailable']), dropped: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),
});
export const IncompleteQsoCommitResponseSchema = z.object({
  success: z.literal(true), data: z.object({ jobId: z.string().uuid() }),
});
export const IncompleteQsoDismissResponseSchema = z.object({
  success: z.literal(true), data: z.object({
    items: z.array(z.object({ id: z.string().uuid(), status: z.enum(['dismissed', 'changed']) })),
  }),
});
export const IncompleteQsoRetrySyncResponseSchema = z.object({
  success: z.boolean(), data: z.object({ queued: z.boolean() }),
});

export type IncompleteQsoMessage = z.infer<typeof IncompleteQsoMessageSchema>;
export type IncompleteQsoCandidate = z.infer<typeof IncompleteQsoCandidateSchema>;
export type IncompleteQsoQuery = z.infer<typeof IncompleteQsoQuerySchema>;
export type IncompleteQsoSummary = z.infer<typeof IncompleteQsoSummarySchema>;
export type IncompleteQsoSelection = z.infer<typeof IncompleteQsoSelectionSchema>;
export type IncompleteQsoPreviewItem = z.infer<typeof IncompleteQsoPreviewItemSchema>;
export type IncompleteQsoJob = z.infer<typeof IncompleteQsoJobSchema>;
