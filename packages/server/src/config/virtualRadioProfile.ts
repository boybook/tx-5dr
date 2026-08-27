import { z } from 'zod';
import type { AudioDeviceSettings, RadioProfile } from '@tx5dr/contracts';

const CALLSIGN = /^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/i;
const GRID = /^[A-R]{2}[0-9]{2}$/i;

export const VirtualRadioPeerSchema = z.object({
  id: z.string().min(1),
  callsign: z.string().regex(CALLSIGN).transform((value) => value.toUpperCase()),
  grid: z.string().regex(GRID).transform((value) => value.toUpperCase()),
  scenarioId: z.string().min(1),
  identityPool: z.literal('scenario').optional(),
  audioFrequencyHz: z.number().finite().min(200).max(4_000),
  dropProbability: z.number().finite().min(0).max(1).optional().default(0),
  frequencyOffsetHz: z.number().finite().min(-200).max(200).optional().default(0),
  timingOffsetMs: z.number().finite().min(-1_000).max(1_000).optional().default(0),
});

export const VirtualRadioRuntimeConfigSchema = z.object({
  dialFrequencyHz: z.number().finite().min(100_000).max(10_000_000_000),
  scenarioProvider: z.string().min(1),
  seed: z.union([z.string().min(1), z.number().finite()]),
  peers: z.array(VirtualRadioPeerSchema).min(1),
}).superRefine((value, ctx) => {
  const ids = new Set<string>();
  const callsigns = new Set<string>();
  for (let index = 0; index < value.peers.length; index += 1) {
    const peer = value.peers[index]!;
    if (ids.has(peer.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['peers', index, 'id'], message: 'peer id must be unique' });
    }
    if (callsigns.has(peer.callsign)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['peers', index, 'callsign'], message: 'peer callsign must be unique' });
    }
    ids.add(peer.id);
    callsigns.add(peer.callsign);
  }
});

export const VirtualRadioProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  radio: z.object({
    type: z.literal('virtual'),
    virtual: VirtualRadioRuntimeConfigSchema,
    transmitCompensationMs: z.number().finite().optional(),
  }),
  audio: z.custom<AudioDeviceSettings>().optional(),
  audioLockedToRadio: z.boolean().optional().default(true),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  description: z.string().optional(),
});

export type VirtualRadioRuntimeConfig = z.infer<typeof VirtualRadioRuntimeConfigSchema>;
export type VirtualRadioPeer = z.infer<typeof VirtualRadioPeerSchema>;
export type VirtualRadioProfile = z.infer<typeof VirtualRadioProfileSchema>;
export type InternalRadioProfile = RadioProfile | VirtualRadioProfile;

export function isVirtualRadioProfile(value: unknown): value is VirtualRadioProfile {
  return Boolean(value && typeof value === 'object'
    && (value as { radio?: { type?: unknown } }).radio?.type === 'virtual');
}

export function parseInternalProfiles(value: unknown): InternalRadioProfile[] {
  if (!Array.isArray(value)) return [];
  return value.map((profile, index) => {
    if (!isVirtualRadioProfile(profile)) return profile as RadioProfile;
    const result = VirtualRadioProfileSchema.safeParse(profile);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `config.profiles[${index}].${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new Error(detail);
    }
    return result.data;
  });
}

export function projectVirtualRadioProfile(profile: VirtualRadioProfile): RadioProfile {
  return {
    id: profile.id,
    name: profile.name,
    radio: {
      type: 'none',
      transmitCompensationMs: profile.radio.transmitCompensationMs,
    },
    audio: {
      inputSampleRate: 12_000,
      outputSampleRate: 12_000,
      inputBufferSize: 1_200,
      outputBufferSize: 1_200,
    },
    audioLockedToRadio: true,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    description: profile.description,
    isVirtual: true,
    readOnly: true,
  };
}
