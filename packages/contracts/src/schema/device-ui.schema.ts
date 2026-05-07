import { z } from 'zod';

export const DeviceUiPageSchema = z.enum([
  'boot',
  'access',
  'network-overview',
  'wifi-scan',
  'wifi-password',
  'hotspot',
  'monitor',
  'diagnostics',
  'dialog',
]);
export type DeviceUiPage = z.infer<typeof DeviceUiPageSchema>;

export const DeviceUiNetworkKindSchema = z.enum(['ethernet', 'wifi', 'hotspot', 'offline']);
export type DeviceUiNetworkKind = z.infer<typeof DeviceUiNetworkKindSchema>;

export const DeviceUiNetworkSummarySchema = z.object({
  kind: DeviceUiNetworkKindSchema,
  connected: z.boolean(),
  interfaceName: z.string().nullable(),
  ssid: z.string().nullable().optional(),
  ipAddress: z.string().nullable(),
  signalPercent: z.number().min(0).max(100).nullable().optional(),
  helperAvailable: z.boolean(),
  message: z.string().optional(),
});
export type DeviceUiNetworkSummary = z.infer<typeof DeviceUiNetworkSummarySchema>;

export const DeviceUiAccessSummarySchema = z.object({
  url: z.string().url().nullable(),
  qrText: z.string().nullable(),
  pairingCode: z.string().regex(/^\d{6}$/).nullable(),
  pairingExpiresAt: z.number().nullable(),
  browserClientCount: z.number().int().min(0),
});
export type DeviceUiAccessSummary = z.infer<typeof DeviceUiAccessSummarySchema>;

export const DeviceUiRadioSummarySchema = z.object({
  serverConnected: z.boolean(),
  engineState: z.enum(['idle', 'starting', 'running', 'stopping', 'unknown']),
  radioConnected: z.boolean(),
  frequencyHz: z.number().nullable(),
  mode: z.string().nullable(),
  band: z.string().nullable(),
  pttActive: z.boolean(),
  txOperatorIds: z.array(z.string()),
  txText: z.string().nullable(),
  slotSecondsRemaining: z.number().min(0).nullable(),
});
export type DeviceUiRadioSummary = z.infer<typeof DeviceUiRadioSummarySchema>;

export const DeviceUiRecentMessageSchema = z.object({
  id: z.string(),
  timestamp: z.number(),
  direction: z.enum(['rx', 'tx']),
  text: z.string(),
  callsign: z.string().nullable().optional(),
  related: z.boolean(),
  snr: z.number().nullable().optional(),
});
export type DeviceUiRecentMessage = z.infer<typeof DeviceUiRecentMessageSchema>;

export const DeviceUiSpectrumSummarySchema = z.object({
  timestamp: z.number(),
  bins: z.array(z.number().min(0).max(1)).max(128),
  peakBin: z.number().int().min(0).nullable(),
});
export type DeviceUiSpectrumSummary = z.infer<typeof DeviceUiSpectrumSummarySchema>;

export const DeviceUiModelSchema = z.object({
  schemaVersion: z.literal(1),
  page: DeviceUiPageSchema,
  updatedAt: z.number(),
  device: z.object({
    id: z.string(),
    profile: z.string(),
    renderer: z.string(),
  }),
  network: DeviceUiNetworkSummarySchema,
  access: DeviceUiAccessSummarySchema,
  radio: DeviceUiRadioSummarySchema,
  spectrum: DeviceUiSpectrumSummarySchema,
  recentMessages: z.array(DeviceUiRecentMessageSchema).max(20),
  alert: z.object({
    level: z.enum(['info', 'warn', 'error']),
    text: z.string(),
  }).nullable(),
});
export type DeviceUiModel = z.infer<typeof DeviceUiModelSchema>;

export const DeviceUiPatchOpSchema = z.discriminatedUnion('path', [
  z.object({ path: z.literal('page'), value: DeviceUiPageSchema }),
  z.object({ path: z.literal('network'), value: DeviceUiNetworkSummarySchema }),
  z.object({ path: z.literal('access'), value: DeviceUiAccessSummarySchema }),
  z.object({ path: z.literal('radio'), value: DeviceUiRadioSummarySchema }),
  z.object({ path: z.literal('spectrum'), value: DeviceUiSpectrumSummarySchema }),
  z.object({ path: z.literal('recentMessages'), value: z.array(DeviceUiRecentMessageSchema).max(20) }),
  z.object({ path: z.literal('alert'), value: DeviceUiModelSchema.shape.alert }),
]);
export type DeviceUiPatchOp = z.infer<typeof DeviceUiPatchOpSchema>;

export const DeviceServiceJwtPayloadSchema = z.object({
  sub: z.string(),
  deviceId: z.string(),
  aud: z.literal('tx5dr-device-ui'),
  scope: z.literal('device-ui'),
  iat: z.number(),
  exp: z.number(),
});
export type DeviceServiceJwtPayload = z.infer<typeof DeviceServiceJwtPayloadSchema>;

export const DeviceUiSessionRequestSchema = z.object({
  deviceToken: z.string().min(16).optional(),
  deviceId: z.string().optional(),
  profile: z.string().optional(),
});
export type DeviceUiSessionRequest = z.infer<typeof DeviceUiSessionRequestSchema>;

export const DeviceUiSessionResponseSchema = z.object({
  jwt: z.string(),
  deviceId: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type DeviceUiSessionResponse = z.infer<typeof DeviceUiSessionResponseSchema>;

export const DeviceUiBootstrapResponseSchema = z.object({
  model: DeviceUiModelSchema,
});
export type DeviceUiBootstrapResponse = z.infer<typeof DeviceUiBootstrapResponseSchema>;

export const DeviceUiPairingCodeResponseSchema = z.object({
  id: z.string(),
  code: z.string().regex(/^\d{6}$/),
  expiresAt: z.number(),
});
export type DeviceUiPairingCodeResponse = z.infer<typeof DeviceUiPairingCodeResponseSchema>;

export const DeviceUiPairingConsumeRequestSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type DeviceUiPairingConsumeRequest = z.infer<typeof DeviceUiPairingConsumeRequestSchema>;

export const DeviceUiPairingConsumeResponseSchema = z.object({
  jwt: z.string(),
  role: z.literal('viewer'),
  expiresAt: z.number(),
});
export type DeviceUiPairingConsumeResponse = z.infer<typeof DeviceUiPairingConsumeResponseSchema>;

export const DeviceUiServerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state.replace'), data: DeviceUiModelSchema }),
  z.object({ type: z.literal('state.patch'), data: z.object({ ops: z.array(DeviceUiPatchOpSchema).min(1) }) }),
  z.object({ type: z.literal('spectrum.update'), data: DeviceUiSpectrumSummarySchema }),
  z.object({ type: z.literal('access.update'), data: DeviceUiAccessSummarySchema }),
]);
export type DeviceUiServerEvent = z.infer<typeof DeviceUiServerEventSchema>;

export const DeviceUiHealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('tx5dr-device-ui'),
  time: z.string(),
});
export type DeviceUiHealthResponse = z.infer<typeof DeviceUiHealthResponseSchema>;
