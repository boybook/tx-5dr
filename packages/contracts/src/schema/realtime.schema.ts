import { z } from 'zod';

export const RealtimeScopeSchema = z.enum(['radio', 'openwebrx-preview']);
export type RealtimeScope = z.infer<typeof RealtimeScopeSchema>;

export const RealtimeParticipantKindSchema = z.enum(['listener', 'publisher', 'bridge']);
export type RealtimeParticipantKind = z.infer<typeof RealtimeParticipantKindSchema>;

export const RealtimeTransportKindSchema = z.enum(['livekit', 'ws-compat']);
export type RealtimeTransportKind = z.infer<typeof RealtimeTransportKindSchema>;

export const RealtimeSessionDirectionSchema = z.enum(['recv', 'send']);
export type RealtimeSessionDirection = z.infer<typeof RealtimeSessionDirectionSchema>;

export const RealtimeConnectivityErrorCodeSchema = z.enum([
  'TOKEN_REQUEST_FAILED',
  'SIGNALING_UNREACHABLE',
  'PUBLIC_URL_MISCONFIGURED',
  'ICE_CONNECTION_FAILED',
  'NO_AUDIO_TRACK',
  'AUDIO_PLAYBACK_BLOCKED',
  'SESSION_EXPIRED_OR_INVALID',
  'MEDIA_DEVICE_PERMISSION_DENIED',
  'UNKNOWN_REALTIME_ERROR',
]);
export type RealtimeConnectivityErrorCode = z.infer<typeof RealtimeConnectivityErrorCodeSchema>;

export const RealtimeConnectivityHintsSchema = z.object({
  signalingUrl: z.string(),
  signalingPort: z.number().int().positive(),
  rtcTcpPort: z.number().int().positive(),
  udpPortRange: z.string(),
  publicUrlOverrideActive: z.boolean(),
});
export type RealtimeConnectivityHints = z.infer<typeof RealtimeConnectivityHintsSchema>;

export const RealtimeConnectivityIssueSchema = z.object({
  code: RealtimeConnectivityErrorCodeSchema,
  scope: RealtimeScopeSchema,
  stage: z.enum(['token', 'connect', 'publish', 'subscribe', 'runtime']),
  userMessage: z.string(),
  suggestions: z.array(z.string()),
  technicalDetails: z.string().optional(),
  context: z.record(z.string()).optional(),
});
export type RealtimeConnectivityIssue = z.infer<typeof RealtimeConnectivityIssueSchema>;

export const RealtimeTokenRequestSchema = z.object({
  scope: RealtimeScopeSchema,
  publish: z.boolean().optional(),
  previewSessionId: z.string().optional(),
});

export type RealtimeTokenRequest = z.infer<typeof RealtimeTokenRequestSchema>;

export const RealtimeSessionRequestSchema = z.object({
  scope: RealtimeScopeSchema,
  direction: RealtimeSessionDirectionSchema,
  previewSessionId: z.string().optional(),
});

export type RealtimeSessionRequest = z.infer<typeof RealtimeSessionRequestSchema>;

export const RealtimeParticipantMetadataSchema = z.object({
  role: z.string(),
  tokenId: z.string().nullable().optional(),
  operatorIds: z.array(z.string()).optional(),
  clientKind: z.string(),
  participantKind: RealtimeParticipantKindSchema,
  scope: RealtimeScopeSchema,
  previewSessionId: z.string().optional(),
});

export type RealtimeParticipantMetadata = z.infer<typeof RealtimeParticipantMetadataSchema>;

export const RealtimeTokenResponseSchema = z.object({
  url: z.string(),
  roomName: z.string(),
  token: z.string(),
  participantIdentity: z.string(),
  participantName: z.string(),
  participantMetadata: RealtimeParticipantMetadataSchema,
  connectivityHints: RealtimeConnectivityHintsSchema,
});

export type RealtimeTokenResponse = z.infer<typeof RealtimeTokenResponseSchema>;

export const RealtimeTransportOfferSchema = z.object({
  transport: RealtimeTransportKindSchema,
  direction: RealtimeSessionDirectionSchema,
  url: z.string(),
  token: z.string(),
  participantIdentity: z.string().nullable().optional(),
  participantName: z.string().nullable().optional(),
  roomName: z.string().nullable().optional(),
});

export type RealtimeTransportOffer = z.infer<typeof RealtimeTransportOfferSchema>;

export const RealtimeSessionResponseSchema = z.object({
  scope: RealtimeScopeSchema,
  direction: RealtimeSessionDirectionSchema,
  preferredTransport: RealtimeTransportKindSchema,
  forcedCompatibilityMode: z.boolean(),
  offers: z.array(RealtimeTransportOfferSchema).min(1),
  connectivityHints: RealtimeConnectivityHintsSchema,
});

export type RealtimeSessionResponse = z.infer<typeof RealtimeSessionResponseSchema>;

export const RealtimeTransportPolicySchema = z.enum(['auto', 'force-compat']);
export type RealtimeTransportPolicy = z.infer<typeof RealtimeTransportPolicySchema>;

export const RealtimeSettingsSchema = z.object({
  publicWsUrl: z.string().url().nullable().optional(),
  transportPolicy: RealtimeTransportPolicySchema.optional(),
});

export type RealtimeSettings = z.infer<typeof RealtimeSettingsSchema>;

export const RealtimeSourceStatsSchema = z.object({
  latencyMs: z.number(),
  bufferFillPercent: z.number(),
  isActive: z.boolean(),
  audioLevel: z.number().optional(),
  droppedSamples: z.number().optional(),
  sampleRate: z.number(),
});

export type RealtimeSourceStats = z.infer<typeof RealtimeSourceStatsSchema>;

export const RealtimeStatsRequestSchema = z.object({
  scope: RealtimeScopeSchema,
  previewSessionId: z.string().optional(),
});

export type RealtimeStatsRequest = z.infer<typeof RealtimeStatsRequestSchema>;

export const RealtimeStatsResponseSchema = z.object({
  scope: RealtimeScopeSchema,
  previewSessionId: z.string().nullable().optional(),
  source: RealtimeSourceStatsSchema.nullable(),
  transport: RealtimeTransportKindSchema.nullable().optional(),
});

export type RealtimeStatsResponse = z.infer<typeof RealtimeStatsResponseSchema>;
