import { z } from 'zod';

export const StationQthSchema = z.object({
  /** Maidenhead grid locator, e.g. "PM01" or "PM01RP" */
  grid: z
    .string()
    .regex(/^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2}([0-9]{2})?)?$/, 'Invalid Maidenhead grid locator')
    .transform((s) => s.toUpperCase())
    .optional()
    .or(z.literal('')),
  /** Human-readable location name, e.g. "Haidian, Beijing" */
  location: z.string().max(100).optional(),
  /** Precise latitude entered by the user (overrides grid-derived center) */
  latitude: z.number().min(-90).max(90).optional(),
  /** Precise longitude entered by the user (overrides grid-derived center) */
  longitude: z.number().min(-180).max(180).optional(),
});

export const StationInfoSchema = z.object({
  /** Station display name, e.g. "BG7XXX Remote Station" */
  name: z.string().max(100).optional(),
  /** Owner callsign, e.g. "BG7XXX" */
  callsign: z.string().max(20).optional(),
  /** Markdown-formatted description (antenna, power, radio model, etc.) */
  description: z.string().max(2000).optional(),
  /** Station QTH location */
  qth: StationQthSchema.optional(),
});

export type StationQth = z.infer<typeof StationQthSchema>;
export type StationInfo = z.infer<typeof StationInfoSchema>;

export const UpdateStationInfoRequestSchema = StationInfoSchema;
export type UpdateStationInfoRequest = StationInfo;

export const StationInfoResponseSchema = z.object({
  success: z.boolean(),
  data: StationInfoSchema,
});
export type StationInfoResponse = z.infer<typeof StationInfoResponseSchema>;
