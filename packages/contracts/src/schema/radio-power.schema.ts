import { z } from 'zod';
import { HamlibConfigSchema } from './radio.schema.js';

/**
 * High-level runtime state tracked by the RadioPowerController.
 *
 * - `off`: radio is known to be off (or was never connected).
 * - `waking`: power-on command sent, waiting for the radio to respond.
 * - `awake`: radio is responding; the engine is being started (if autoEngine).
 * - `shutting_down`: engine is stopping in preparation for a power-off command.
 * - `entering_standby`: powerstat(2) sent, waiting for radio to drop CAT link.
 * - `failed`: last transition failed; UI should show an error + retry.
 */
export const RadioPowerStateSchema = z.enum([
  'off',
  'waking',
  'awake',
  'shutting_down',
  'entering_standby',
  'failed',
]);
export type RadioPowerState = z.infer<typeof RadioPowerStateSchema>;

/**
 * Finer-grained progress stage inside `waking` / `shutting_down`.
 * UI uses this to show progress bar labels.
 */
export const RadioPowerStageSchema = z.enum([
  'idle',
  'sending_command',
  'waiting_ready',
  'waiting_standby_disconnect',
  'starting_engine',
  'stopping_engine',
  'disconnecting',
]);
export type RadioPowerStage = z.infer<typeof RadioPowerStageSchema>;

/**
 * WS event payload: server → client.
 */
export const RadioPowerStateEventSchema = z.object({
  profileId: z.string().optional(),
  state: RadioPowerStateSchema,
  stage: RadioPowerStageSchema,
  /** Translation key reference for an inline error, e.g. 'radio:power.error.timeout'. */
  errorKey: z.string().optional(),
  /** Free-form details for debugging; not user-facing. */
  errorDetail: z.string().optional(),
});
export type RadioPowerStateEvent = z.infer<typeof RadioPowerStateEventSchema>;

/**
 * REST request body: POST /api/radio/power
 */
/** Allowed target states for a power request. */
export const RadioPowerTargetSchema = z.enum(['on', 'off', 'standby', 'operate']);
export type RadioPowerTarget = z.infer<typeof RadioPowerTargetSchema>;

export const RadioPowerRequestSchema = z.object({
  profileId: z.string().min(1),
  state: RadioPowerTargetSchema,
  /** Automatically start the engine after successful power-on. Defaults to true. */
  autoEngine: z.boolean().optional().default(true),
});
export type RadioPowerRequest = z.infer<typeof RadioPowerRequestSchema>;

/**
 * REST response: POST /api/radio/power
 */
export const RadioPowerResponseSchema = z.object({
  success: z.boolean(),
  state: RadioPowerStateSchema,
});
export type RadioPowerResponse = z.infer<typeof RadioPowerResponseSchema>;

/**
 * REST response: GET /api/radio/power/support?profileId=xxx
 * The server resolves mfgName/modelName internally via HamLib.getSupportedRigs().
 */
export const RadioPowerSupportInfoSchema = z.object({
  profileId: z.string(),
  canPowerOn: z.boolean(),
  canPowerOff: z.boolean(),
  /**
   * States the user is allowed to switch *between* while the radio is connected.
   * Empty when the radio is unsupported or not connected (UI then renders no dropdown).
   */
  supportedStates: z.array(z.enum(['operate', 'standby', 'off'])).default([]),
  reason: z.enum(['model-unsupported', 'network-mode-no-wake', 'none-mode']).optional(),
  rigInfo: z
    .object({
      mfgName: z.string(),
      modelName: z.string(),
    })
    .optional(),
});
export type RadioPowerSupportInfo = z.infer<typeof RadioPowerSupportInfoSchema>;

/** Convenience re-export so callers can validate a full config blob. */
export const RadioPowerProfileConfigSchema = HamlibConfigSchema;
