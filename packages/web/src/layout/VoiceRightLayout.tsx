import React, { useState, useCallback, useEffect, useRef } from 'react';
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
import { VoiceKeyerCard } from '../components/voice/VoiceKeyerCard';
import { VoiceRightTopTabs } from '../components/voice/VoiceRightTopTabs';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { QSONotificationToggleButton } from '../components/common/QSONotificationToggleButton';
import { ServerHealthButton } from '../components/system/ServerHealthButton';
import { SettingsButton } from '../components/common/SettingsButton';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKey, faLock, faRightFromBracket, faUser } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { OPEN_ACCOUNT_SECURITY_MODAL_EVENT } from '../components/app/GlobalModalHost';
import { useConnection, useCurrentOperatorId, useOperators, useRadioModeState } from '../store/radioStore';
import { useVoiceCaptureController } from '../hooks/useVoiceCaptureController';
import {
  createInitialVoiceRightCollapseState,
  enforceVoiceRightHeightLimit,
  isVoiceRightMutualExclusionActive,
  updateVoiceRightCardCollapse,
} from './voiceRightResponsive';

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
  const { currentOperatorId } = useCurrentOperatorId();
  const { operators } = useOperators();
  const activeOperatorId = currentOperatorId || operators[0]?.id || null;
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
  const [heightLimited, setHeightLimited] = useState(false);
  const [lastLimitedHeight, setLastLimitedHeight] = useState<number | null>(null);
  const [collapseState, setCollapseState] = useState(createInitialVoiceRightCollapseState);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const topWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const bottomControlsRef = useRef<HTMLDivElement | null>(null);
  const showAuthenticatedIdentity = Boolean(authState.role) && (Boolean(authState.jwt) || !authState.authEnabled);
  const showLoginEntry = authState.authEnabled && !authState.jwt && authState.isPublicViewer;

  const measureHeightLimit = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    const rootOverflow = root.scrollHeight > root.clientHeight + 2;
    const top = topWorkspaceRef.current;
    const bottom = bottomControlsRef.current;
    const topOverflow = top ? top.scrollHeight > top.clientHeight + 2 : false;
    const bottomOverflow = bottom ? bottom.scrollHeight > bottom.clientHeight + 2 : false;
    const nextHeightLimited = rootOverflow || topOverflow || bottomOverflow;

    setHeightLimited(nextHeightLimited);
    setLastLimitedHeight(current => {
      if (nextHeightLimited) {
        return Math.max(current ?? 0, root.clientHeight);
      }
      if (current !== null && root.clientHeight > current) {
        return null;
      }
      return current;
    });
  }, []);

  useEffect(() => {
    let frameId: number | null = null;
    const scheduleMeasure = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        measureHeightLimit();
      });
    };

    scheduleMeasure();

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    if (observer) {
      if (rootRef.current) observer.observe(rootRef.current);
      if (topWorkspaceRef.current) observer.observe(topWorkspaceRef.current);
      if (bottomControlsRef.current) observer.observe(bottomControlsRef.current);
    }
    window.addEventListener('resize', scheduleMeasure);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [measureHeightLimit]);

  useEffect(() => {
    measureHeightLimit();
  }, [collapseState.qsoCollapsed, collapseState.keyerCollapsed, selectedQSO, measureHeightLimit]);

  useEffect(() => {
    if (!heightLimited) return;
    setCollapseState(current => enforceVoiceRightHeightLimit(current));
  }, [heightLimited]);

  const handleQsoCollapsedChange = useCallback((collapsed: boolean) => {
    const mutualExclusionActive = isVoiceRightMutualExclusionActive(
      heightLimited,
      lastLimitedHeight,
      rootRef.current?.clientHeight ?? null,
    );
    setCollapseState(current => updateVoiceRightCardCollapse(current, 'qso', collapsed, mutualExclusionActive));
  }, [heightLimited, lastLimitedHeight]);

  const handleKeyerCollapsedChange = useCallback((collapsed: boolean) => {
    const mutualExclusionActive = isVoiceRightMutualExclusionActive(
      heightLimited,
      lastLimitedHeight,
      rootRef.current?.clientHeight ?? null,
    );
    setCollapseState(current => updateVoiceRightCardCollapse(current, 'keyer', collapsed, mutualExclusionActive));
  }, [heightLimited, lastLimitedHeight]);

  const handleEditComplete = useCallback((updated: QSORecord) => {
    setLastUpdatedQSO(updated);
    setSelectedQSO(null);
  }, []);

  const handleDeleteComplete = useCallback((deletedId: string) => {
    setLastDeletedId(deletedId);
    setSelectedQSO(null);
  }, []);


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
    <div ref={rootRef} className="h-full min-h-0 overflow-hidden flex flex-col">
      <div ref={topWorkspaceRef} className="flex-1 min-h-0 overflow-hidden">
        <VoiceRightTopTabs
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
                <VoiceRecentQSOList
                  selectedQSOId={selectedQSO?.id ?? null}
                  onSelectQSO={setSelectedQSO}
                  onDeselectQSO={() => setSelectedQSO(null)}
                  lastUpdatedQSO={lastUpdatedQSO}
                  lastDeletedId={lastDeletedId}
                />
              </div>
              <div className="flex-shrink-0">
                <VoiceQSOLogCard
                  editingQSO={selectedQSO}
                  collapsed={collapseState.qsoCollapsed}
                  onCollapsedChange={handleQsoCollapsedChange}
                  onEditComplete={handleEditComplete}
                  onDeleteComplete={handleDeleteComplete}
                  onCancelEdit={() => setSelectedQSO(null)}
                />
              </div>
            </>
          )}
        />
      </div>

      <div ref={bottomControlsRef} className="flex-shrink-0 min-h-0 overflow-hidden p-2 pt-0 md:px-5 md:pb-5 md:pt-0">
        <div className="mb-3 md:mb-4">
          <VoiceKeyerCard
            collapsed={collapseState.keyerCollapsed}
            onCollapsedChange={handleKeyerCollapsedChange}
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
