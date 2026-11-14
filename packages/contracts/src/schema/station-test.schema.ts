import { z } from 'zod';

export const SimulationPeerSchema = z.object({
  id: z.string().min(1), callsign: z.string().regex(/^[A-Z0-9]+(?:\/[A-Z0-9]+)*$/i).transform(s => s.toUpperCase()),
  grid: z.string().regex(/^[A-R]{2}[0-9]{2}$/i).transform(s => s.toUpperCase()),
  scenarioId: z.string().min(1), identityPool: z.literal('scenario').optional(),
  audioFrequencyHz: z.number().finite().min(200).max(4000),
  dropProbability: z.number().min(0).max(1).default(0),
  frequencyOffsetHz: z.number().min(-200).max(200).default(0),
  timingOffsetMs: z.number().min(-1000).max(1000).default(0),
  /** RTTY peers only: white noise added to replies, as SNR in a 3 kHz bandwidth. */
  channelSnrDb: z.number().min(-20).max(40).optional(),
});
export const StationTestRunSchema = z.object({
  version: z.literal(1), hardware: z.boolean().default(false), profileId: z.string().min(1),
  mode: z.enum(['FT8', 'FT4', 'RTTY']), dialFrequencyHz: z.number().finite().min(100000).max(10000000000),
  transmitCycle: z.union([z.literal(0), z.literal(1)]).default(1),
  scenarioProvider: z.string().min(1), seed: z.union([z.string().min(1), z.number().finite()]),
  peers: z.array(SimulationPeerSchema).min(1).max(16),
  artifactDir: z.string().min(1), maxDurationMs: z.number().int().min(1000).max(600000).default(600000),
}).superRefine((v, ctx) => {
  const frequencies = v.peers.map(p => p.audioFrequencyHz + p.frequencyOffsetHz).sort((a, b) => a - b);
  const spacing = v.mode === 'RTTY' ? 400 : v.mode === 'FT4' ? 100 : 60;
  if (frequencies.some((f, i) => f < 200 || f > 4000 || (i > 0 && f - frequencies[i - 1]! < spacing))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Peer frequencies must remain in the passband with mode-appropriate spacing' });
  }
  if (new Set(v.peers.map(p => p.id)).size !== v.peers.length || new Set(v.peers.map(p => p.callsign)).size !== v.peers.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Peer identities must be unique' });
  }
});
export type StationTestRun = z.infer<typeof StationTestRunSchema>;
export type SimulationPeer = z.infer<typeof SimulationPeerSchema>;
export const ArmStationTestSchema = z.object({
  sessionId: z.string().min(1), dummyLoadInstalled: z.literal(true), minimumPowerSetManually: z.literal(true),
});
export const StationTestStatusSchema = z.object({
  sessionId: z.string(), phase: z.enum(['starting', 'ready', 'armed', 'stopped', 'failed']),
  hardware: z.boolean(), radioConnected: z.boolean(), audioReady: z.boolean(),
  peerReady: z.boolean(), expiresAt: z.number().nullable(),
  powerEvidence: z.enum(['not-applicable', 'readback', 'manual-confirmation']),
  error: z.string().optional(), tracePath: z.string(),
});
export type StationTestStatus = z.infer<typeof StationTestStatusSchema>;

/** Local CLI handoff only; credentials remain in the isolated, temporary token file. */
export const StationTestAgentSessionSchema = z.object({
  version: z.literal(1),
  phase: z.enum(['preparing', 'serving', 'verifying', 'stopped', 'failed']),
  sessionId: z.string().min(1),
  serverUrl: z.string().url(), webUrl: z.string().url(),
  operatorId: z.string().min(1), artifactDir: z.string().min(1),
  expiresAt: z.number(), tokenFile: z.string().min(1).optional(),
  plugins: z.array(z.object({ name: z.string(), version: z.string(), type: z.enum(['strategy', 'utility']) })),
});
