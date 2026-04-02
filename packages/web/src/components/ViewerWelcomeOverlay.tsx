import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faEye } from '@fortawesome/free-solid-svg-icons';
import { useStationInfo } from '../store/radioStore';
import { StationInfoCard } from './StationInfoCard';
import { AuthLoginForm } from './AuthLoginForm';

interface ViewerWelcomeOverlayProps {
  isOpen: boolean;
}

export function ViewerWelcomeOverlay({ isOpen }: ViewerWelcomeOverlayProps) {
  const { t } = useTranslation();
  const stationInfo = useStationInfo();
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (dismissed) return null;

  return (
    <Modal
      isOpen={isOpen}
      isDismissable={false}
      hideCloseButton
      size="lg"
      placement="center"
      backdrop="blur"
      classNames={{
        body: "px-6 pt-2 pb-4",
        header: "px-6 pt-6 pb-2",
        footer: "border-t border-divider px-6 py-3",
      }}
    >
      <ModalContent>
        <ModalHeader>
          <div className="w-full text-center">
            <h2 className="text-xl font-bold">{t('settings:profileSetup.welcome')}</h2>
          </div>
        </ModalHeader>

        <ModalBody>
          <div className="flex flex-col items-center gap-4">
            {stationInfo && (
              <div className="w-full flex justify-center">
                <StationInfoCard stationInfo={stationInfo} />
              </div>
            )}

            <p className="text-default-600 text-sm text-center">
              {t('settings:profileSetup.viewerWelcomeDesc')}
            </p>

            <div className="w-full max-w-sm space-y-3">
              <AuthLoginForm autoFocus />
            </div>
          </div>
        </ModalBody>

        <ModalFooter>
          <div className="w-full flex justify-center">
            <Button
              variant="light"
              size="sm"
              className="text-default-400"
              onPress={handleDismiss}
              startContent={<FontAwesomeIcon icon={faEye} className="text-xs" />}
            >
              {t('settings:profileSetup.viewerContinue')}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
