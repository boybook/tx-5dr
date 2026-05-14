import { z } from 'zod';

export const DEVICE_UI_JWT_TYPE = 'device-ui' as const;
export const DEVICE_UI_JWT_AUDIENCE = 'tx5dr-device-ui' as const;

export const DeviceUiJwtPayloadSchema = z.object({
  typ: z.literal(DEVICE_UI_JWT_TYPE),
  aud: z.literal(DEVICE_UI_JWT_AUDIENCE),
  deviceId: z.string().min(1),
  sessionId: z.string().min(1),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});

export type DeviceUiJwtPayload = z.infer<typeof DeviceUiJwtPayloadSchema>;

export const DeviceUiSessionRequestSchema = z.object({
  deviceId: z.string().trim().min(1).max(128),
  sessionToken: z.string().min(1),
});

export type DeviceUiSessionRequest = z.infer<typeof DeviceUiSessionRequestSchema>;

export const DeviceUiSessionResponseSchema = z.object({
  jwt: z.string().min(1),
  deviceId: z.string().min(1),
  sessionId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

export type DeviceUiSessionResponse = z.infer<typeof DeviceUiSessionResponseSchema>;

export const DeviceUiAuthSessionStateSchema = z.object({
  sessionId: z.string().min(1),
  deviceId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  lastVerifiedAt: z.number().int().nonnegative().optional(),
  revoked: z.boolean().optional(),
});

export type DeviceUiAuthSessionState = z.infer<typeof DeviceUiAuthSessionStateSchema>;

export const DeviceUiAuthStateSchema = z.object({
  jwtSecret: z.string().min(32),
  sessions: z.array(DeviceUiAuthSessionStateSchema).default([]),
  updatedAt: z.number().int().nonnegative().optional(),
});

export type DeviceUiAuthState = z.infer<typeof DeviceUiAuthStateSchema>;

const NullableStringSchema = z.string().nullable();
const NullableNumberSchema = z.number().nullable();

export const DeviceUiFrameSnapshotSchema = z.object({
  slotId: NullableStringSchema.optional(),
  slotStartMs: NullableNumberSchema.optional(),
  snr: NullableNumberSchema,
  freq: NullableNumberSchema,
  dt: NullableNumberSchema,
  message: z.string(),
  operatorId: NullableStringSchema,
  country: NullableStringSchema.optional(),
  countryZh: NullableStringSchema.optional(),
  countryEn: NullableStringSchema.optional(),
  countryCode: NullableStringSchema.optional(),
});

export const DeviceUiCurrentTxSnapshotSchema = z.object({
  active: z.boolean(),
  operatorIds: z.array(z.string()),
  messages: z.array(z.string()),
  lastMessage: NullableStringSchema,
  slotStartMs: NullableNumberSchema,
});

export const DeviceUiCwSnapshotSchema = z.object({
  decoder: z.object({
    enabled: z.boolean(),
    active: z.boolean(),
    state: z.string(),
    muted: z.boolean(),
    pendingText: z.string(),
    committedText: z.string(),
    lastDecodeAt: NullableNumberSchema,
    updatedAt: z.number().int().nonnegative(),
  }),
  keyer: z.object({
    active: z.boolean(),
    mode: NullableStringSchema,
    messageId: NullableStringSchema,
    currentText: NullableStringSchema,
    lastText: NullableStringSchema,
  }),
  currentTx: z.object({
    active: z.boolean(),
    messages: z.array(z.string()),
    lastMessage: NullableStringSchema,
  }),
});

export const DeviceUiBootstrapSnapshotSchema = z.object({
  server: z.object({
    status: z.literal('ok'),
    version: z.string(),
    webPort: NullableNumberSchema,
  }),
  station: z.object({
    callsign: NullableStringSchema,
  }),
  engine: z.object({
    running: z.boolean(),
    mode: NullableStringSchema,
    currentMode: z.object({
      name: z.string(),
      slotMs: z.number().nonnegative().optional(),
    }).nullable(),
    state: NullableStringSchema,
  }),
  radio: z.object({
    connected: z.boolean(),
    frequency: NullableNumberSchema,
    radioMode: NullableStringSchema,
    ptt: z.boolean(),
    tx: z.boolean(),
  }),
  ft8: z.object({
    slot: z.object({
      id: z.string(),
      startMs: z.number(),
      phaseMs: z.number(),
      driftMs: z.number().optional(),
      cycleNumber: z.number(),
      utcSeconds: z.number(),
      mode: z.string(),
    }).nullable(),
    utc: NullableNumberSchema,
    cycle: NullableNumberSchema,
    periodMs: NullableNumberSchema,
    recentDecodeRawMessages: z.array(z.string()),
    lastDecodeRawMessage: NullableStringSchema,
    recentFramesSlotId: NullableStringSchema,
    recentFramesSlotStartMs: NullableNumberSchema,
    recentFrames: z.array(DeviceUiFrameSnapshotSchema),
    currentTx: DeviceUiCurrentTxSnapshotSchema,
  }),
  voice: z.object({
    active: z.boolean(),
    radioMode: NullableStringSchema,
    pttLocked: z.boolean(),
    pttLockedByLabel: NullableStringSchema,
    keyerActive: z.boolean(),
    keyerMode: NullableStringSchema,
    keyerSlotId: NullableStringSchema,
  }),
  cw: DeviceUiCwSnapshotSchema,
  access: z.object({
    localUrl: NullableStringSchema,
    localUrls: z.array(z.string()),
  }),
  updatedAt: z.number().int().nonnegative(),
});

export type DeviceUiBootstrapSnapshot = z.infer<typeof DeviceUiBootstrapSnapshotSchema>;

export const DeviceUiWsEventSchema = z.object({
  type: z.literal('snapshot'),
  payload: DeviceUiBootstrapSnapshotSchema,
  timestamp: z.string(),
});

export type DeviceUiWsEvent = z.infer<typeof DeviceUiWsEventSchema>;
