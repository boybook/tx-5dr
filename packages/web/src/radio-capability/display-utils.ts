import type { CapabilityDescriptor, CapabilityOption } from '@tx5dr/contracts';
import type { TFunction } from 'i18next';

function getDisplayDecimals(descriptor: CapabilityDescriptor): number {
  return descriptor.display?.decimals ?? 0;
}

function formatSigned(value: number, signed: boolean | undefined, decimals: number): string {
  const formatted = value.toFixed(decimals);
  if (signed && value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}

export function toDisplayNumber(rawValue: number, descriptor: CapabilityDescriptor): number {
  switch (descriptor.display?.unit) {
    case 'kHz':
      return rawValue / 1000;
    case 'toneHz':
      return rawValue / 10;
    default:
      return rawValue;
  }
}

export function fromDisplayNumber(displayValue: number, descriptor: CapabilityDescriptor): number {
  switch (descriptor.display?.unit) {
    case 'kHz':
      return Math.round(displayValue * 1000);
    case 'toneHz':
      return Math.round(displayValue * 10);
    default:
      return displayValue;
  }
}

export function formatCapabilityNumber(value: number, descriptor: CapabilityDescriptor, includeUnit = true): string {
  const mode = descriptor.display?.mode;
  if (mode === 'percent') {
    return `${Math.round(value * 100)}${includeUnit ? '%' : ''}`;
  }

  const decimals = getDisplayDecimals(descriptor);
  const displayValue = toDisplayNumber(value, descriptor);
  const numberText = formatSigned(displayValue, descriptor.display?.signed, decimals);

  if (!includeUnit) {
    return numberText;
  }

  switch (descriptor.display?.unit) {
    case 'Hz':
      return `${numberText} Hz`;
    case 'kHz':
      return `${numberText} kHz`;
    case 'toneHz':
      return `${numberText} Hz`;
    default:
      return numberText;
  }
}

export function formatCapabilityOption(option: CapabilityOption, descriptor: CapabilityDescriptor, t: TFunction): string {
  if (option.labelI18nKey) {
    return t(option.labelI18nKey);
  }

  if (option.label) {
    return option.label;
  }

  if (typeof option.value === 'number') {
    if (descriptor.display?.unit === 'code') {
      return option.value.toString().padStart(3, '0');
    }
    return formatCapabilityNumber(option.value, descriptor, true);
  }

  return option.value;
}
