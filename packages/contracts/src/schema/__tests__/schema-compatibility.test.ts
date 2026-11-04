import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuthConfigSchema, RemoteAccessSecurityConfigSchema, UpdateRemoteAccessSecurityRequestSchema } from '../auth.schema.js';
import { PSKReporterConfigSchema, PSKReporterConfigPatchSchema } from '../pskreporter.schema.js';
import { CWDecoderConfigPatchSchema } from '../cw-decoder.schema.js';
import { RigctldBridgeConfigPatchSchema } from '../rigctld.schema.js';
import { UpdateRadioOperatorRequestSchema } from '../operator.schema.js';
import { SlotPackSchema } from '../slot-info.schema.js';
import { HamlibBackendConfigSchema } from '../radio.schema.js';
import { ModeDescriptorSchema } from '../mode.schema.js';

describe('persisted and HTTP schema compatibility', () => {
  it.each([
    [UpdateRemoteAccessSecurityRequestSchema, { preset: 'public' }],
    [UpdateRadioOperatorRequestSchema, { myCallsign: 'bg5drb' }],
    [PSKReporterConfigPatchSchema, { enabled: true }],
    [CWDecoderConfigPatchSchema, { targetFreqHz: 700 }],
    [RigctldBridgeConfigPatchSchema, { port: 4533 }],
  ])('never adds omitted configuration fields to a patch', (schema, patch) => {
    expect(schema.parse({})).toEqual({});
    expect(Object.keys(schema.parse(patch))).toEqual(Object.keys(patch));
  });

  it('retains patch value validation and operator normalization', () => {
    expect(UpdateRadioOperatorRequestSchema.parse({ myCallsign: 'bg5drb' })).toEqual({ myCallsign: 'BG5DRB' });
    expect(CWDecoderConfigPatchSchema.safeParse({ targetFreqHz: -1 }).success).toBe(false);
    expect(RigctldBridgeConfigPatchSchema.safeParse({ port: 65536 }).success).toBe(false);
    expect(PSKReporterConfigPatchSchema.safeParse({ reportIntervalSeconds: 0 }).success).toBe(false);
  });

  it('fills nested defaults when loading configurations predating those fields', () => {
    expect(AuthConfigSchema.parse({}).remoteAccess).toEqual(RemoteAccessSecurityConfigSchema.parse({}));
    expect(PSKReporterConfigSchema.parse({}).stats).toEqual({
      todayReportCount: 0, totalReportCount: 0, consecutiveFailures: 0,
    });
    expect(SlotPackSchema.parse({ slotId: 'legacy', startMs: 0, endMs: 15000, frames: [] }).stats)
      .toMatchObject({ totalDecodes: 0, successfulDecodes: 0, totalFramesBeforeDedup: 0, totalFramesAfterDedup: 0 });
  });

  it('preserves arbitrary radio backend keys and rejects non-string values', () => {
    expect(HamlibBackendConfigSchema.parse({ rig_pathname: '/dev/ttyUSB0', retry: '3' }))
      .toEqual({ rig_pathname: '/dev/ttyUSB0', retry: '3' });
    expect(HamlibBackendConfigSchema.safeParse({ retry: 3 }).success).toBe(false);
  });

  it('keeps defaulted mode fields optional in HTTP input schemas', () => {
    const input = z.toJSONSchema(ModeDescriptorSchema, { target: 'draft-7', io: 'input' });
    expect(input.required).toContain('windowTiming');
    expect(input.required).not.toContain('toleranceMs');
    expect(input.required).not.toContain('encodeAdvance');
    expect(ModeDescriptorSchema.parse({ name: 'FT8', slotMs: 15000, windowTiming: [-300], transmitTiming: 500 }))
      .toMatchObject({ toleranceMs: 100, encodeAdvance: 400 });
  });
});
