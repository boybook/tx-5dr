import { z } from 'zod';
import { DesktopStationKindSchema, StationIdentitySchema } from './station-identity.schema.js';

/**
 * Station list and connection state of the desktop shell, sent from the
 * Electron main process to the shell's own station manager page. Remote station
 * pages only ever see {@link DesktopCurrentStationSchema} for themselves.
 */

export const DesktopCertificateSummarySchema = z.object({
  fingerprint256: z.string(),
  subject: z.string().nullable(),
  issuer: z.string().nullable(),
  validTo: z.string().nullable(),
});
export type DesktopCertificateSummary = z.infer<typeof DesktopCertificateSummarySchema>;

export const DesktopStationConnectErrorKindSchema = z.enum([
  'unreachable',
  'not-a-station',
  'bridge-too-old',
  'redirect',
  'gateway',
  'load',
  'certificate-changed',
]);
export type DesktopStationConnectErrorKind = z.infer<typeof DesktopStationConnectErrorKindSchema>;

export const DesktopStationConnectStateSchema = z.object({
  stationId: z.string(),
  phase: z.enum(['probing', 'gateway', 'loading', 'connected', 'needs-trust', 'failed']),
  error: z.object({
    kind: DesktopStationConnectErrorKindSchema,
    code: z.string().optional(),
    location: z.string().optional(),
    required: z.number().optional(),
  }).optional(),
  certificate: DesktopCertificateSummarySchema.optional(),
  changed: z.object({ expected: z.string(), actual: z.string().nullable() }).optional(),
  notice: z.literal('portReassigned').optional(),
});
export type DesktopStationConnectState = z.infer<typeof DesktopStationConnectStateSchema>;

export const DesktopRemoteStationViewSchema = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  pinnedFingerprint256: z.string().nullable(),
  lastIdentity: z.object({
    instanceId: z.string(),
    hostVersion: z.string(),
    seenAt: z.string(),
  }).nullable(),
});
export type DesktopRemoteStationView = z.infer<typeof DesktopRemoteStationViewSchema>;

export const DesktopDiscoveredStationSchema = z.object({
  instanceId: z.string(),
  label: z.string(),
  url: z.string(),
  hostVersion: z.string().nullable(),
  /** Saved profile already pointing at this station, if any. */
  profileId: z.string().nullable(),
});
export type DesktopDiscoveredStation = z.infer<typeof DesktopDiscoveredStationSchema>;

export const DesktopEmbeddedStationStatusSchema = z.enum(['idle', 'starting', 'ready', 'failed']);
export type DesktopEmbeddedStationStatus = z.infer<typeof DesktopEmbeddedStationStatusSchema>;

export const DesktopStationsStateSchema = z.object({
  /** Last opened or focused station; opened first on the next launch. */
  activeStationId: z.string(),
  /** Stations that currently have a station window. */
  openStationIds: z.array(z.string()),
  embedded: z.object({
    id: z.string(),
    status: DesktopEmbeddedStationStatusSchema,
    error: z.object({ title: z.string(), message: z.string() }).nullable(),
  }),
  profiles: z.array(DesktopRemoteStationViewSchema),
  connections: z.record(z.string(), DesktopStationConnectStateSchema),
  discovered: z.array(DesktopDiscoveredStationSchema),
});
export type DesktopStationsState = z.infer<typeof DesktopStationsStateSchema>;

export const DesktopStationProbeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('invalid-url'), reason: z.string() }),
  z.object({ kind: z.literal('ok'), url: z.string(), identity: StationIdentitySchema, tls: z.enum(['none', 'system', 'pinned']) }),
  z.object({ kind: z.literal('certificate-untrusted'), url: z.string(), certificate: DesktopCertificateSummarySchema, reason: z.string() }),
  z.object({ kind: z.literal('certificate-changed'), url: z.string(), expected: z.string(), actual: z.string().nullable() }),
  z.object({ kind: z.literal('not-a-station'), url: z.string(), status: z.number().nullable() }),
  z.object({ kind: z.literal('bridge-too-old'), url: z.string(), identity: StationIdentitySchema, required: z.number() }),
  z.object({ kind: z.literal('redirect'), url: z.string(), location: z.string() }),
  z.object({ kind: z.literal('unreachable'), url: z.string(), code: z.string() }),
]);
export type DesktopStationProbeResult = z.infer<typeof DesktopStationProbeResultSchema>;

/** What a station page learns about the station it belongs to. */
export const DesktopCurrentStationSchema = z.object({
  stationId: z.string(),
  kind: DesktopStationKindSchema,
  /** Name the user gave a remote station; null for the embedded station. */
  label: z.string().nullable(),
  /** Remote station address as the user entered it; null for the embedded station. */
  url: z.string().nullable(),
});
export type DesktopCurrentStation = z.infer<typeof DesktopCurrentStationSchema>;
