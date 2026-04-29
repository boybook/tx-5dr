import { z } from 'zod';

export const RealtimeScopeSchema = z.enum(['radio', 'openwebrx-preview']);
export type RealtimeScope = z.infer<typeof RealtimeScopeSchema>;

export const RealtimeTransportKindSchema = z.enum(['rtc-data-audio', 'ws-compat']);
export type RealtimeTransportKind = z.infer<typeof RealtimeTransportKindSchema>;

export const RealtimeSessionDirectionSchema = z.enum(['recv', 'send']);
export type RealtimeSessionDirection = z.infer<typeof RealtimeSessionDirectionSchema>;

export const VoiceTxBufferProfileSchema = z.enum(['low-latency', 'balanced', 'stable', 'custom']);
export type VoiceTxBufferProfile = z.infer<typeof VoiceTxBufferProfileSchema>;

export const VoiceTxCustomTargetBufferMsSchema = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().int().min(40).max(500).optional());

export const VoiceTxBufferPreferenceSchema = z.object({
  profile: VoiceTxBufferProfileSchema.default('balanced'),
  customTargetBufferMs: VoiceTxCustomTargetBufferMsSchema,
}).superRefine((value, ctx) => {
  if (value.profile === 'custom' && typeof value.customTargetBufferMs !== 'number') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['customTargetBufferMs'],
      message: 'Custom TX buffer target is required for custom profile',
    });
  }
});
export type VoiceTxBufferPreference = z.infer<typeof VoiceTxBufferPreferenceSchema>;

export const ResolvedVoiceTxBufferPolicySchema = z.object({
  profile: VoiceTxBufferProfileSchema,
  targetMs: z.number().int().min(1),
  minMs: z.number().int().min(1),
  maxMs: z.number().int().min(1),
  headroomMs: z.number().int().min(1),
  staleFrameMs: z.number().int().min(1),
  uplinkMaxBufferedAudioMs: z.number().int().min(1),
  uplinkDegradedBufferedAudioMs: z.number().int().min(1),
});
export type ResolvedVoiceTxBufferPolicy = z.infer<typeof ResolvedVoiceTxBufferPolicySchema>;

export const DEFAULT_VOICE_TX_BUFFER_PROFILE: VoiceTxBufferProfile = 'balanced';

const VOICE_TX_BUFFER_PRESETS: Record<Exclude<VoiceTxBufferProfile, 'custom'>, ResolvedVoiceTxBufferPolicy> = {
  'low-latency': {
    profile: 'low-latency',
    targetMs: 40,
    minMs: 30,
    maxMs: 140,
    headroomMs: 20,
    staleFrameMs: 220,
    uplinkMaxBufferedAudioMs: 80,
    uplinkDegradedBufferedAudioMs: 200,
  },
  balanced: {
    profile: 'balanced',
    targetMs: 90,
    minMs: 60,
    maxMs: 240,
    headroomMs: 40,
    staleFrameMs: 450,
    uplinkMaxBufferedAudioMs: 180,
    uplinkDegradedBufferedAudioMs: 360,
  },
  stable: {
    profile: 'stable',
    targetMs: 170,
    minMs: 120,
    maxMs: 420,
    headroomMs: 80,
    staleFrameMs: 850,
    uplinkMaxBufferedAudioMs: 340,
    uplinkDegradedBufferedAudioMs: 680,
  },
};

function clampVoiceTxBufferValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function resolveVoiceTxBufferPolicy(
  preference?: VoiceTxBufferPreference | null,
): ResolvedVoiceTxBufferPolicy {
  const parsedPreference = preference
    ? VoiceTxBufferPreferenceSchema.safeParse(preference)
    : null;
  const normalizedPreference = parsedPreference?.success
    ? parsedPreference.data
    : { profile: DEFAULT_VOICE_TX_BUFFER_PROFILE as VoiceTxBufferProfile };

  if (normalizedPreference.profile !== 'custom') {
    return { ...VOICE_TX_BUFFER_PRESETS[normalizedPreference.profile] };
  }

  const targetMs = clampVoiceTxBufferValue(normalizedPreference.customTargetBufferMs ?? 90, 40, 500);
  const minMs = clampVoiceTxBufferValue(targetMs * 0.65, 30, targetMs);
  const maxMs = clampVoiceTxBufferValue(targetMs * 2.5, targetMs + 40, 900);
  const headroomMs = clampVoiceTxBufferValue(targetMs * 0.45, 20, 180);
  const staleFrameMs = clampVoiceTxBufferValue(targetMs * 5, maxMs + 80, 1800);
  const uplinkMaxBufferedAudioMs = clampVoiceTxBufferValue(targetMs * 2, 80, 1000);
  const uplinkDegradedBufferedAudioMs = clampVoiceTxBufferValue(
    targetMs * 4,
    uplinkMaxBufferedAudioMs + 60,
    2000,
  );

  return {
    profile: 'custom',
    targetMs,
    minMs,
    maxMs,
    headroomMs,
    staleFrameMs,
    uplinkMaxBufferedAudioMs,
    uplinkDegradedBufferedAudioMs,
  };
}

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
  localUdpPort: z.number().int().min(1).max(65535),
  publicCandidateEnabled: z.boolean(),
  publicEndpoint: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
  }).nullable(),
  iceServers: z.array(z.string()),
  fallbackTransport: z.literal('ws-compat'),
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

