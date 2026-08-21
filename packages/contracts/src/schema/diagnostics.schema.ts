import { z } from 'zod';

export const DiagnosticLogSourceIdSchema = z.enum(['server', 'electron-main', 'client-tools']);
export type DiagnosticLogSourceId = z.infer<typeof DiagnosticLogSourceIdSchema>;

export const DiagnosticLogSourceSchema = z.object({
  id: DiagnosticLogSourceIdSchema,
  fileName: z.string().min(1),
  fileCount: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
  availableFromMs: z.number().int().positive().nullable(),
  availableToMs: z.number().int().positive().nullable(),
});
export type DiagnosticLogSource = z.infer<typeof DiagnosticLogSourceSchema>;

export const DiagnosticLogSourcesResponseSchema = z.object({
  sources: z.array(DiagnosticLogSourceSchema),
  limits: z.object({
    maxRangeMs: z.number().int().positive(),
    maxUncompressedBytes: z.number().int().positive(),
    maxCompressedBytes: z.number().int().positive(),
    feedbackMaxCharacters: z.number().int().positive(),
  }),
});
export type DiagnosticLogSourcesResponse = z.infer<typeof DiagnosticLogSourcesResponseSchema>;

export const CreateDiagnosticUploadRequestSchema = z.object({
  sourceId: DiagnosticLogSourceIdSchema,
  fromMs: z.number().int().positive(),
  toMs: z.number().int().positive(),
  feedback: z.string().trim().max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.toMs <= value.fromMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['toMs'], message: 'toMs must be later than fromMs' });
  }
  if (value.toMs - value.fromMs > 7 * 24 * 60 * 60 * 1000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['toMs'], message: 'time range exceeds seven days' });
  }
});
export type CreateDiagnosticUploadRequest = z.infer<typeof CreateDiagnosticUploadRequestSchema>;

export const DiagnosticUploadReceiptSchema = z.object({
  uploadId: z.string().uuid(),
  sourceId: DiagnosticLogSourceIdSchema,
  requestedFromMs: z.number().int().positive(),
  requestedToMs: z.number().int().positive(),
  includedFromMs: z.number().int().positive(),
  includedToMs: z.number().int().positive(),
  lineCount: z.number().int().positive(),
  uncompressedBytes: z.number().int().positive(),
  compressedBytes: z.number().int().positive(),
  acceptedAt: z.string().datetime(),
  retainedUntil: z.string().datetime(),
});
export type DiagnosticUploadReceipt = z.infer<typeof DiagnosticUploadReceiptSchema>;
