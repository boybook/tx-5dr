import { describe, expect, it } from 'vitest';

import {
  buildFrequencyAuxControlPlan,
  buildFrequencyOperatingStateRequest,
} from '../radio.js';

describe('buildFrequencyOperatingStateRequest', () => {
  it('builds RX-only operating-state writes when radioMode is omitted', () => {
    expect(buildFrequencyOperatingStateRequest({
      frequency: 14_200_000,
      effectiveMode: 'VOICE',
      engineMode: 'voice',
    })).toEqual({
      frequency: 14_200_000,
      tolerateModeFailure: true,
    });
  });

  it('builds frequency plus CAT mode writes when radioMode is explicit', () => {
    expect(buildFrequencyOperatingStateRequest({
      frequency: 14_200_000,
      radioMode: 'USB',
      effectiveMode: 'VOICE',
      engineMode: 'voice',
    })).toEqual({
      frequency: 14_200_000,
      mode: 'USB',
      bandwidth: 'nochange',
      options: { intent: 'voice' },
      tolerateModeFailure: true,
    });
  });
});

describe('buildFrequencyAuxControlPlan', () => {
  it('skips repeater and tone writes for RX-only requests without radioMode', () => {
    expect(buildFrequencyAuxControlPlan({
      effectiveMode: 'VOICE',
      repeaterShift: 'none',
      toneMode: 'none',
    })).toEqual({ shouldApply: false });
  });

  it('skips repeater and tone writes for explicit non-FM modes', () => {
    expect(buildFrequencyAuxControlPlan({
      effectiveMode: 'VOICE',
      radioMode: 'USB',
      repeaterShift: 'none',
      toneMode: 'none',
    })).toEqual({ shouldApply: false });
  });

  it('applies explicit FM simplex and no-tone payloads', () => {
    expect(buildFrequencyAuxControlPlan({
      effectiveMode: 'VOICE',
      radioMode: 'FM',
      repeaterShift: 'none',
      toneMode: 'none',
    })).toEqual({
      shouldApply: true,
      repeaterDuplex: { repeaterShift: 'none' },
      toneSquelch: { toneMode: 'none' },
    });
  });

  it('applies explicit FM repeater and tone payloads', () => {
    expect(buildFrequencyAuxControlPlan({
      effectiveMode: 'VOICE',
      radioMode: 'FM',
      repeaterShift: 'plus',
      repeaterOffsetHz: 600_000,
      toneMode: 'ctcss',
      ctcssToneTenthsHz: 885,
    })).toEqual({
      shouldApply: true,
      repeaterDuplex: { repeaterShift: 'plus', repeaterOffsetHz: 600_000 },
      toneSquelch: { toneMode: 'ctcss', ctcssToneTenthsHz: 885 },
    });
  });

  it('does not apply FM aux controls when the FM request has no aux payload', () => {
    expect(buildFrequencyAuxControlPlan({
      effectiveMode: 'VOICE',
      radioMode: 'FM',
    })).toEqual({ shouldApply: false });
  });
});
