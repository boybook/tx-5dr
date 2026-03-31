import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { RealtimeConnectivityIssue } from '@tx5dr/contracts';
import {
  buildRealtimeConnectivityIssue,
  showRealtimeConnectivityIssueToast,
} from '../realtime/realtimeConnectivity';
import { createLogger } from '../utils/logger';

const logger = createLogger('RealtimeCompatFallbackModal');
const COMPAT_RETRY_TIMEOUT_MS = 12000;

interface RealtimeCompatFallbackModalProps {
  isOpen: boolean;
  issue: RealtimeConnectivityIssue | null;
  onConfirm?: (() => Promise<void>) | null;
  onClose: () => void;
}

function getContextHints(issue: RealtimeConnectivityIssue | null, t: (key: string, options?: Record<string, unknown>) => string): string[] {
  if (!issue?.context) {
    return [];
  }

  const hints: string[] = [];
  const signalingPort = issue.context.signalingPort;
  const rtcTcpPort = issue.context.rtcTcpPort;
  const udpPortRange = issue.context.udpPortRange;

  if (typeof signalingPort === 'string' && signalingPort.length > 0) {
    hints.push(t('system.realtimeFallbackDialogPortSignal', { port: signalingPort }));
  }
  if (typeof rtcTcpPort === 'string' && rtcTcpPort.length > 0) {
    hints.push(t('system.realtimeFallbackDialogPortRtcTcp', { port: rtcTcpPort }));
  }
  if (typeof udpPortRange === 'string' && udpPortRange.length > 0) {
    hints.push(t('system.realtimeFallbackDialogPortUdp', { range: udpPortRange }));
  }

  return hints;
}

export function RealtimeCompatFallbackModal({
  isOpen,
  issue,
  onConfirm,
  onClose,
}: RealtimeCompatFallbackModalProps) {
  const { t } = useTranslation('common');
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryIssue, setRetryIssue] = useState<RealtimeConnectivityIssue | null>(null);

  const contextHints = useMemo(() => getContextHints(issue, t), [issue, t]);

  useEffect(() => {
    if (!isOpen) {
      setIsRetrying(false);
      setRetryIssue(null);
    }
  }, [isOpen]);

  const handleClose = () => {
    if (isRetrying) {
      return;
    }
    setRetryIssue(null);
    onClose();
  };

  const handleConfirm = async () => {
    if (!onConfirm) {
      handleClose();
      return;
    }

    setIsRetrying(true);
    setRetryIssue(null);
    let timeoutId: number | null = null;
    try {
      await Promise.race([
        onConfirm(),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            reject(new Error(t('system.realtimeFallbackDialogRetryTimeout')));
          }, COMPAT_RETRY_TIMEOUT_MS);
        }),
      ]);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      handleClose();
    } catch (error) {
      logger.error('Compatibility fallback retry failed', error);
      const nextRetryIssue = buildRealtimeConnectivityIssue(error, {
        scope: issue?.scope ?? 'radio',
        stage: issue?.stage ?? 'connect',
      });
      setRetryIssue(nextRetryIssue);
      showRealtimeConnectivityIssueToast(nextRetryIssue);
    } finally {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      setIsRetrying(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg" isDismissable={!isRetrying} hideCloseButton={isRetrying}>
      <ModalContent>
        <ModalHeader>{t('system.realtimeFallbackDialogTitle')}</ModalHeader>
        <ModalBody className="gap-3">
          <Alert color="warning" variant="flat" title={issue?.userMessage ?? t('system.realtimeFallbackDialogUnknownIssue')} />

          <p className="text-sm text-default-600">
            {t('system.realtimeFallbackDialogDescription')}
          </p>

          {contextHints.length > 0 && (
            <div className="text-sm text-default-700">
              <div className="font-medium mb-1">{t('system.realtimeFallbackDialogPortsTitle')}</div>
              <ul className="list-disc pl-5 space-y-1">
                {contextHints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            </div>
          )}

          {issue?.suggestions && issue.suggestions.length > 0 && (
            <div className="text-sm text-default-700">
              <div className="font-medium mb-1">{t('system.realtimeFallbackDialogSuggestionsTitle')}</div>
              <ul className="list-disc pl-5 space-y-1">
                {issue.suggestions.slice(0, 3).map((suggestion) => (
                  <li key={suggestion}>{suggestion}</li>
                ))}
              </ul>
            </div>
          )}

          <Alert
            color="primary"
            variant="flat"
            title={t('system.realtimeFallbackDialogActionTitle')}
            description={t('system.realtimeFallbackDialogActionDescription')}
          />

          {retryIssue && (
            <Alert
              color="danger"
              variant="flat"
              title={t('system.realtimeFallbackDialogRetryFailedTitle')}
              description={retryIssue.userMessage}
            />
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={handleClose} isDisabled={isRetrying}>
            {t('button.cancel')}
          </Button>
          <Button color="primary" onPress={handleConfirm} isLoading={isRetrying}>
            {t('system.realtimeFallbackDialogConfirm')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
