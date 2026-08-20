import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartLine } from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import {
  OBSERVABILITY_NOTICE_VERSION,
  type ObservabilityStatus,
} from '@tx5dr/contracts';
import { createLogger } from '../../utils/logger';
import { shouldRequestObservabilityConsent } from './observabilityConsent';

const logger = createLogger('ObservabilityConsentBanner');

interface ObservabilityConsentBannerProps {
  enabled: boolean;
}

type PendingChoice = 'accept' | 'decline' | null;

export function ObservabilityConsentBanner({ enabled }: ObservabilityConsentBannerProps) {
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

  if (!shouldRequestObservabilityConsent(enabled, status)) return null;

  const isSaving = pendingChoice !== null;

  return (
    <section
      aria-labelledby="observability-consent-title"
      className="app-safe-area-pb relative z-20 shrink-0 overflow-hidden border-t border-primary-100/80 bg-primary-50 dark:border-primary-900/20 dark:bg-primary-100/10"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:gap-6">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <FontAwesomeIcon
            icon={faChartLine}
            className="mt-1 shrink-0 text-base text-primary"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id="observability-consent-title" className="text-sm font-semibold text-default-900 sm:text-base">
                {t('system.anonymousTelemetryConsentTitle')}
              </h2>
              <p className="text-sm leading-5 text-default-700">
                {t('system.anonymousTelemetryBannerSummary')}
              </p>
            </div>
            <p className="mt-1 text-xs leading-5 text-default-500">
              {t('system.anonymousTelemetryBannerPrivacy')}
            </p>
            {saveFailed && (
              <p role="alert" className="mt-1 text-sm leading-5 text-danger">
                {t('system.anonymousTelemetryConsentSaveFailed')}
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-row justify-end gap-2 self-end lg:self-auto">
          <Button
            size="sm"
            variant="flat"
            onPress={() => void saveChoice(false)}
            isDisabled={isSaving}
            isLoading={pendingChoice === 'decline'}
          >
            {t('system.anonymousTelemetryDecline')}
          </Button>
          <Button
            size="sm"
            color="primary"
            onPress={() => void saveChoice(true)}
            isDisabled={isSaving}
            isLoading={pendingChoice === 'accept'}
          >
            {t('system.anonymousTelemetryAccept')}
          </Button>
        </div>
      </div>
    </section>
  );
}
