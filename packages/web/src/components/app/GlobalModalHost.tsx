import React, { lazy, memo, Suspense, useEffect, useState } from 'react';
import { useHasMinRole } from '../../store/authStore';
import { UserRole, type RemoteAccessPreset } from '@tx5dr/contracts';
import type { SettingsTab } from '../settings/SettingsModal';
import { Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { AccountSecurityModal } from '../auth/AccountSecurityModal';

const SettingsModal = lazy(() => import('../settings/SettingsModal').then(module => ({ default: module.SettingsModal })));
const ProfileModal = lazy(() => import('../radio/profile/ProfileModal').then(module => ({ default: module.ProfileModal })));

export const OPEN_ACCOUNT_SECURITY_MODAL_EVENT = 'openAccountSecurityModal';

function GlobalModalHostInner() {
  const { t } = useTranslation('common');
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('radio');
  const [settingsInitialFrequencyPresetMode, setSettingsInitialFrequencyPresetMode] = useState<string | undefined>(undefined);
  const [settingsInitialRemoteAccessPreset, setSettingsInitialRemoteAccessPreset] = useState<RemoteAccessPreset | undefined>(undefined);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isAccountSecurityOpen, setIsAccountSecurityOpen] = useState(false);

  useEffect(() => {
    const handleOpenProfileModal = () => {
      if (isAdmin) {
        setIsProfileModalOpen(true);
      }
    };

    const handleOpenSettingsModal = (event: Event) => {
      const customEvent = event as CustomEvent<{
        tab?: SettingsTab;
        frequencyPresetMode?: string;
        remoteAccessPreset?: RemoteAccessPreset;
      }>;
      const tab = customEvent.detail?.tab;
      const frequencyPresetMode = customEvent.detail?.frequencyPresetMode;
      if (tab) {
        setSettingsInitialTab(tab);
      }

      setSettingsInitialFrequencyPresetMode(
        typeof frequencyPresetMode === 'string' ? frequencyPresetMode : undefined,
      );
      setSettingsInitialRemoteAccessPreset(customEvent.detail?.remoteAccessPreset);
      setIsSettingsOpen(true);
    };

    const handleOpenAccountSecurityModal = () => {
      setIsAccountSecurityOpen(true);
    };

    window.addEventListener('openProfileModal', handleOpenProfileModal);
    window.addEventListener('openSettingsModal', handleOpenSettingsModal);
    window.addEventListener(OPEN_ACCOUNT_SECURITY_MODAL_EVENT, handleOpenAccountSecurityModal);

    return () => {
      window.removeEventListener('openProfileModal', handleOpenProfileModal);
      window.removeEventListener('openSettingsModal', handleOpenSettingsModal);
      window.removeEventListener(OPEN_ACCOUNT_SECURITY_MODAL_EVENT, handleOpenAccountSecurityModal);
    };
  }, [isAdmin]);

  const pending = <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" role="status">
    <Spinner aria-label={t('status.loading')} />
  </div>;

  return (
    <>
      <Suspense fallback={pending}>{isSettingsOpen && (
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          initialTab={settingsInitialTab}
          initialFrequencyPresetMode={settingsInitialFrequencyPresetMode}
          initialRemoteAccessPreset={settingsInitialRemoteAccessPreset}
        />
      )}</Suspense>

      <Suspense fallback={pending}>{isAdmin && isProfileModalOpen && (
        <ProfileModal
          isOpen={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
        />
      )}</Suspense>

      <AccountSecurityModal
        isOpen={isAccountSecurityOpen}
        onClose={() => setIsAccountSecurityOpen(false)}
      />
    </>
  );
}

export const GlobalModalHost = memo(GlobalModalHostInner);
