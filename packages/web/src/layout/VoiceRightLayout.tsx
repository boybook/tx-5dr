import React, { useState, useCallback } from 'react';
import type { QSORecord } from '@tx5dr/contracts';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@heroui/react';
import { useAuth } from '../store/authStore';
import { AuthLoginForm } from '../components/auth/AuthLoginForm';
import { RadioControl } from '../components/radio/control/RadioControl';
import { VoiceQSOLogCard } from '../components/voice/VoiceQSOLogCard';
import { VoiceRecentQSOList } from '../components/voice/VoiceRecentQSOList';
import { VoicePTTButton } from '../components/voice/VoicePTTButton';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { ServerHealthButton } from '../components/system/ServerHealthButton';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCog, faKey, faLock, faRightFromBracket, faUser } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { OPEN_ACCOUNT_SECURITY_MODAL_EVENT } from '../components/app/GlobalModalHost';
import { useConnection, useRadioModeState } from '../store/radioStore';
import { useVoiceCaptureController } from '../hooks/useVoiceCaptureController';

/**
 * VoiceRightLayout
 *
 * Right panel layout for voice mode:
 * - Top toolbar (auth, theme, settings)
 * - Recent QSOs (flat table, fills top area)
 * - PTT button (red card, left) + QSO Log card (right) side-by-side
 * - RadioControl (at bottom)
 */
export const VoiceRightLayout: React.FC = () => {
  const { t } = useTranslation('common');
  const connection = useConnection();
  const radioMode = useRadioModeState();
  const ROLE_LABELS: Record<string, string> = {
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  };
  const { state: authState, logout } = useAuth();
  const [loginPopoverOpen, setLoginPopoverOpen] = useState(false);
  const [selectedQSO, setSelectedQSO] = useState<QSORecord | null>(null);
  const [lastUpdatedQSO, setLastUpdatedQSO] = useState<QSORecord | null>(null);
  const [lastDeletedId, setLastDeletedId] = useState<string | null>(null);
  const showAuthenticatedIdentity = Boolean(authState.role) && (Boolean(authState.jwt) || !authState.authEnabled);
  const showLoginEntry = authState.authEnabled && !authState.jwt && authState.isPublicViewer;

  const handleEditComplete = useCallback((updated: QSORecord) => {
    setLastUpdatedQSO(updated);
    setSelectedQSO(null);
  }, []);

  const handleDeleteComplete = useCallback((deletedId: string) => {
    setLastDeletedId(deletedId);
    setSelectedQSO(null);
  }, []);

  const handleOpenSettings = () => {
    window.dispatchEvent(new CustomEvent('openSettingsModal', { detail: { tab: 'radio' } }));
  };

  const handleOpenRadioSettings = () => {
    window.dispatchEvent(new Event('openProfileModal'));
  };

  const handleOpenAccountSecurity = useCallback(() => {
    window.dispatchEvent(new Event(OPEN_ACCOUNT_SECURITY_MODAL_EVENT));
  }, []);

  const voiceCaptureController = useVoiceCaptureController(
    connection.state.radioService,
    radioMode.engineMode,
  );

  return (
    <div className="h-full flex flex-col">
      {/* Top toolbar */}
      <div
        className="flex-shrink-0 flex justify-between items-center p-1 px-2 md:p-2 md:px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        <div></div>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          <div className="flex items-center gap-1">
            {/* Auth UI */}
            {showAuthenticatedIdentity ? (
                <Popover placement="bottom-end">
                  <PopoverTrigger>
                    <Button
                      variant="light"
                      size="sm"
                      className="bg-content2 rounded-md px-3 h-6 text-xs text-default-500 leading-none"
                    >
                      <FontAwesomeIcon icon={faUser} className="text-default-400 text-xs" />
                      {authState.role === 'admin' ? t('role.admin') : (authState.label || ROLE_LABELS[authState.role || ''] || t('auth.user'))}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-3 gap-2">
                    <div className="text-sm font-medium">
                      {authState.label || ROLE_LABELS[authState.role || ''] || t('auth.user')}
                    </div>
                    <div className="text-xs text-default-500">{t('auth.role')}: {ROLE_LABELS[authState.role || ''] || authState.role}</div>
                    {authState.authEnabled && authState.jwt && (
                      <>
                        <Button
                          size="sm"
                          variant="flat"
                          startContent={<FontAwesomeIcon icon={faLock} />}
                          onPress={handleOpenAccountSecurity}
                        >
                          {t('auth:accountSecurity.trigger')}
                        </Button>
                        <Button
                          size="sm"
                          variant="flat"
                          color="danger"
                          startContent={<FontAwesomeIcon icon={faRightFromBracket} />}
                          onPress={logout}
                          className="mt-1"
                        >
                          {t('auth.logout')}
                        </Button>
                      </>
                    )}
                  </PopoverContent>
                </Popover>
              ) : showLoginEntry ? (
                <Popover
                  placement="bottom-end"
                  isOpen={loginPopoverOpen}
                  onOpenChange={setLoginPopoverOpen}
                  >
                    <PopoverTrigger>
                      <Button variant="light" size="sm" className="bg-content2 rounded-md px-3 h-6 text-xs text-default-500 leading-none">
                      <FontAwesomeIcon icon={faKey} className="text-default-400 text-xs" />
                      {t('auth.login')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="p-3 w-80">
                    <AuthLoginForm
                      compact
                      autoFocus
                      onSuccess={() => setLoginPopoverOpen(false)}
                    />
                  </PopoverContent>
                </Popover>
              ) : null}
          </div>
          <div className="flex items-center gap-0">
            <ServerHealthButton />
            <ThemeToggle variant="dropdown" size="sm" />
            <Button
              onPress={handleOpenSettings}
              isIconOnly
              variant="light"
              size="sm"
              title={t('action.openSettings')}
              aria-label={t('action.openSettings')}
            >
              <FontAwesomeIcon icon={faCog} className="text-default-400 text-sm" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 p-2 pt-0 md:p-5 md:pt-0 flex flex-col gap-2 md:gap-3 min-h-0">
        {/* Recent QSOs - flat table, fills top area */}
        <div className="flex-1 min-h-0">
          <VoiceRecentQSOList
            selectedQSOId={selectedQSO?.id ?? null}
            onSelectQSO={setSelectedQSO}
            onDeselectQSO={() => setSelectedQSO(null)}
            lastUpdatedQSO={lastUpdatedQSO}
            lastDeletedId={lastDeletedId}
          />
        </div>

        {/* QSO Log Card - full width */}
        <div className="flex-shrink-0">
          <VoiceQSOLogCard
            editingQSO={selectedQSO}
            onEditComplete={handleEditComplete}
            onDeleteComplete={handleDeleteComplete}
            onCancelEdit={() => setSelectedQSO(null)}
          />
        </div>

        {/* PTT Button + Radio Control */}
        {/* Mobile: stacked vertically. Desktop: side-by-side */}
        <div className="flex-shrink-0 flex flex-col md:flex-row gap-2 md:gap-3 md:items-stretch">
          <div className="flex-shrink-0 md:order-none md:self-stretch md:flex">
            <VoicePTTButton voiceCaptureController={voiceCaptureController} />
          </div>
          <div className="flex-1 min-w-0">
            <RadioControl
              onOpenRadioSettings={handleOpenRadioSettings}
              voiceCaptureController={voiceCaptureController}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
