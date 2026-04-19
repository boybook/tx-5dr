export interface SliderWheelUpdateOptions {
  currentValue: number;
  min: number;
  max: number;
  step: number;
  deltaY: number;
  deltaMode: number;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  enableWheel?: boolean;
  pixelRemainder?: number;
}

export interface SliderWheelUpdateResult {
  consumed: boolean;
  nextValue: number;
  pixelRemainder: number;
  stepCount: number;
}

const PIXELS_PER_STEP = 40;
const LINE_DELTA_MODE = 1;
const PAGE_DELTA_MODE = 2;
const EPSILON = 1e-9;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const countStepDecimals = (step: number): number => {
  if (!Number.isFinite(step) || step <= 0) {
    return 0;
  }

  const normalized = step.toString().toLowerCase();
  if (normalized.includes('e-')) {
    const [, exponent] = normalized.split('e-');
    return Number.parseInt(exponent ?? '0', 10);
  }

  const decimalIndex = normalized.indexOf('.');
  return decimalIndex >= 0 ? normalized.length - decimalIndex - 1 : 0;
};

const roundToStepPrecision = (value: number, step: number): number => {
  const decimals = countStepDecimals(step);
  return Number(value.toFixed(decimals));
};

const getLineStepCount = (deltaY: number): number => {
  if (deltaY === 0) {
    return 0;
  }

  const magnitude = Math.max(1, Math.round(Math.abs(deltaY)));
  return deltaY < 0 ? magnitude : -magnitude;
};

export function computeSliderWheelUpdate({
  currentValue,
  min,
  max,
  step,
  deltaY,
  deltaMode,
  disabled = false,
  orientation = 'vertical',
  enableWheel = true,
  pixelRemainder = 0,
}: SliderWheelUpdateOptions): SliderWheelUpdateResult {
  if (
    disabled
    || !enableWheel
    || orientation !== 'vertical'
    || !Number.isFinite(currentValue)
    || !Number.isFinite(min)
    || !Number.isFinite(max)
    || !Number.isFinite(step)
    || step <= 0
    || !Number.isFinite(deltaY)
    || deltaY === 0
  ) {
    return {
      consumed: false,
      nextValue: currentValue,
      pixelRemainder,
      stepCount: 0,
    };
  }

  let nextPixelRemainder = pixelRemainder;
  let stepCount = 0;

  if (deltaMode === LINE_DELTA_MODE) {
    stepCount = getLineStepCount(deltaY);
    nextPixelRemainder = 0;
  } else if (deltaMode === PAGE_DELTA_MODE) {
    stepCount = getLineStepCount(deltaY) * 3;
    nextPixelRemainder = 0;
  } else {
    nextPixelRemainder += deltaY;
    if (Math.abs(nextPixelRemainder) >= PIXELS_PER_STEP) {
      const wholeSteps = Math.trunc(Math.abs(nextPixelRemainder) / PIXELS_PER_STEP);
      stepCount = nextPixelRemainder < 0 ? wholeSteps : -wholeSteps;
      nextPixelRemainder -= Math.sign(nextPixelRemainder) * wholeSteps * PIXELS_PER_STEP;
    }
  }

  if (stepCount === 0) {
    return {
      consumed: false,
      nextValue: currentValue,
      pixelRemainder: nextPixelRemainder,
      stepCount: 0,
    };
  }

  const rawNextValue = currentValue + stepCount * step;
  const nextValue = roundToStepPrecision(clamp(rawNextValue, min, max), step);

  if (Math.abs(nextValue - currentValue) < EPSILON) {
    return {
      consumed: false,
      nextValue: currentValue,
      pixelRemainder: nextPixelRemainder,
      stepCount,
    };
  }

  return {
    consumed: true,
    nextValue,
    pixelRemainder: nextPixelRemainder,
    stepCount,
  };
}

export const sliderWheelConstants = {
  PIXELS_PER_STEP,
};
