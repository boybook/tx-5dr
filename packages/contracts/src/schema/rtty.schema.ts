import { z } from 'zod';
import { KeyboardPlaceholderValuesSchema } from './keyboard-message.schema.js';

/**
 * RTTY (ITA2 / Baudot AFSK) operating-mode contracts.
 *
 * Tones are expressed as an audio centre frequency plus shift. Which tone is
 * mark follows the radio sideband so that the RF mark is always the higher RF
 * frequency (amateur convention); `reverse` swaps them on purpose.
 */

export const RttySidebandSchema = z.enum(['lsb', 'usb']);
export type RttySideband = z.infer<typeof RttySidebandSchema>;

export const RttyCharacterSetSchema = z.enum(['usTty', 'ita2']);
export type RttyCharacterSet = z.infer<typeof RttyCharacterSetSchema>;

export const RttyIdleSchema = z.enum(['diddle', 'mark']);
export type RttyIdle = z.infer<typeof RttyIdleSchema>;

export const RttyStopBitsSchema = z.union([z.literal(1), z.literal(1.5), z.literal(2)]);
export type RttyStopBits = z.infer<typeof RttyStopBitsSchema>;

export const RttyConfigSchema = z.object({
  /** Symbol rate in baud. */
  baud: z.number().min(20).max(300).default(45.45),
  /** Mark/space separation in Hz. */
  shiftHz: z.number().min(20).max(1200).default(170),
  /** Stop-bit length transmitted. Reception accepts 1 to 2. */
  stopBits: RttyStopBitsSchema.default(1.5),
  /** Radio sideband used for AFSK; selects LSB-D/PKTLSB/DIGL or USB-D/PKTUSB/DIGU. */
  sideband: RttySidebandSchema.default('lsb'),
  /** Audio centre frequency between mark and space, in Hz. */
  centerHz: z.number().min(300).max(3000).default(2210),
  /** Exchange mark and space on purpose (both RX and TX). */
  reverse: z.boolean().default(false),
  /** Figures-case variant. */
  characterSet: RttyCharacterSetSchema.default('usTty'),
  /** Receive: return to letters after a space. */
  usos: z.boolean().default(true),
  /** Receive: automatic frequency control. */
  afc: z.boolean().default(true),
  /** Receive: characters below this confidence are hidden; 0 disables the squelch. */
  squelch: z.number().min(0).max(1).default(0.25),
  /** Receive: remove short impulses (static crashes) before demodulation. */
  noiseBlanker: z.boolean().default(true),
  /** Receive: also try reversed polarity and follow the better stream. */
  autoReverse: z.boolean().default(true),
  /** Transmit: filler while the buffer is empty. */
  idle: RttyIdleSchema.default('diddle'),
  /** Transmit: hard limit for one continuous transmission, in seconds. */
  maxTransmitSeconds: z.number().int().min(10).max(1800).default(600),
  /** Receive: look for RTTY signals across the passband (signal browser). */
  scanner: z.boolean().default(true),
  /** Receive: signals decoded in parallel by the signal browser (CPU cost grows with it). */
  scannerChannels: z.number().int().min(1).max(12).default(6),
});
export type RttyConfig = z.infer<typeof RttyConfigSchema>;

export const RttyConfigPatchSchema = RttyConfigSchema.partial();
export type RttyConfigPatch = z.infer<typeof RttyConfigPatchSchema>;

export const RttyTuningUpdateSchema = z.object({
  centerHz: z.number().min(300).max(3000),
});
export type RttyTuningUpdate = z.infer<typeof RttyTuningUpdateSchema>;

export interface RttyAudioTones {
  markHz: number;
  spaceHz: number;
}

/**
 * Audio mark/space tones for a configuration.
 *
 * On LSB the RF frequency is dial minus audio, so the RF-higher mark is the
 * lower audio tone; on USB it is the higher audio tone.
 */
export function resolveRttyAudioTones(config: Pick<RttyConfig, 'centerHz' | 'shiftHz' | 'sideband' | 'reverse'>): RttyAudioTones {
  const half = config.shiftHz / 2;
  const markAbove = (config.sideband === 'usb') !== config.reverse;
  return markAbove
    ? { markHz: config.centerHz + half, spaceHz: config.centerHz - half }
    : { markHz: config.centerHz - half, spaceHz: config.centerHz + half };
}