export const RealtimeSessionRequestSchema = z.object({
  scope: RealtimeScopeSchema,
  direction: RealtimeSessionDirectionSchema,
  previewSessionId: z.string().optional(),
  transportOverride: RealtimeTransportKindSchema.optional(),
  voiceTxBufferPreference: VoiceTxBufferPreferenceSchema.optional(),
});

export type RealtimeSessionRequest = z.infer<typeof RealtimeSessionRequestSchema>;

export const RealtimeTransportOfferSchema = z.object({
  transport: RealtimeTransportKindSchema,
  direction: RealtimeSessionDirectionSchema,
  url: z.string(),
  token: z.string(),
  participantIdentity: z.string().nullable().optional(),
  participantName: z.string().nullable().optional(),
});

export type RealtimeTransportOffer = z.infer<typeof RealtimeTransportOfferSchema>;

export const RealtimeTransportPolicySchema = z.enum(['auto', 'force-compat']);
export type RealtimeTransportPolicy = z.infer<typeof RealtimeTransportPolicySchema>;

function isValidIpv4Literal(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const parsed = Number.parseInt(part, 10);
    return parsed >= 0 && parsed <= 255;
  });
}

function isValidIpv6Literal(value: string): boolean {
  if (!value.includes(':') || value.includes('[') || value.includes(']')) {
    return false;
  }
  try {
    // WHATWG URL parsing gives us a portable IPv6 sanity check without Node-only APIs.
    // The schema still forbids bracket notation because the setting is host-only.
    const parsed = new URL(`http://[${value}]/`);
    return parsed.hostname.length > 2;
  } catch {
    return false;
  }
}

function isValidDnsHostname(value: string): boolean {
  if (value.length > 253 || value.endsWith('.')) {
    return false;
  }
  const labels = value.split('.');
  return labels.every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  ));
}

function isValidRtcDataAudioPublicHost(value: string): boolean {
  const host = value.trim();
  if (!host || /\s/.test(host) || /[/?#@]/.test(host) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) {
    return false;
  }
  return isValidIpv4Literal(host) || isValidIpv6Literal(host) || isValidDnsHostname(host);
}

export const RtcDataAudioPublicHostSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim() : value),
  z.union([
    z.literal('').transform(() => null),
    z.string().min(1).max(253).refine(isValidRtcDataAudioPublicHost, {
      message: 'Public host must be an IP address or DNS hostname without scheme, port, or path',
    }),
    z.null(),
  ]),
);
export type RtcDataAudioPublicHost = z.infer<typeof RtcDataAudioPublicHostSchema>;

