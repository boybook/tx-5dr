import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faWaveSquare } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { WSMessageType } from '@tx5dr/contracts';
import { CapabilityControl } from '../CapabilityRegistry';
import type { CapabilityComponentProps } from '../control-types';
import { BooleanCapability } from './BooleanCapability';
import { ActionCapability } from './ActionCapability';
import { useCapabilityDescriptor, useCapabilityState, useConnection, useCurrentOperatorId, usePTTState } from '../../store/radioStore';
import { useCan } from '../../store/authStore';
import { isCapabilityAvailable } from '../availability';

/** Tuner prerequisites wrap the same scalar controls used by every other capability. */
export function TunerCapabilityControl(props: CapabilityComponentProps) {
  const { t } = useTranslation();
  const switchState = useCapabilityState('tuner_switch');
  const tuneState = useCapabilityState('tuner_tune');
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tuning = switchState?.meta?.status === 'tuning';
  useEffect(() => {
    pendingRef.current = false; setPending(false);
    if (timer.current) clearTimeout(timer.current);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [props.scope, props.interactive, props.state?.updatedAt, props.state?.lastError]);
  const available = props.interactive && !pending && !tuning && (props.capabilityId === 'tuner_switch'
    || (switchState?.value === true && isCapabilityAvailable(switchState) && isCapabilityAvailable(tuneState)));
  const onWrite = useCallback<CapabilityComponentProps['onWrite']>((id, value, action) => {
    if (!available || pendingRef.current) return;
    pendingRef.current = true; setPending(true); props.onWrite(id, value, action);
    timer.current = setTimeout(() => { pendingRef.current = false; setPending(false); }, 2000);
  }, [available, props.onWrite]);
  const controlProps = { ...props, interactive: available, onWrite };
  const swr = props.state?.meta?.swr;
  return <span className="cap-item">
    {props.capabilityId === 'tuner_switch' ? <BooleanCapability {...controlProps} /> : <ActionCapability {...controlProps} />}
    {(pending || tuning) && <span className="text-[11px] text-warning-600" role="status">{t('radio:tuner.tuning')}</span>}
    {props.capabilityId === 'tuner_switch' && typeof swr === 'number' && Number.isFinite(swr) && <span className="cap-number-label">SWR {swr.toFixed(2)}</span>}
  </span>;
}

/** The existing tone-tune workflow remains a dedicated operation beside the shared capability controls. */
export function TunerCapabilitySurface() {
  const { t } = useTranslation();
  const canControl = useCan('execute', 'RadioControl');
  const connection = useConnection();
  const { currentOperatorId } = useCurrentOperatorId();
  const { pttStatus, tuneToneStatus } = usePTTState();
  const switchState = useCapabilityState('tuner_switch');
  const tuneState = useCapabilityState('tuner_tune');
  const switchDescriptor = useCapabilityDescriptor('tuner_switch');
  const tuneDescriptor = useCapabilityDescriptor('tuner_tune');
  const [now, setNow] = useState(Date.now());
  const active = tuneToneStatus.active;
  const busy = pttStatus.isTransmitting && !active;
  const elapsed = tuneToneStatus.startedAt ? Math.max(0, Math.floor((now - tuneToneStatus.startedAt) / 1000)) : 0;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  useEffect(() => {
    if (tuneToneStatus.error) addToast({ title: t('radio:tuner.toneStartFailed'), description: tuneToneStatus.error, color: 'danger', timeout: 5000 });
  }, [t, tuneToneStatus.error]);
  if (!canControl) return null;
  const handleTone = () => {
    const wsClient = connection.state.radioService?.wsClientInstance;
    if (!wsClient || busy) return;
    if (active) wsClient.send(WSMessageType.STOP_TUNE_TONE, {});
    else wsClient.send(WSMessageType.START_TUNE_TONE, currentOperatorId ? { operatorId: currentOperatorId } : {});
  };
  return <div className="radio-capability-controls w-64 max-w-[calc(100vw-3rem)] py-2 space-y-3">
    <section className="space-y-2">
      <div className="text-sm font-medium">{t('radio:tuner.builtInTitle')}</div>
      <p className="text-xs text-default-500">{t('radio:tuner.builtInDescription')}</p>
      <div className="cap-item">
        {switchDescriptor && switchState?.supported && <CapabilityControl descriptor={switchDescriptor} state={switchState} />}
        {tuneDescriptor && tuneState?.supported && <CapabilityControl descriptor={tuneDescriptor} state={tuneState} />}
      </div>
      {!switchState?.supported && !tuneState?.supported && <p className="text-xs text-default-500">{t('radio:tuner.builtInUnsupported')}</p>}
    </section>
    <section className="space-y-2 border-t border-divider pt-3">
      <div className="text-sm font-medium">{t('radio:tuner.externalTitle')}</div>
      <p className="text-xs text-default-500">{t('radio:tuner.externalDescription')}</p>
      <Button size="sm" variant={active ? 'solid' : 'flat'} color="danger" onPress={handleTone}
        isDisabled={!connection.state.isConnected || busy} className="w-full font-medium"
        startContent={<FontAwesomeIcon icon={faWaveSquare} className="text-xs" />}>
        {active ? t('radio:tuner.stopToneTune', { seconds: elapsed }) : t('radio:tuner.startToneTune')}
      </Button>
      {busy && <p className="text-xs text-warning-600">{t('radio:tuner.toneBusy')}</p>}
    </section>
  </div>;
}
