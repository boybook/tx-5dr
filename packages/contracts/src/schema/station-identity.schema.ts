import { z } from 'zod';
import { AuthStatusSchema } from './auth.schema.js';
import { PluginDistributionSchema } from './plugin.schema.js';

/**
 * Version of the desktop shell bridge implemented by this contracts release.
 *
 * The desktop shell loads the Web UI served by the station it connects to, so
 * the UI and the station are always the same build. The only contract that
 * crosses builds is this bridge (shell capabilities exposed to the page) and the
 * station identity below. Add new capabilities to
 * {@link DesktopBridgeCapabilitySchema}; bump this number only for a change an
 * older shell cannot satisfy.
 */
export const DESKTOP_BRIDGE_VERSION = 1;

/** Version of the public station identity document. */
export const STATION_IDENTITY_VERSION = 1;

/** Named shell capabilities a station page may feature-detect. */
export const DesktopBridgeCapabilitySchema = z.enum([
  'windows',
  'externalLinks',
  'saveFile',
  'selectPath',
  'openAppDirectory',
  'appInfo',
  'appLifecycle',
  'closeBehavior',
  'shortcuts',
  'desktopUpdates',
  'desktopHttps',
  'desktopRemoteAccess',
  'startupLogs',
  /** Open the shell's station manager. */
  'stations',
  /** Manage, probe and switch stations; local shell pages only. */
  'stationManagement',
]);
export type DesktopBridgeCapability = z.infer<typeof DesktopBridgeCapabilitySchema>;

/** Whether the shell is showing its own embedded station or a remote one. */
export const DesktopStationKindSchema = z.enum(['embedded', 'remote']);
export type DesktopStationKind = z.infer<typeof DesktopStationKindSchema>;

export const DesktopBridgeInfoSchema = z.object({
  version: z.number().int().positive(),
  kind: DesktopStationKindSchema,
  capabilities: z.array(DesktopBridgeCapabilitySchema),
});
export type DesktopBridgeInfo = z.infer<typeof DesktopBridgeInfoSchema>;

/**
 * Public, unauthenticated identity of a TX-5DR station
 * (`GET /api/station/identity`).
 *
 * It identifies the build so a desktop shell can decide whether it can host the
 * station's UI. It deliberately carries no filesystem paths, network addresses,
 * callsigns or credentials.
 */
export const StationIdentitySchema = z.object({
  identityVersion: z.literal(STATION_IDENTITY_VERSION),
  product: z.literal('tx5dr'),
  /** Random identifier generated per station installation; not a telemetry ID. */
  instanceId: z.string().uuid(),
  hostVersion: z.string().min(1),
  sourceSha: z.string().min(1),
  channel: z.enum(['release', 'nightly']),
  distribution: PluginDistributionSchema,
  auth: AuthStatusSchema,
  desktopBridge: z.object({
    /** Lowest {@link DESKTOP_BRIDGE_VERSION} this station's UI requires. */
    minVersion: z.number().int().positive(),
  }),
});
export type StationIdentity = z.infer<typeof StationIdentitySchema>;
