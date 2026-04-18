import { z } from 'zod';

/**
 * rigctld-compatible TCP bridge configuration.
 *
 * Disabled by default — opening a TCP port that accepts CAT control without
 * authentication is a sensitive default, so users must opt in.
 */
export const RigctldBridgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bindAddress: z.string().default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(4532),
  /**
   * When true (default), the bridge rejects every write command
   * (`F`/`M`/`T`/`S`/`L`/`set_*`) with `RPRT -11` and only allows reads.
   * Covers the safe "N1MM records QSOs while the operator tunes manually"
   * workflow. Disable only when you need software like N1MM / WSJT-X to
   * actively control the rig (set frequency, PTT, split).
   */
  readOnly: z.boolean().default(true),
});

export type RigctldBridgeConfig = z.infer<typeof RigctldBridgeConfigSchema>;

export const DEFAULT_RIGCTLD_BRIDGE_CONFIG: RigctldBridgeConfig = {
  enabled: false,
  bindAddress: '0.0.0.0',
  port: 4532,
  readOnly: true,
};

/** Per-connection client snapshot used by the status API and UI. */
export const RigctldClientSnapshotSchema = z.object({
  id: z.number().int(),
  peer: z.string(),
  connectedAt: z.number().int(),
  lastCommand: z.string().optional(),
  lastCommandAt: z.number().int().optional(),
});

export type RigctldClientSnapshot = z.infer<typeof RigctldClientSnapshotSchema>;

export const RigctldStatusSchema = z.object({
  config: RigctldBridgeConfigSchema,
  running: z.boolean(),
  address: z.object({ host: z.string(), port: z.number().int() }).optional(),
  clients: z.array(RigctldClientSnapshotSchema),
  error: z.string().optional(),
});

export type RigctldStatus = z.infer<typeof RigctldStatusSchema>;
