import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Spinner,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import { api } from '@tx5dr/core';
import type { AuthMeResponse } from '@tx5dr/contracts';
import { useAuth } from '../store/authStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('AccountSecurityModal');

interface AccountSecurityModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AccountSecurityModal({ isOpen, onClose }: AccountSecurityModalProps) {
  const { t } = useTranslation();
  const { state: authState } = useAuth();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const loadState = useCallback(async () => {
    if (!authState.jwt || !isOpen) return;
    try {
      setLoading(true);
      const response = await api.getAuthMe();
      setMe(response);
      setUsername(response.loginCredential.username ?? '');
      setPassword('');
    } catch (error) {
      logger.error('Failed to load account security state', error);
      addToast({
        title: t('auth:accountSecurity.loadFailed'),
        color: 'danger',
        timeout: 3000,
      });
    } finally {
      setLoading(false);
    }
  }, [authState.jwt, isOpen, t]);

  useEffect(() => {
    if (isOpen) {
      void loadState();
    }
  }, [isOpen, loadState]);

  const canSelfManage = me?.loginCredential.allowSelfService ?? false;
  const isConfigured = me?.loginCredential.configured ?? false;
  const passwordRequired = canSelfManage && !isConfigured;

  const isDirty = useMemo(() => {
    if (!me) return false;
    return username.trim() !== (me.loginCredential.username ?? '') || password.length > 0;
  }, [me, password.length, username]);

  const canSave = canSelfManage && username.trim().length >= 3 && (!passwordRequired || password.length >= 8) && isDirty;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    try {
      setSaving(true);
      const response = await api.updateSelfLoginCredential({
        username: username.trim(),
        ...(password ? { password } : {}),
      });
      setMe(response);
      setUsername(response.loginCredential.username ?? '');
      setPassword('');
      addToast({
        title: t('auth:accountSecurity.saveSuccess'),
        color: 'success',
        timeout: 3000,
      });
    } catch (error) {
      logger.error('Failed to update self login credential', error);
      addToast({
        title: t('auth:accountSecurity.saveFailed'),
        description: error instanceof Error ? error.message : t('errors:code.UNKNOWN_ERROR.userMessage'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setSaving(false);
    }
  }, [canSave, password, t, username]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" placement="center">
      <ModalContent>
        <ModalHeader>{t('auth:accountSecurity.title')}</ModalHeader>
        <ModalBody className="gap-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : me ? (
            <>
              <div className="rounded-lg bg-content2 px-4 py-3 text-sm text-default-600">
                <p>{t('auth:accountSecurity.boundToToken', { label: me.label })}</p>
                <p className="mt-1 text-xs text-default-500">
                  {isConfigured
                    ? t('auth:accountSecurity.configuredHint')
                    : t('auth:accountSecurity.notConfiguredHint')}
                </p>
              </div>

              <Input
                label={t('auth:accountSecurity.usernameLabel')}
                placeholder={t('auth:accountSecurity.usernamePlaceholder')}
                value={username}
                onValueChange={setUsername}
                isDisabled={!canSelfManage || saving}
                variant="bordered"
              />

              <Input
                label={t('auth:accountSecurity.passwordLabel')}
                placeholder={isConfigured
                  ? t('auth:accountSecurity.passwordPlaceholderOptional')
                  : t('auth:accountSecurity.passwordPlaceholderRequired')}
                description={isConfigured
                  ? t('auth:accountSecurity.passwordDescriptionOptional')
                  : t('auth:accountSecurity.passwordDescriptionRequired')}
                type="password"
                value={password}
                onValueChange={setPassword}
                isDisabled={!canSelfManage || saving}
                isRequired={passwordRequired}
                variant="bordered"
              />

              {!canSelfManage && (
                <p className="text-warning text-sm">{t('auth:accountSecurity.selfServiceDisabled')}</p>
              )}
            </>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="flat" onPress={onClose}>
            {t('common:button.cancel')}
          </Button>
          <Button
            color="primary"
            onPress={() => void handleSave()}
            isDisabled={!canSave}
            isLoading={saving}
          >
            {t('common:button.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
