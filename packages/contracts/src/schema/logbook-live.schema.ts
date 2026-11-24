import { z } from 'zod';
import { FT8MessageTypeSchema } from './ft8.schema.js';
import { LogbookAnalysisSchema } from './slot-info.schema.js';

/** Where a decoded station is drawn on the logbook globe. */
export const LogbookLiveLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  /** `grid`: from a Maidenhead locator; `entity`: the DXCC entity centre, approximate. */
  precision: z.enum(['grid', 'entity']),
});

/** One station heard in a receive slot, analysed against the operator's logbook. */
export const LogbookLiveDecodeSchema = z.object({
  callsign: z.string(),
  message: z.string(),
  messageType: FT8MessageTypeSchema,
  /** Station the message is addressed to, for directed calls and reports. */
  targetCallsign: z.string().optional(),
  snr: z.number(),
  dt: z.number(),
  /** Audio offset in Hz. */
  freq: z.number(),
  location: LogbookLiveLocationSchema.optional(),
  analysis: LogbookAnalysisSchema.optional(),
});

/**
 * Decodes of one receive slot for a logbook page (logbook WS only). A slot is
 * sent again as later decode windows add frames; each update replaces the
 * slot's earlier decodes.
 */
export const LogbookLiveDecodesUpdateSchema = z.object({
  operatorId: z.string(),
  slotId: z.string(),
  slotStartMs: z.number(),
  /** Slot length in ms, used to age decodes by cycles. */
  slotMs: z.number().positive(),
  mode: z.string().optional(),
  band: z.string().optional(),
  frequency: z.number().optional(),
  decodes: z.array(LogbookLiveDecodeSchema),
});

/** Feature a logbook connection announces when it accepts {@link LogbookSelectTargetCommandSchema}. */
export const LOGBOOK_SELECT_TARGET_FEATURE = 'logbookSelectTarget';

/** The decoded frame a target is picked from; the strategy answers it. */
// Bounds are generous for real decodes and keep oversized input out of the
// message parser (an FT8 message is at most 37 characters).
export const LogbookSelectedFrameSchema = z.object({
  message: z.string().max(80),
  snr: z.number().min(-100).max(100),
  dt: z.number().min(-60).max(60),
  freq: z.number().min(0).max(100_000),
  slotStartMs: z.number().int().nonnegative(),
});

/**
 * Makes a heard station the operator's QSO target from a logbook page. The
 * server answers it the way the operator's strategy takes targets: a direct
 * call, or a queue entry.
 */
export const LogbookSelectTargetCommandSchema = z.object({
  requestId: z.string().min(1).max(64),
  operatorId: z.string().min(1).max(64),
  callsign: z.string().min(1).max(32),
  selectedFrame: LogbookSelectedFrameSchema,
});

export const LogbookSelectTargetResultSchema = z.object({
  requestId: z.string(),
  operatorId: z.string(),
  callsign: z.string(),
  /** `called`: now the target; `queued`: added to the operator's target queue. */
  status: z.enum(['called', 'queued', 'rejected']),
  /** Machine-readable rejection reason. */
  reason: z.string().optional(),
  /** i18n key (namespace:key) explaining a rejection. */
  userMessageKey: z.string().optional(),
});

export type LogbookSelectedFrame = z.infer<typeof LogbookSelectedFrameSchema>;
export type LogbookSelectTargetCommand = z.infer<typeof LogbookSelectTargetCommandSchema>;
export type LogbookSelectTargetResult = z.infer<typeof LogbookSelectTargetResultSchema>;
export type LogbookLiveLocation = z.infer<typeof LogbookLiveLocationSchema>;
export type LogbookLiveDecode = z.infer<typeof LogbookLiveDecodeSchema>;
export type LogbookLiveDecodesUpdate = z.infer<typeof LogbookLiveDecodesUpdateSchema>;
