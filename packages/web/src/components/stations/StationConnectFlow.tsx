import React, { useState } from 'react';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Divider, Spinner } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faShieldHalved, faTowerBroadcast } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { DesktopRemoteStationView, DesktopStationConnectState } from '@tx5dr/contracts';
import { CertificateDetails } from './CertificateDetails';
import { describeConnectError, displayHost } from './stationText';

const ease = [0.16, 1, 0.3, 1] as const;

const STEPS = [
  { phase: 'probing', labelKey: 'connect.stepProbe' },
  { phase: 'gateway', labelKey: 'connect.stepGateway' },
  { phase: 'loading', labelKey: 'connect.stepLoad' },
] as const;

function activeStepIndex(phase: DesktopStationConnectState['phase'] | undefined): number {
  if (!phase || phase === 'probing') return 0;
  if (phase === 'gateway') return 1;
  if (phase === 'loading') return 2;
  return STEPS.length;
}

const ConnectSteps: React.FC<{ phase: DesktopStationConnectState['phase'] | undefined }> = ({ phase }) => {
  const { t } = useTranslation('stations');
  const current = activeStepIndex(phase);
  return (
    <ol className="flex flex-col gap-3" aria-live="polite">
      {STEPS.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step.phase} className="flex items-center gap-3">
            <span className="relative flex h-6 w-6 flex-shrink-0 items-center justify-center">
              <AnimatePresence mode="wait" initial={false}>
                {done ? (
                  <motion.span
                    key="done"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.4, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 30 }}
                    className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground"
                  >
                    <FontAwesomeIcon icon={faCheck} className="text-[11px]" />
                  </motion.span>
                ) : active ? (
                  <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Spinner size="sm" color="primary" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="pending"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="h-2 w-2 rounded-full bg-default-300"
                  />
                )}
              </AnimatePresence>
            </span>
            <span className={`text-small transition-colors duration-200 ${active ? 'font-medium text-foreground' : done ? 'text-default-600' : 'text-default-400'}`}>
              {t(step.labelKey)}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

export interface StationConnectFlowProps {
  station: DesktopRemoteStationView;
  connection: DesktopStationConnectState | null;
  onRetry: () => void;
  onTrust: (fingerprint256: string) => void;
  onOpenEmbedded: () => void;
  onManage: () => void;
  busy?: boolean;
}

/** Connection progress, certificate decisions and failures for one remote station. */
export const StationConnectFlow: React.FC<StationConnectFlowProps> = ({
  station,
  connection,
  onRetry,
  onTrust,
  onOpenEmbedded,
  onManage,
  busy = false,
}) => {
  const { t } = useTranslation('stations');
  const [confirmedChange, setConfirmedChange] = useState(false);
  const phase = connection?.phase;
  const view = phase === 'needs-trust' ? 'trust' : phase === 'failed' ? 'failed' : 'progress';
  const changed = connection?.error?.kind === 'certificate-changed' ? connection.changed ?? null : null;
  const certificateIssue = view === 'trust' || changed !== null;

  const secondaryActions = (
    <>
      <Button variant="flat" onPress={onOpenEmbedded} isDisabled={busy}>{t('actions.openEmbedded')}</Button>
      <Button variant="light" onPress={onManage} isDisabled={busy}>{t('actions.manage')}</Button>
    </>
  );

  return (
    <Card shadow="md" className="w-full max-w-[480px] border border-default-100">
      <CardHeader className="flex items-center gap-3 px-6 pb-3 pt-5">
        <span className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-large transition-colors duration-200 ${certificateIssue ? 'bg-warning/15 text-warning' : view === 'failed' ? 'bg-danger/10 text-danger' : 'bg-primary/10 text-primary'}`}>
          <FontAwesomeIcon icon={certificateIssue ? faShieldHalved : faTowerBroadcast} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-medium font-semibold text-foreground">{station.label}</p>
          <p className="truncate font-mono text-tiny text-default-500">{displayHost(station.url)}</p>
        </div>
      </CardHeader>
      <Divider />
      <CardBody className="px-6 py-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease }}
            className="flex flex-col gap-5"
          >
            {view === 'progress' && (
              <>
                <p className="text-small text-default-500">{t('connect.title')}</p>
                <ConnectSteps phase={phase} />
                {connection?.notice === 'portReassigned' && (
                  <Alert color="warning" variant="flat" description={t('connect.portReassigned')} />
                )}
              </>
            )}

            {view === 'trust' && connection?.certificate && (
              <>
                <Alert color="warning" variant="flat" title={t('cert.untrustedTitle')} description={t('cert.untrustedBody')} />
                <CertificateDetails fingerprint256={connection.certificate.fingerprint256} certificate={connection.certificate} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    color="primary"
                    isLoading={busy}
                    onPress={() => onTrust(connection.certificate!.fingerprint256)}
                  >
                    {t('actions.trustAndConnect')}
                  </Button>
                  {secondaryActions}
                </div>
              </>
            )}

            {view === 'failed' && (
              <>
                <Alert
                  color="danger"
                  variant="flat"
                  title={changed ? t('cert.changedTitle') : t('connect.failedTitle')}
                  description={describeConnectError(t, connection?.error)}
                />
                {changed && (
                  <>
                    <CertificateDetails
                      fingerprint256={changed.actual ?? ''}
                      previousFingerprint256={changed.expected}
                    />
                    <Checkbox
                      size="sm"
                      color="danger"
                      isSelected={confirmedChange}
                      onValueChange={setConfirmedChange}
                      isDisabled={!changed.actual}
                    >
                      <span className="text-small">{t('cert.changedConfirm')}</span>
                    </Checkbox>
                  </>
                )}
                <div className="flex flex-wrap gap-2">
                  {changed && (
                    <Button
                      color="danger"
                      variant="solid"
                      isDisabled={!confirmedChange || !changed.actual}
                      isLoading={busy}
                      onPress={() => changed.actual && onTrust(changed.actual)}
                    >
                      {t('actions.trustNewAndConnect')}
                    </Button>
                  )}
                  <Button color={changed ? 'default' : 'primary'} variant={changed ? 'flat' : 'solid'} onPress={onRetry} isLoading={busy && !changed}>
                    {t('actions.retry')}
                  </Button>
                  {secondaryActions}
                </div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </CardBody>
    </Card>
  );
};
