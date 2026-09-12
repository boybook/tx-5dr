import { usePTTState, useRadioConnectionState, useRadioMeters } from '../../../store/radio/hooks';
import { EMPTY_METER_DATA, shouldShowRadioMetersPanel } from '../../../utils/radioMeters';
import { RadioMetersDisplay } from './RadioMetersDisplay';

/** Keep live meter subscriptions below the workspace layout and spectrum. */
export function RadioMetersPanel({ className, enableAlcOverLimitPrompt }: {
  className?: string;
  enableAlcOverLimitPrompt?: boolean;
}) {
  const { meterData, meterCapabilities, hasReceivedMeterData } = useRadioMeters();
  const { radioConnected, radioConfig } = useRadioConnectionState();
  const { pttStatus } = usePTTState();
  if (!shouldShowRadioMetersPanel({ radioConnected, radioConfigType: radioConfig.type, meterCapabilities, hasReceivedMeterData })) {
    return null;
  }
  const meters = <RadioMetersDisplay
    meterData={meterData ?? EMPTY_METER_DATA}
    meterCapabilities={meterCapabilities}
    isPttActive={pttStatus.isTransmitting}
    enableAlcOverLimitPrompt={enableAlcOverLimitPrompt}
  />;
  return className ? <div className={className}>{meters}</div> : meters;
}