export const RtcDataAudioPublicUdpPortSchema = z.preprocess((value) => {
  if (value === '' || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().int().min(1).max(65535).nullable());
export type RtcDataAudioPublicUdpPort = z.infer<typeof RtcDataAudioPublicUdpPortSchema>;

export const RealtimeSessionResponseSchema = z.object({
  scope: RealtimeScopeSchema,
  direction: RealtimeSessionDirectionSchema,
  preferredTransport: RealtimeTransportKindSchema,
  effectiveTransportPolicy: RealtimeTransportPolicySchema,
  selectionReason: z.enum([
    'client-override',
    'server-policy',
    'default-rtc-data-audio',
    'rtc-data-audio-unavailable',
  ]),
  forcedCompatibilityMode: z.boolean(),
  offers: z.array(RealtimeTransportOfferSchema).min(1),
  connectivityHints: RealtimeConnectivityHintsSchema,
  voiceTxBufferPolicy: ResolvedVoiceTxBufferPolicySchema.optional(),
});

export type RealtimeSessionResponse = z.infer<typeof RealtimeSessionResponseSchema>;

export const RealtimeSettingsSchema = z.object({
  transportPolicy: RealtimeTransportPolicySchema.optional(),
  rtcDataAudioPublicHost: RtcDataAudioPublicHostSchema.optional(),
  rtcDataAudioPublicUdpPort: RtcDataAudioPublicUdpPortSchema.optional(),
});

export type RealtimeSettings = z.infer<typeof RealtimeSettingsSchema>;

export const RealtimeRtcDataAudioRuntimeSchema = z.object({
  localUdpPort: z.number().int().min(1).max(65535),
  publicCandidateEnabled: z.boolean(),
  publicEndpoint: z.object({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
  }).nullable(),
});
export type RealtimeRtcDataAudioRuntime = z.infer<typeof RealtimeRtcDataAudioRuntimeSchema>;

export const RealtimeSettingsRuntimeSchema = z.object({
  connectivityHints: RealtimeConnectivityHintsSchema,
  radioReceiveTransport: RealtimeTransportKindSchema,
  rtcDataAudio: RealtimeRtcDataAudioRuntimeSchema,
});

export type RealtimeSettingsRuntime = z.infer<typeof RealtimeSettingsRuntimeSchema>;

export const RealtimeSettingsResponseDataSchema = RealtimeSettingsSchema.extend({
  runtime: RealtimeSettingsRuntimeSchema.optional(),
});

export type RealtimeSettingsResponseData = z.infer<typeof RealtimeSettingsResponseDataSchema>;

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

export const RealtimeVoiceTxMetricWindowSchema = z.object({
  current: z.number().nullable(),
  rolling: z.number().nullable(),
  peak: z.number().nullable(),
});

export type RealtimeVoiceTxMetricWindow = z.infer<typeof RealtimeVoiceTxMetricWindowSchema>;

export const RealtimeVoiceTxBottleneckStageSchema = z.enum([
  'client-capture',
  'transport',
  'server-ingress',
  'server-queue',
  'server-output',
]);

export type RealtimeVoiceTxBottleneckStage = z.infer<typeof RealtimeVoiceTxBottleneckStageSchema>;

export const RealtimeVoiceTxSummarySchema = z.object({
  active: z.boolean(),
  transport: RealtimeTransportKindSchema.nullable(),
  bottleneckStage: RealtimeVoiceTxBottleneckStageSchema.nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  clientId: z.string().nullable(),
  label: z.string().nullable(),
});

export type RealtimeVoiceTxSummary = z.infer<typeof RealtimeVoiceTxSummarySchema>;

export const RealtimeVoiceTxTransportStatsSchema = z.object({
  receivedFrames: z.number().int().nonnegative(),
  sequenceGaps: z.number().int().nonnegative(),
  lastSequence: z.number().int().nullable(),
  clientToServerMs: RealtimeVoiceTxMetricWindowSchema,
});

export type RealtimeVoiceTxTransportStats = z.infer<typeof RealtimeVoiceTxTransportStatsSchema>;

export const RealtimeVoiceTxServerIngressStatsSchema = z.object({
  frameIntervalMs: RealtimeVoiceTxMetricWindowSchema,
  queueDepthFrames: z.number().int().nonnegative(),
  queuedAudioMs: z.number().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  staleDroppedFrames: z.number().int().nonnegative(),
  underrunCount: z.number().int().nonnegative(),
  plcFrames: z.number().int().nonnegative(),
  jitterTargetMs: z.number().nonnegative(),
});

export type RealtimeVoiceTxServerIngressStats = z.infer<typeof RealtimeVoiceTxServerIngressStatsSchema>;

export const RealtimeVoiceTxServerOutputStatsSchema = z.object({
  resampleMs: RealtimeVoiceTxMetricWindowSchema,
  queueWaitMs: RealtimeVoiceTxMetricWindowSchema,
  writeMs: RealtimeVoiceTxMetricWindowSchema,
  serverPipelineMs: RealtimeVoiceTxMetricWindowSchema,
  endToEndMs: RealtimeVoiceTxMetricWindowSchema,
  outputBufferedMs: RealtimeVoiceTxMetricWindowSchema,
  outputWriteIntervalMs: RealtimeVoiceTxMetricWindowSchema,
  outputSampleRate: z.number().nullable(),
  outputBufferSize: z.number().nullable(),
  writeFailures: z.number().int().nonnegative(),
});

export type RealtimeVoiceTxServerOutputStats = z.infer<typeof RealtimeVoiceTxServerOutputStatsSchema>;

export const RealtimeVoiceTxStatsResponseSchema = z.object({
  scope: RealtimeScopeSchema,
  summary: RealtimeVoiceTxSummarySchema,
  transport: RealtimeVoiceTxTransportStatsSchema,
  serverIngress: RealtimeVoiceTxServerIngressStatsSchema,
  serverOutput: RealtimeVoiceTxServerOutputStatsSchema,
});

export type RealtimeVoiceTxStatsResponse = z.infer<typeof RealtimeVoiceTxStatsResponseSchema>;
