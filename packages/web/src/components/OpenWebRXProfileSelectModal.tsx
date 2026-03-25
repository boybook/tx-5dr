import { useState, useCallback } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Select,
  SelectItem,
  Alert,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import { UserRole } from '@tx5dr/contracts';
import type {
  OpenWebRXProfileSelectRequest,
  OpenWebRXProfileVerifyResult,
} from '@tx5dr/contracts';
import { useWSEvent } from '../hooks/useWSEvent';
import { useConnection } from '../store/radioStore';
import { useHasMinRole } from '../store/authStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('OpenWebRXProfileSelectModal');

interface VerifyResult {
  success: boolean;
  centerFreq?: number;
  sampRate?: number;
  error?: string;
}

export function OpenWebRXProfileSelectModal() {
  const { t } = useTranslation();
  const { state } = useConnection();
  const radioService = state.radioService;
  const isAdmin = useHasMinRole(UserRole.ADMIN);

  const [isOpen, setIsOpen] = useState(false);
  const [request, setRequest] = useState<OpenWebRXProfileSelectRequest | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);

  // Listen for profile select requests from server
  useWSEvent(
    radioService,
    'openwebrxProfileSelectRequest',
    useCallback((data: OpenWebRXProfileSelectRequest) => {
      logger.info('Profile select request received', {
        requestId: data.requestId,
        targetFrequency: data.targetFrequency,
        profileCount: data.profiles.length,
      });
      setRequest(data);
      setSelectedProfileId(data.currentProfileId ?? '');
      setVerifyResult(null);
      setIsVerifying(false);
      setIsOpen(true);
    }, [])
  );

  // Listen for verify results from server
  useWSEvent(
    radioService,
    'openwebrxProfileVerifyResult',
    useCallback((data: OpenWebRXProfileVerifyResult) => {
      if (!request || data.requestId !== request.requestId) return;

      logger.info('Profile verify result received', {
        requestId: data.requestId,
        success: data.success,
        profileId: data.profileId,
      });

      setIsVerifying(false);

      if (data.success) {
        setVerifyResult({ success: true });
        addToast({
          title: t('settings:openwebrx.profileSelect.verified'),
          description: t('settings:openwebrx.profileSelect.verifySuccess'),
          color: 'success',
          timeout: 3000,
        });
        // Auto-close after a short delay
        setTimeout(() => {
          setIsOpen(false);
          setRequest(null);
        }, 1500);
      } else {
        setVerifyResult({
          success: false,
          centerFreq: data.centerFreq,
          sampRate: data.sampRate,
          error: data.error,
        });
      }
    }, [request, t])
  );

  const handleVerify = useCallback(() => {
    if (!radioService || !request || !selectedProfileId) return;

    setIsVerifying(true);
    setVerifyResult(null);

    radioService.wsClientInstance.send('openwebrxProfileSelectResponse', {
      requestId: request.requestId,
      profileId: selectedProfileId,
      targetFrequency: request.targetFrequency,
    });
  }, [radioService, request, selectedProfileId]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setRequest(null);
    setVerifyResult(null);
    setIsVerifying(false);
  }, []);

  // Show toast when profile switch is queued due to cooldown
  useWSEvent(
    radioService,
    'openwebrxCooldownNotice',
    useCallback((data: { waitMs: number }) => {
      const waitSec = Math.ceil(data.waitMs / 1000);
      addToast({
        title: t('settings:openwebrx.cooldown.title'),
        description: t('settings:openwebrx.cooldown.message', { seconds: waitSec }),
        color: 'warning',
        timeout: data.waitMs + 1000,
      });
    }, [t])
  );

  // Only show for admin users
  if (!isAdmin) return null;

  const targetFreqMHz = request ? (request.targetFrequency / 1_000_000).toFixed(3) : '';

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      size="lg"
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader>
          {t('settings:openwebrx.profileSelect.title')}
        </ModalHeader>
        <ModalBody>
          <Alert color="warning" variant="flat">
            {t('settings:openwebrx.profileSelect.explanation', {
              frequency: targetFreqMHz,
            })}
          </Alert>

          <Alert color="danger" variant="flat" className="mt-3">
            {t('settings:openwebrx.profileSelect.botWarning')}
          </Alert>

          <div className="mt-4">
            <span className="text-sm text-default-500">
              {t('settings:openwebrx.profileSelect.targetFrequency')}:
            </span>{' '}
            <span className="font-mono font-semibold">{targetFreqMHz} MHz</span>
          </div>

          <Select
            className="mt-3"
            label={t('settings:openwebrx.profileSelect.selectProfile')}
            selectedKeys={selectedProfileId ? [selectedProfileId] : []}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              if (selected) {
                setSelectedProfileId(selected);
                setVerifyResult(null);
              }
            }}
          >
            {(request?.profiles ?? []).map((profile) => (
              <SelectItem key={profile.id}>{profile.name}</SelectItem>
            ))}
          </Select>

          {verifyResult && (
            <div className="mt-3">
              {verifyResult.success ? (
                <Alert color="success" variant="flat">
                  {t('settings:openwebrx.profileSelect.verifySuccess')}
                </Alert>
              ) : (
                <Alert color="danger" variant="flat">
                  {verifyResult.centerFreq != null && verifyResult.sampRate != null
                    ? t('settings:openwebrx.profileSelect.verifyFailed', {
                        centerFreq: (verifyResult.centerFreq / 1_000_000).toFixed(3),
                        bandwidth: (verifyResult.sampRate / 2 / 1_000_000).toFixed(3),
                      })
                    : verifyResult.error ?? t('settings:openwebrx.profileSelect.verifyFailed', {
                        centerFreq: '?',
                        bandwidth: '?',
                      })}
                </Alert>
              )}
            </div>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={handleClose}>
            {t('common:cancel')}
          </Button>
          <Button
            color="primary"
            isLoading={isVerifying}
            isDisabled={!selectedProfileId || isVerifying}
            onPress={handleVerify}
          >
            {isVerifying
              ? t('settings:openwebrx.profileSelect.verifying')
              : t('settings:openwebrx.profileSelect.verify')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
