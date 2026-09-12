import type { CapabilityDescriptor } from '@tx5dr/contracts';
import { formatCapabilityNumber, fromDisplayNumber, toDisplayNumber, toDisplayStep } from './display-utils';

export type RfPowerInteractionMode = 'percent' | 'hamlib-discrete';

export function getDiscreteNumberOptions(descriptor: CapabilityDescriptor) {
  return (descriptor.discreteOptions ?? []).filter(
    (option): option is { value: number; label?: string; labelI18nKey?: string } => typeof option.value === 'number' && Number.isFinite(option.value),
  );
}

export function canUseRfPowerDiscreteMode(id: string, options: Array<{ value: number }>): boolean {
  return id === 'rf_power' && options.length >= 2;
}

export function shouldUseDiscreteSlider(id: string, usesSlider: boolean, options: Array<{ value: number }>, mode: RfPowerInteractionMode): boolean {
  return usesSlider && options.length >= 2 && (id !== 'rf_power' || mode === 'hamlib-discrete');
}

export function findDiscreteOptionIndex(options: Array<{ value: number }>, value: number | null | undefined): number {
  if (!options.length || value == null || !Number.isFinite(value)) return 0;
  return options.reduce((nearest, option, index) => Math.abs(option.value - value) < Math.abs(options[nearest].value - value) ? index : nearest, 0);
}

export function getDiscreteOptionDisplayText(options: ReturnType<typeof getDiscreteNumberOptions>, descriptor: CapabilityDescriptor, value: number, t: (key: string) => string): string {
  const option = options[findDiscreteOptionIndex(options, value)];
  return option?.labelI18nKey ? t(option.labelI18nKey) : option?.label ?? formatCapabilityNumber(option?.value ?? value, descriptor);
}

/** Input numbers and slider values deliberately use separate coordinate systems. */
export function toInputNumber(value: number, descriptor: CapabilityDescriptor): number {
  return descriptor.display?.mode === 'percent' ? value * 100 : toDisplayNumber(value, descriptor);
}

export function inputStep(descriptor: CapabilityDescriptor): number | 'any' {
  const step = (descriptor.range ?? descriptor.limits)?.step;
  return step == null ? 'any' : descriptor.display?.mode === 'percent' ? step * 100 : toDisplayStep(step, descriptor);
}

export function parseControlNumber(text: string, descriptor: CapabilityDescriptor, discrete = false): number | null {
  if (!text.trim()) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) return null;
  let value = descriptor.display?.mode === 'percent' ? number / 100 : fromDisplayNumber(number, descriptor);
  if (!Number.isFinite(value)) return null;
  const limits = descriptor.range ?? descriptor.limits;
  value = Math.max(limits?.min ?? -Infinity, Math.min(limits?.max ?? Infinity, value));
  if (discrete) {
    const options = getDiscreteNumberOptions(descriptor);
    if (options.length) return options[findDiscreteOptionIndex(options, value)].value;
  }
  if (limits?.step && limits.step > 0) {
    const origin = limits.min ?? 0;
    value = Number((origin + Math.round((value - origin) / limits.step) * limits.step).toPrecision(12));
    value = Math.max(limits.min ?? -Infinity, Math.min(limits.max ?? Infinity, value));
  }
  return value;
}

export function controlEditingKey(descriptor: CapabilityDescriptor): string {
  return JSON.stringify([descriptor.id, descriptor.sessionId, descriptor.target, descriptor.readable, descriptor.writable,
    descriptor.range, descriptor.limits, descriptor.display, descriptor.options, descriptor.discreteOptions, descriptor.writeGroup]);
}

export function numberInputWidth(descriptor: CapabilityDescriptor, value: number | null): string {
  const limits = descriptor.range ?? descriptor.limits;
  const examples = [limits?.min, limits?.max, value].filter((v): v is number => v != null && Number.isFinite(v));
  const length = Math.max(3, ...examples.map(v => formatCapabilityNumber(v, descriptor, false).length));
  return `${Math.min(22, length) + 1}ch`;
}

/** HTML number inputs reject a leading plus; signs in read-only display stay intact. */
export function formatControlInput(value: number, descriptor: CapabilityDescriptor): string {
  return formatCapabilityNumber(value, descriptor, false).replace(/^\+/, '');
}
