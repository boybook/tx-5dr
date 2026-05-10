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
import { CWQSOLogCard } from '../components/cw/CWQSOLogCard';
import { CWRecentQSOList } from '../components/cw/CWRecentQSOList';
import { CWRightTopTabs } from '../components/cw/CWRightTopTabs';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { QSONotificationToggleButton } from '../components/common/QSONotificationToggleButton';
import { ServerHealthButton } from '../components/system/ServerHealthButton';
import { SettingsButton } from '../components/common/SettingsButton';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKey, faLock, faRightFromBracket, faUser } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { OPEN_ACCOUNT_SECURITY_MODAL_EVENT } from '../components/app/GlobalModalHost';
import { useCurrentOperatorId, useOperators } from '../store/radioStore';

/**
 * CWRightLayout
 *
 * Right panel layout for CW mode:
 * - Top toolbar (auth, theme, settings) — inside tabs
 * - CWRightTopTabs containing CWRecentQSOList + CWQSOLogCard
 * - RadioControl fixed at the bottom
 */
export const CWRightLayout: React.FC = () => {
  const { t } = useTranslation('common');
  const ROLE_LABELS: Record<string, string> = {
    viewer: t('common:role.viewer'),
    operator: t('common:role.operator'),
    admin: t('common:role.admin'),
  };
  const { state: authState, logout } = useAuth();
  const [loginPopoverOpen, setLoginPopoverOpen] = useState(false);
  const showAuthenticatedIdentity = Boolean(authState.role) && (Boolean(authState.jwt) || !authState.authEnabled);
  const showLoginEntry = authState.authEnabled && !authState.jwt && authState.isPublicViewer;

  // QSO log state management
  const [selectedQSO, setSelectedQSO] = useState<QSORecord | null>(null);
  const [lastUpdatedQSO, setLastUpdatedQSO] = useState<QSORecord | null>(null);
  const [lastDeletedId, setLastDeletedId] = useState<string | null>(null);

  const { currentOperatorId } = useCurrentOperatorId();
  const { operators } = useOperators();
  const activeOperatorId = currentOperatorId || operators[0]?.id || null;

  const handleOpenRadioSettings = () => {
    window.dispatchEvent(new Event('openProfileModal'));
  };

  const handleOpenAccountSecurity = useCallback(() => {
    window.dispatchEvent(new Event(OPEN_ACCOUNT_SECURITY_MODAL_EVENT));
  }, []);

  const handleEditComplete = useCallback((updated: QSORecord) => {
    setLastUpdatedQSO(updated);
    setSelectedQSO(null);
  }, []);

  const handleDeleteComplete = useCallback((deletedId: string) => {
    setLastDeletedId(deletedId);
    setSelectedQSO(null);
  }, []);

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col">
      {/* Top area: QSO log + recent list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CWRightTopTabs
          operatorId={activeOperatorId}
          toolbarRight={(
            <>
              <div className="flex items-center gap-1">
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
                <QSONotificationToggleButton />
                <ThemeToggle variant="dropdown" size="sm" />
                <SettingsButton />
              </div>
            </>
          )}
          nativeContent={(
            <>
              <div className="flex-1 min-h-0">
                <CWRecentQSOList
                  selectedQSOId={selectedQSO?.id ?? null}
                  onSelectQSO={setSelectedQSO}
                  onDeselectQSO={() => setSelectedQSO(null)}
                  lastUpdatedQSO={lastUpdatedQSO}
                  lastDeletedId={lastDeletedId}
                />
              </div>
              <div className="flex-shrink-0">
                <CWQSOLogCard
                  editingQSO={selectedQSO}
                  onEditComplete={handleEditComplete}
                  onDeleteComplete={handleDeleteComplete}
                  onCancelEdit={() => setSelectedQSO(null)}
                />
              </div>
            </>
          )}
        />
      </div>

      {/* Bottom area: Radio Control (fixed) */}
      <div className="flex-shrink-0 p-2 pt-0 md:px-5 md:pb-5">
        <RadioControl onOpenRadioSettings={handleOpenRadioSettings} />
      </div>
    </div>
  );
};
