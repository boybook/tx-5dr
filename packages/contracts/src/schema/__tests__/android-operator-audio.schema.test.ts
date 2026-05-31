import { describe, expect, it } from 'vitest';
import {
  AndroidOperatorAudioMonitorGainUpdateSchema,
  AndroidOperatorAudioStatusSchema,
} from '../android-operator-audio.schema.js';

describe('Android operator audio schemas', () => {
  it('accepts native monitor gain telemetry and updates', () => {
    const status = AndroidOperatorAudioStatusSchema.parse({
      available: true,
      captureState: 'idle',
      monitorState: 'playing',
      participantIdentity: 'android-native:operator',
      inputLevel: 0,
      inputPeak: 0,
      inputSilenced: false,
      micGainDb: 18,
      micGainMinDb: -12,
      micGainMaxDb: 24,
      monitorGainDb: -6,
      monitorGainMinDb: -60,
      monitorGainMaxDb: 20,
      micDevice: null,
      speakerDevice: null,
      lastError: null,
    });

    expect(status.monitorGainDb).toBe(-6);
    expect(AndroidOperatorAudioMonitorGainUpdateSchema.parse({ monitorGainDb: 3 }).monitorGainDb).toBe(3);
  });
});
