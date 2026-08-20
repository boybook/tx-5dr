import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faShieldHalved } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import {
  OBSERVABILITY_NOTICE_VERSION,
  type ObservabilityStatus,
} from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import { shouldRequestObservabilityConsent } from './observabilityConsent';

const logger = createLogger('ObservabilityConsentModal');

interface ObservabilityConsentModalProps {
  enabled: boolean;
}

type PendingChoice = 'accept' | 'decline' | null;

export function ObservabilityConsentModal({ enabled }: ObservabilityConsentModalProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ObservabilityStatus | null>(null);
  const [pendingChoice, setPendingChoice] = useState<PendingChoice>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    api.getObservabilityStatus()
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus);
      })
      .catch((error) => {
        logger.error('Failed to load anonymous usage statistics consent status', error);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const saveChoice = useCallback(async (accepted: boolean) => {
    const choice: PendingChoice = accepted ? 'accept' : 'decline';
    setPendingChoice(choice);
    setSaveFailed(false);
    try {
      const nextStatus = await api.updateObservabilitySettings({
        enabled: accepted,
        noticeVersion: OBSERVABILITY_NOTICE_VERSION,
      });
      setStatus(nextStatus);
    } catch (error) {
      logger.error('Failed to save anonymous usage statistics consent', error);
      setSaveFailed(true);
    } finally {
      setPendingChoice(null);
    }
  }, []);

  const isOpen = shouldRequestObservabilityConsent(enabled, status);
  const isSaving = pendingChoice !== null;

  return (
    <Modal
      isOpen={isOpen}
      isDismissable={false}
      hideCloseButton
      size="2xl"
      placement="center"
      backdrop="blur"
      scrollBehavior="inside"
      classNames={{
        header: 'px-6 pt-6 pb-2',
        body: 'px-6 py-3',
        footer: 'border-t border-divider px-6 py-4',
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary dark:bg-primary-100/10">
              <FontAwesomeIcon icon={faShieldHalved} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-default-900">
                {t('system.anonymousTelemetryConsentTitle')}
              </h2>
              <p className="mt-1 text-sm font-normal leading-6 text-default-600">
                {t('system.anonymousTelemetryConsentIntro')}
              </p>
            </div>
          </div>
        </ModalHeader>

        <ModalBody>
          <div className="grid gap-3 md:grid-cols-2">
            <section className="rounded-large border border-divider bg-default-50 p-4 dark:bg-default-100/5">
              <h3 className="text-sm font-semibold text-default-900">
                {t('system.anonymousTelemetryCollectedTitle')}
              </h3>
              <p className="mt-2 text-sm leading-6 text-default-600">
                {t('system.anonymousTelemetryCollected')}
              </p>
            </section>

            <section className="rounded-large border border-divider bg-default-50 p-4 dark:bg-default-100/5">
              <h3 className="text-sm font-semibold text-default-900">
                {t('system.anonymousTelemetryNeverCollectedTitle')}
              </h3>
              <p className="mt-2 text-sm leading-6 text-default-600">
                {t('system.anonymousTelemetryNeverCollected')}
              </p>
            </section>
          </div>

          <div className="space-y-2 rounded-large bg-primary-50/70 px-4 py-3 text-sm leading-6 text-primary-800 dark:bg-primary-100/10 dark:text-primary-300">
            <p>{t('system.anonymousTelemetryMeasurementNote')}</p>
            <p>{t('system.anonymousTelemetryConsentFooter')}</p>
          </div>

          {status && !status.endpointConfigured && (
            <p className="text-sm leading-6 text-default-500">
              {t('system.anonymousTelemetryUnavailable')}
            </p>
          )}

          {saveFailed && (
            <p role="alert" className="text-sm leading-6 text-danger">
              {t('system.anonymousTelemetryConsentSaveFailed')}
            </p>
          )}
        </ModalBody>

        <ModalFooter>
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="flat"
              onPress={() => void saveChoice(false)}
              isDisabled={isSaving}
              isLoading={pendingChoice === 'decline'}
              className="sm:min-w-40"
            >
              {t('system.anonymousTelemetryDecline')}
            </Button>
            <Button
              color="primary"
              onPress={() => void saveChoice(true)}
              isDisabled={isSaving}
              isLoading={pendingChoice === 'accept'}
              className="sm:min-w-40"
            >
              {t('system.anonymousTelemetryAccept')}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
