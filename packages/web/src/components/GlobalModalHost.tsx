import React, { memo, useEffect, useState } from 'react';
import { useHasMinRole } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { SettingsModal, type SettingsTab } from './SettingsModal';
import { ProfileModal } from './ProfileModal';
import { RealtimeCompatFallbackModal } from './RealtimeCompatFallbackModal';
import type { RealtimeCompatFallbackModalDetail } from '../realtime/realtimeConnectivity';
import { OPEN_REALTIME_COMPAT_FALLBACK_MODAL_EVENT } from '../realtime/realtimeConnectivity';

function GlobalModalHostInner() {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('radio');
  const [settingsInitialFrequencyPresetMode, setSettingsInitialFrequencyPresetMode] = useState<string | undefined>(undefined);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [realtimeFallbackDetail, setRealtimeFallbackDetail] = useState<RealtimeCompatFallbackModalDetail | null>(null);

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

    const handleOpenRealtimeFallbackModal = (event: Event) => {
      const customEvent = event as CustomEvent<RealtimeCompatFallbackModalDetail>;
      setRealtimeFallbackDetail(customEvent.detail ?? null);
    };

    window.addEventListener('openProfileModal', handleOpenProfileModal);
    window.addEventListener('openSettingsModal', handleOpenSettingsModal);
    window.addEventListener(OPEN_REALTIME_COMPAT_FALLBACK_MODAL_EVENT, handleOpenRealtimeFallbackModal);

    return () => {
      window.removeEventListener('openProfileModal', handleOpenProfileModal);
      window.removeEventListener('openSettingsModal', handleOpenSettingsModal);
      window.removeEventListener(OPEN_REALTIME_COMPAT_FALLBACK_MODAL_EVENT, handleOpenRealtimeFallbackModal);
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

      <RealtimeCompatFallbackModal
        isOpen={Boolean(realtimeFallbackDetail)}
        issue={realtimeFallbackDetail?.issue ?? null}
        onConfirm={realtimeFallbackDetail?.onConfirm ?? null}
        onClose={() => setRealtimeFallbackDetail(null)}
      />
    </>
  );
}

export const GlobalModalHost = memo(GlobalModalHostInner);
