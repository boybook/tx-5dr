import React, { memo, useEffect, useState } from 'react';
import { useHasMinRole } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { SettingsModal, type SettingsTab } from './SettingsModal';
import { ProfileModal } from './ProfileModal';

function GlobalModalHostInner() {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('radio');
  const [settingsInitialFrequencyPresetMode, setSettingsInitialFrequencyPresetMode] = useState<string | undefined>(undefined);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);

  useEffect(() => {
    const handleOpenProfileModal = () => {
      if (isAdmin) {
        setIsProfileModalOpen(true);
      }
    };

    const handleOpenSettingsModal = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: SettingsTab; frequencyPresetMode?: string }>;
      const tab = customEvent.detail?.tab;
      const frequencyPresetMode = customEvent.detail?.frequencyPresetMode;

      if (tab) {
        setSettingsInitialTab(tab);
      }

      setSettingsInitialFrequencyPresetMode(
        typeof frequencyPresetMode === 'string' ? frequencyPresetMode : undefined,
      );
      setIsSettingsOpen(true);
    };

    window.addEventListener('openProfileModal', handleOpenProfileModal);
    window.addEventListener('openSettingsModal', handleOpenSettingsModal);

    return () => {
      window.removeEventListener('openProfileModal', handleOpenProfileModal);
      window.removeEventListener('openSettingsModal', handleOpenSettingsModal);
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
        />
      )}

      {isAdmin && isProfileModalOpen && (
        <ProfileModal
          isOpen={isProfileModalOpen}
          onClose={() => setIsProfileModalOpen(false)}
        />
      )}
    </>
  );
}

export const GlobalModalHost = memo(GlobalModalHostInner);
