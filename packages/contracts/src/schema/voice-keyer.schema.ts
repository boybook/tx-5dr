import { z } from 'zod';

export const VoiceKeyerSlotSchema = z.object({
  id: z.string(),
  index: z.number().int().min(1),
  label: z.string(),
  hasAudio: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  updatedAt: z.number().nullable(),
  repeatEnabled: z.boolean(),
  repeatIntervalSec: z.number().int().min(1).max(300),
});

export const VoiceKeyerPanelSchema = z.object({
  callsign: z.string(),
  slotCount: z.number().int().min(3).max(12),
  maxSlotCount: z.number().int().min(12),
  slots: z.array(VoiceKeyerSlotSchema),
});

export const VoiceKeyerStatusSchema = z.object({
  active: z.boolean(),
  callsign: z.string().nullable(),
  slotId: z.string().nullable(),
  mode: z.enum(['idle', 'playing', 'repeat-waiting', 'stopping', 'error']),
  repeating: z.boolean(),
  startedBy: z.string().nullable(),
  startedByLabel: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  error: z.string().nullable(),
});

export const VoiceKeyerSlotUpdateSchema = z.object({
  label: z.string().max(32).optional(),
  repeatEnabled: z.boolean().optional(),
  repeatIntervalSec: z.number().int().min(1).max(300).optional(),
});

export const VoiceKeyerPanelUpdateSchema = z.object({
  slotCount: z.number().int().min(3).max(12),
});

export const VoiceKeyerPlayRequestSchema = z.object({
  callsign: z.string(),
  slotId: z.string(),
  repeat: z.boolean().optional(),
});

export type VoiceKeyerSlot = z.infer<typeof VoiceKeyerSlotSchema>;
export type VoiceKeyerPanel = z.infer<typeof VoiceKeyerPanelSchema>;
export type VoiceKeyerStatus = z.infer<typeof VoiceKeyerStatusSchema>;
export type VoiceKeyerSlotUpdate = z.infer<typeof VoiceKeyerSlotUpdateSchema>;
export type VoiceKeyerPanelUpdate = z.infer<typeof VoiceKeyerPanelUpdateSchema>;
export type VoiceKeyerPlayRequest = z.infer<typeof VoiceKeyerPlayRequestSchema>;
