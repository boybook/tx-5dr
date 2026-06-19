import { describe, expect, it } from 'vitest';
import { decidePowerSupport } from '../radio-power-support.js';
import { RadioPowerResponseSchema } from '../radio-power.schema.js';

describe('radio power support', () => {
  it('does not expose operate for Yaesu FT-710', () => {
    const decision = decidePowerSupport(
      { type: 'serial', serial: { path: 'COM3', rigModel: 1049 } },
      { mfgName: 'Yaesu', modelName: 'FT-710' },
    );

    expect(decision.canPowerOn).toBe(true);
    expect(decision.canPowerOff).toBe(true);
    expect(decision.supportedStates).toEqual(['off']);
  });

  it('keeps response schema aligned with the physical target and runtime state', () => {
    expect(() =>
      RadioPowerResponseSchema.parse({
        success: true,
        target: 'on',
        state: 'awake',
      }),
    ).not.toThrow();
  });

  it('does not expose physical power controls for TCI radios', () => {
    const decision = decidePowerSupport({
      type: 'tci',
      tci: { host: '127.0.0.1', port: 40001, receiver: 0, trx: 0, vfo: 0, audioEnabled: true, audioSampleRate: 12000 },
    });

    expect(decision).toMatchObject({
      canPowerOn: false,
      canPowerOff: false,
      supportedStates: [],
      reason: 'model-unsupported',
    });
  });
});
