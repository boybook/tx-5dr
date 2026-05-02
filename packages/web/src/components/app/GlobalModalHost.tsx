import React, { memo, useEffect, useState } from 'react';
import { useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { SettingsModal, type SettingsTab, type SettingsSection } from '../settings/SettingsModal';
import { ProfileModal } from '../radio/profile/ProfileModal';
import { AccountSecurityModal } from '../auth/AccountSecurityModal';

export const OPEN_ACCOUNT_SECURITY_MODAL_EVENT = 'openAccountSecurityModal';

function GlobalModalHostInner() {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('radio');
  const [settingsInitialFrequencyPresetMode, setSettingsInitialFrequencyPresetMode] = useState<string | undefined>(undefined);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection | undefined>(undefined);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isAccountSecurityOpen, setIsAccountSecurityOpen] = useState(false);

  useEffect(() => {
    const handleOpenProfileModal = () => {
      if (isAdmin) {
        setIsProfileModalOpen(true);
      }
    };

    const handleOpenSettingsModal = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: SettingsTab; frequencyPresetMode?: string; section?: SettingsSection }>;
      const tab = customEvent.detail?.tab;
      const frequencyPresetMode = customEvent.detail?.frequencyPresetMode;
      const section = customEvent.detail?.section;

      if (tab) {
        setSettingsInitialTab(tab);
      }

      setSettingsInitialFrequencyPresetMode(
        typeof frequencyPresetMode === 'string' ? frequencyPresetMode : undefined,
      );
      setSettingsInitialSection(section);
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

  return (
    <>
      {isSettingsOpen && (
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          initialTab={settingsInitialTab}
          initialFrequencyPresetMode={settingsInitialFrequencyPresetMode}
          initialSection={settingsInitialSection}
        />
      )}

      {isAdmin && isProfileModalOpen && (
        <ProfileModal
          isOpen={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
        />
      )}

      <AccountSecurityModal
        isOpen={isAccountSecurityOpen}
        onClose={() => setIsAccountSecurityOpen(false)}
      />
    </>
  );
}

export const GlobalModalHost = memo(GlobalModalHostInner);