/** Base radio mode for RTTY AFSK; combined with the `digital` intent it selects PKTLSB / LSB-D / DIGL (or the USB family). */
export function rttyRadioMode(config: Pick<RttyConfig, 'sideband'>): 'LSB' | 'USB' {
  return config.sideband === 'usb' ? 'USB' : 'LSB';
}

/** Audio range both tones must stay in (the native modem rejects tones below 100 Hz). */
export const RTTY_TONE_MIN_HZ = 100;
export const RTTY_TONE_MAX_HZ = 4_000;

/** True when the resolved mark and space tones of `config` are usable audio tones. */
export function rttyTonesInRange(config: Pick<RttyConfig, 'centerHz' | 'shiftHz' | 'sideband' | 'reverse'>): boolean {
  const { markHz, spaceHz } = resolveRttyAudioTones(config);
  return Math.min(markHz, spaceHz) >= RTTY_TONE_MIN_HZ && Math.max(markHz, spaceHz) <= RTTY_TONE_MAX_HZ;
}

/** RF frequency of the transmitted mark tone for a given dial frequency. */
export function rttyMarkRfFrequency(
  dialFrequencyHz: number,
  config: Pick<RttyConfig, 'centerHz' | 'shiftHz' | 'sideband' | 'reverse'>,
): number {
  const { markHz } = resolveRttyAudioTones(config);
  return config.sideband === 'usb' ? dialFrequencyHz + markHz : dialFrequencyHz - markHz;
}

// ===== Transmit =====

export const RttyTxPhaseSchema = z.enum([
  'idle',
  'preparing',
  'waiting_lease',
  'on_air',
  'draining',
  'error',
]);
export type RttyTxPhase = z.infer<typeof RttyTxPhaseSchema>;

export const RttyTxStatusSchema = z.object({
  phase: RttyTxPhaseSchema,
  active: z.boolean(),
  /** Transmission session, changes on every new key-up. */
  sessionId: z.string().nullable(),
  startedBy: z.string().nullable(),
  startedByLabel: z.string().nullable(),
  /** Text already played to the radio in this session. */
  sentText: z.string(),
  /** Text rendered to audio but not yet played; no longer editable. */
  committedText: z.string(),
  /** Text waiting in the editable transmit buffer. */
  pendingText: z.string(),
  /** The session ends after the buffer drains. */
  finishing: z.boolean(),
  /** False when the audio path cannot stream (text is sent as whole messages). */
  typeAheadSupported: z.boolean(),
  /** Message slot that started or extended the session, if any. */
  messageId: z.string().nullable(),
  startedAt: z.number().nullable(),
  /** Text of the last completed session. */
  lastText: z.string().nullable(),
  /** Automatic repeat (e.g. CQ loop) waiting for or running its message. */
  repeat: z.object({
    messageId: z.string(),
    intervalSec: z.number(),
    /** Next key-up time (ms) while waiting; null while the message is on air. */
    nextRunAt: z.number().nullable(),
  }).nullable(),
  error: z.string().nullable(),
  /** False when RTTY transmit is impossible (codec missing, radio disconnected...). */
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.number(),
});
export type RttyTxStatus = z.infer<typeof RttyTxStatusSchema>;

/** Append text to the transmit buffer (client → server). */
export const RttyTxAppendSchema = z.object({
  text: z.string().min(1).max(500),
  /** Start a transmission if none is active (default true). */
  start: z.boolean().optional(),
  /** End the transmission once this text has been sent. */
  finishAfter: z.boolean().optional(),
  placeholderValues: KeyboardPlaceholderValuesSchema.optional(),
  /** Operator on whose behalf the client transmits (permission scope, lease attribution). */
  operatorId: z.string().min(1),
});
export type RttyTxAppend = z.infer<typeof RttyTxAppendSchema>;

/** Remove characters from the end of the editable buffer (client → server). */
export const RttyTxRetractSchema = z.object({
  count: z.number().int().min(1).max(500),
});
export type RttyTxRetract = z.infer<typeof RttyTxRetractSchema>;

