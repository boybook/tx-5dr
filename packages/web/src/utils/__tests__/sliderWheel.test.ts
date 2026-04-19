import { describe, expect, it } from 'vitest';

import { computeSliderWheelUpdate, sliderWheelConstants } from '../sliderWheel';

const PIXEL_DELTA_MODE = 0;
const LINE_DELTA_MODE = 1;

describe('sliderWheel', () => {
  it('increments by one step when scrolling up in line mode', () => {
    expect(computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -1,
      deltaMode: LINE_DELTA_MODE,
    })).toMatchObject({
      consumed: true,
      nextValue: 0.1,
      stepCount: 1,
      pixelRemainder: 0,
    });
  });

  it('decrements by one step when scrolling down in line mode', () => {
    expect(computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: 1,
      deltaMode: LINE_DELTA_MODE,
    })).toMatchObject({
      consumed: true,
      nextValue: -0.1,
      stepCount: -1,
      pixelRemainder: 0,
    });
  });

  it('clamps at the configured maximum', () => {
    expect(computeSliderWheelUpdate({
      currentValue: 19.95,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -1,
      deltaMode: LINE_DELTA_MODE,
    })).toMatchObject({
      consumed: true,
      nextValue: 20,
      stepCount: 1,
    });
  });

  it('does not consume events when disabled', () => {
    expect(computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -1,
      deltaMode: LINE_DELTA_MODE,
      disabled: true,
      pixelRemainder: 5,
    })).toMatchObject({
      consumed: false,
      nextValue: 0,
      stepCount: 0,
      pixelRemainder: 5,
    });
  });

  it('accumulates pixel deltas until the threshold is reached', () => {
    const pending = computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -(sliderWheelConstants.PIXELS_PER_STEP / 2),
      deltaMode: PIXEL_DELTA_MODE,
    });

    expect(pending).toMatchObject({
      consumed: false,
      nextValue: 0,
      stepCount: 0,
      pixelRemainder: -(sliderWheelConstants.PIXELS_PER_STEP / 2),
    });

    const committed = computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -(sliderWheelConstants.PIXELS_PER_STEP / 2),
      deltaMode: PIXEL_DELTA_MODE,
      pixelRemainder: pending.pixelRemainder,
    });

    expect(committed).toMatchObject({
      consumed: true,
      nextValue: 0.1,
      stepCount: 1,
      pixelRemainder: 0,
    });
  });

  it('does not handle horizontal sliders', () => {
    expect(computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -1,
      deltaMode: LINE_DELTA_MODE,
      orientation: 'horizontal',
    })).toMatchObject({
      consumed: false,
      nextValue: 0,
      stepCount: 0,
    });
  });

  it('does not handle wheel when explicitly disabled by option', () => {
    expect(computeSliderWheelUpdate({
      currentValue: 0,
      min: -60,
      max: 20,
      step: 0.1,
      deltaY: -1,
      deltaMode: LINE_DELTA_MODE,
      enableWheel: false,
    })).toMatchObject({
      consumed: false,
      nextValue: 0,
      stepCount: 0,
    });
  });
});
