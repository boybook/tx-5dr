import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKey, faEye } from '@fortawesome/free-solid-svg-icons';
import { useAuth } from '../store/authStore';
import { useStationInfo } from '../store/radioStore';
import { StationInfoCard } from './StationInfoCard';

interface ViewerWelcomeOverlayProps {
  isOpen: boolean;
}

export function ViewerWelcomeOverlay({ isOpen }: ViewerWelcomeOverlayProps) {
  const { t } = useTranslation();
  const { login, state: authState } = useAuth();
  const stationInfo = useStationInfo();
  const [token, setToken] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const handleLogin = useCallback(async () => {
    if (!token.trim()) return;
    setLoginError(null);
    setLoginLoading(true);
    try {
      const success = await login(token.trim());
      if (!success) {
        setLoginError(authState.loginError || t('settings:profileSetup.viewerPermissionInsufficient'));
      }
    } catch {
      setLoginError(t('settings:profileSetup.viewerPermissionInsufficient'));
    } finally {
      setLoginLoading(false);
    }
  }, [token, login, authState.loginError, t]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  }, [handleLogin]);

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
              <Input
                label={t('settings:profileSetup.viewerTokenLabel')}
                placeholder={t('settings:profileSetup.viewerTokenPlaceholder')}
                type="password"
                variant="bordered"
                value={token}
                onValueChange={setToken}
                onKeyDown={handleKeyDown}
                startContent={<FontAwesomeIcon icon={faKey} className="text-default-400" />}
                isDisabled={loginLoading}
              />

              {loginError && (
                <p className="text-danger text-sm">{loginError}</p>
              )}

              <Button
                color="primary"
                variant="solid"
                fullWidth
                isLoading={loginLoading}
                onPress={handleLogin}
                isDisabled={!token.trim()}
              >
                {t('settings:profileSetup.viewerLogin')}
              </Button>
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