/** Send a stored message slot (client → server). */
export const RttyPlayMessageSchema = z.object({
  callsign: z.string().min(1),
  slotId: z.string().min(1),
  placeholderValues: KeyboardPlaceholderValuesSchema.optional(),
  operatorId: z.string().min(1),
  /**
   * Send the message again after the slot's interval each time the
   * transmission ends, until someone answers, the operator transmits anything
   * else, or stops. `false` cancels a running repeat of this slot.
   */
  repeat: z.boolean().optional(),
});
export type RttyPlayMessage = z.infer<typeof RttyPlayMessageSchema>;

// ===== Receive =====

export const RttySignalSchema = z.object({
  locked: z.boolean(),
  /** Calibrated SNR in 3 kHz; -30 (or below) means not measured yet. */
  snrDb: z.number(),
  markDb: z.number(),
  spaceDb: z.number(),
  frequencyOffsetHz: z.number(),
  reversed: z.boolean(),
  /** AFC is at its range limit: the signal is too far off the tones to follow. */
  afcLimited: z.boolean().optional(),
  /** 0..1 quality of recently decoded text (mean character confidence). */
  quality: z.number().min(0).max(1).optional(),
});
export type RttySignal = z.infer<typeof RttySignalSchema>;

export const RttyDecoderStateSchema = z.enum([
  'disabled',
  'unavailable',
  'listening',
  'muted',
  'error',
]);
export type RttyDecoderState = z.infer<typeof RttyDecoderStateSchema>;

export const RttyDecoderStatusSchema = z.object({
  state: RttyDecoderStateSchema,
  enabled: z.boolean(),
  /** Decoder session; changes when the transcript is cleared or reconfigured. */
  sessionId: z.string(),
  signal: RttySignalSchema.nullable(),
  error: z.string().nullable(),
  updatedAt: z.number(),
});
export type RttyDecoderStatus = z.infer<typeof RttyDecoderStatusSchema>;

export const RttyReceivedCharacterSchema = z.object({
  ch: z.string().length(1),
  /** 0 = indistinguishable from noise, 1 = certain. */
  confidence: z.number().min(0).max(1),
  /** Wall-clock time of the character's start bit (ms). */
  at: z.number(),
});
export type RttyReceivedCharacter = z.infer<typeof RttyReceivedCharacterSchema>;

export const RttyDecoderEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('characters'),
    sessionId: z.string(),
    /**
     * Monotonic per session; lets clients detect gaps. For a `snapshot` it is
     * the last live batch included (-1 when none was sent yet).
     */
    sequence: z.number().int().min(-1),
    characters: z.array(RttyReceivedCharacterSchema).min(1),
    /**
     * Text re-decoded from the recent audio history after a tuning or
     * settings change. It does not replace text already shown: clients show
     * it as a separate block covering the audio from `replayFrom` on.
     */
    replay: z.boolean().optional(),
    /** Wall-clock start (ms) of the re-decoded audio; set with `replay`. */
    replayFrom: z.number().optional(),
    /**
     * Received text of the session so far, for a client that (re)connects:
     * replaces what the client shows up to the last snapshot character.
     */
    snapshot: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('reset'),
    sessionId: z.string(),
    reason: z.enum(['cleared', 'reconfigured', 'restarted']),
  }),
]);
export type RttyDecoderEvent = z.infer<typeof RttyDecoderEventSchema>;

// ===== Signal browser =====

/** One RTTY signal found in the passband by the wideband scanner. */
export const RttyScanChannelSchema = z.object({
  /** Stable while the signal is tracked. */
  id: z.number().int().nonnegative(),
  /** Audio centre between mark and space, in Hz. */
  centerHz: z.number(),
  shiftHz: z.number(),
  /** 0..1 likelihood of being RTTY (alternating tone pair). */
  score: z.number().min(0).max(1),
  snrDb: z.number(),
  reversed: z.boolean(),
  locked: z.boolean(),
  /** Most recent decoded text of this signal (bounded). */
  preview: z.string(),
  /** Wall-clock time the signal was last heard (ms). */
  lastHeardAt: z.number(),
});
export type RttyScanChannel = z.infer<typeof RttyScanChannelSchema>;

export const RttyScanUpdateSchema = z.object({
  enabled: z.boolean(),
  channels: z.array(RttyScanChannelSchema),
  updatedAt: z.number(),
});
export type RttyScanUpdate = z.infer<typeof RttyScanUpdateSchema>;
