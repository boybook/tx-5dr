import type { HamlibConfig, MeterCapabilities, MeterData } from '@tx5dr/contracts';

export const EMPTY_METER_DATA: MeterData = {
  swr: null,
  alc: null,
  level: null,
  power: null,
};

export function hasAnyMeterReading(meterData: MeterData | null | undefined): boolean {
  if (!meterData) {
    return false;
  }

  return meterData.swr !== null
    || meterData.alc !== null
    || meterData.level !== null
    || meterData.power !== null;
}

export function hasAnyMeterCapability(meterCapabilities: MeterCapabilities | null): boolean {
  if (!meterCapabilities) {
    return false;
  }

  return meterCapabilities.strength
    || meterCapabilities.swr
    || meterCapabilities.alc
    || meterCapabilities.power;
}

interface ShouldShowRadioMetersPanelOptions {
  radioConnected: boolean;
  radioConfigType?: HamlibConfig['type'];
  meterCapabilities: MeterCapabilities | null;
  hasReceivedMeterData: boolean;
}

export function shouldShowRadioMetersPanel({
  radioConnected,
  radioConfigType,
  meterCapabilities,
  hasReceivedMeterData,
}: ShouldShowRadioMetersPanelOptions): boolean {
  if (!radioConnected || radioConfigType === 'none' || !hasReceivedMeterData) {
    return false;
  }

  if (meterCapabilities && !hasAnyMeterCapability(meterCapabilities)) {
    return false;
  }

  return true;
}
