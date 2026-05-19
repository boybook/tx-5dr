import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConnection, useCurrentOperatorId, usePTTState } from '../../store/radioStore';
import { useAuth, useHasMinRole } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from '@heroui/react';
import { createLogger } from '../../utils/logger';
import {
  PLUGIN_IFRAME_KEYBOARD_EVENT,
  type PluginIframeKeyboardEvent,
} from '../../utils/pluginIframeKeyboardEvents';
import type { VoiceCaptureController } from '../../hooks/useVoiceCaptureController';
import {
  type VoicePttShortcutPreset,
  VOICE_PTT_SHORTCUT_PRESETS,
  VOICE_PTT_SHORTCUT_CHANGED_EVENT,
  getVoicePttShortcutPreset,
  matchesVoicePttShortcut,
  normalizeVoicePttShortcutPreset,
  saveVoicePttShortcutPreset,
} from '../../utils/voicePttShortcutPreferences';
import { VoicePttPressTracker } from './voicePttPressTracker';

const logger = createLogger('VoicePTTButton');

type PTTState = 'idle' | 'requesting' | 'transmitting' | 'locked-by-other';

function ShortcutChevronIcon({ open, className = 'text-white' }: { open: boolean; className?: string }): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`h-3 w-3 transition-transform ${className} ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * Voice PTT Button Component
 *
 * Rectangular red card-style PTT button for voice mode.
 * Supports mouse, touch, and a configurable keyboard shortcut.
 * Manages WakeLock and vibration feedback for mobile.
 */
interface VoicePTTButtonProps {
  voiceCaptureController: VoiceCaptureController;
}

const HTTP_PTT_HTTPS_WARNING_BYPASS_KEY = 'tx5dr.voice.ptt.httpHttpsWarningBypass';
const SHORTCUT_STALE_KEYDOWN_RECOVERY_MS = 80;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function requiresHttpsForVoiceTransmit(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.protocol === 'http:' && !isLoopbackHostname(window.location.hostname);
}

function loadHttpsWarningBypass(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(HTTP_PTT_HTTPS_WARNING_BYPASS_KEY) === '1';
  } catch {
    return false;
  }
}

function persistHttpsWarningBypass(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (enabled) {
      window.localStorage.setItem(HTTP_PTT_HTTPS_WARNING_BYPASS_KEY, '1');
    } else {
      window.localStorage.removeItem(HTTP_PTT_HTTPS_WARNING_BYPASS_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

function isVoiceKeyerLockHolder(lockHolder: string | null | undefined): boolean {
  return typeof lockHolder === 'string' && lockHolder.startsWith('voice-keyer:');
}

export const VoicePTTButton: React.FC<VoicePTTButtonProps> = ({ voiceCaptureController }) => {
  const { t } = useTranslation(['voice', 'common']);
  const { state: authState } = useAuth();
  const connection = useConnection();
  const { currentOperatorId } = useCurrentOperatorId();
  const { voicePttLock } = usePTTState();
  const isOperator = useHasMinRole(UserRole.OPERATOR);
  const isAdmin = useHasMinRole(UserRole.ADMIN);

  const [pttState, setPttState] = useState<PTTState>('idle');
  const [inputLevel, setInputLevel] = useState(0);
  const [httpsRequiredModalOpen, setHttpsRequiredModalOpen] = useState(false);
  const [httpsWarningBypassEnabled, setHttpsWarningBypassEnabled] = useState(loadHttpsWarningBypass);
  const [shortcutPreset, setShortcutPreset] = useState<VoicePttShortcutPreset>(getVoicePttShortcutPreset);
  const [shortcutMenuOpen, setShortcutMenuOpen] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const manualPttActiveRef = useRef(false);
  const manualPttOwnsLockRef = useRef(false);
  const manualPttReleasePendingRef = useRef(false);
  const previousVoicePttLockedRef = useRef(false);
  const keyboardPressActiveRef = useRef(false);
  const keyboardPressActiveAtRef = useRef<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const shortcutMenuRef = useRef<HTMLDivElement>(null);
  const voiceCaptureControllerRef = useRef(voiceCaptureController);
  const shortcutHandlersRef = useRef({
    down: (_repeat: boolean) => {},
    up: () => {},
  });
  const pressTrackerRef = useRef(new VoicePttPressTracker());

  const radioService = connection.state.radioService;
  const isVoiceKeyerPttLock = voicePttLock?.locked && isVoiceKeyerLockHolder(voicePttLock.lockedBy);

  useEffect(() => {
    voiceCaptureControllerRef.current = voiceCaptureController;
  }, [voiceCaptureController]);

  useEffect(() => {
    const handleShortcutChange = (event: Event) => {
      const nextPreset = normalizeVoicePttShortcutPreset(
        (event as CustomEvent<VoicePttShortcutPreset>).detail
      );
      setShortcutPreset(nextPreset);
      setShortcutMenuOpen(false);
    };

    window.addEventListener(VOICE_PTT_SHORTCUT_CHANGED_EVENT, handleShortcutChange);
    return () => {
      window.removeEventListener(VOICE_PTT_SHORTCUT_CHANGED_EVENT, handleShortcutChange);
    };
  }, []);

  const shouldBlockForHttpsWarning = useCallback(() => {
    if (httpsWarningBypassEnabled) {
      return false;
    }

    if (!requiresHttpsForVoiceTransmit()) {
      return false;
    }

    setHttpsRequiredModalOpen(true);
    return true;
  }, [httpsWarningBypassEnabled]);

  useEffect(() => {
    logger.debug('Voice capture state changed', {
      captureState: voiceCaptureController.captureState,
      activeTransport: voiceCaptureController.activeTransport,
      preferredTransport: voiceCaptureController.preferredTransport,
    });
  }, [
    voiceCaptureController.activeTransport,
    voiceCaptureController.captureState,
    voiceCaptureController.preferredTransport,
  ]);

  useEffect(() => {
    let animationFrame = 0;
    let lastSampleAt = 0;

    const updateLevel = (timestamp: number) => {
      if (timestamp - lastSampleAt >= 50) {
        lastSampleAt = timestamp;
        const nextLevel = voiceCaptureController.getInputLevel();
        setInputLevel((currentLevel) => (
          Math.abs(currentLevel - nextLevel) < 0.01 ? currentLevel : nextLevel
        ));
      }
      animationFrame = window.requestAnimationFrame(updateLevel);
    };

    animationFrame = window.requestAnimationFrame(updateLevel);

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [voiceCaptureController]);

  // Request WakeLock during TX
  const acquireWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
        logger.debug('WakeLock acquired');
      }
    } catch (error) {
      logger.warn('WakeLock request failed:', error);
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
      logger.debug('WakeLock released');
    }
  }, []);

  const getExternalPttState = useCallback((): PTTState => {
    if (!voicePttLock?.locked || manualPttReleasePendingRef.current) {
      return 'idle';
    }

    return (manualPttActiveRef.current || manualPttOwnsLockRef.current || isVoiceKeyerLockHolder(voicePttLock.lockedBy))
      ? 'transmitting'
      : 'locked-by-other';
  }, [voicePttLock]);

  // Derive the visible state from the server lock while keeping manual PTT local.
  useEffect(() => {
    const isLocked = voicePttLock?.locked === true;
    const wasLocked = previousVoicePttLockedRef.current;
    previousVoicePttLockedRef.current = isLocked;

    if (!isLocked) {
      manualPttOwnsLockRef.current = false;
      manualPttReleasePendingRef.current = false;
      if (wasLocked && manualPttActiveRef.current) {
        manualPttActiveRef.current = false;
        pressTrackerRef.current.reset();
        voiceCaptureController.setPTTActive(false);
        releaseWakeLock();
      }
      if (!manualPttActiveRef.current) {
        setPttState('idle');
      }
      return;
    }

    if (manualPttReleasePendingRef.current) {
      setPttState('idle');
      return;
    }

    if (manualPttActiveRef.current || manualPttOwnsLockRef.current || isVoiceKeyerLockHolder(voicePttLock.lockedBy)) {
      if (manualPttActiveRef.current) {
        manualPttOwnsLockRef.current = true;
      }
      setPttState('transmitting');
    } else {
      setPttState('locked-by-other');
    }
  }, [releaseWakeLock, voiceCaptureController, voicePttLock]);

  const startManualPtt = useCallback(async () => {
    if (!isOperator || !radioService || !currentOperatorId || manualPttActiveRef.current) return;
    if (pttState === 'locked-by-other') return;

    const pressId = pressTrackerRef.current.beginPress();
    manualPttReleasePendingRef.current = false;
    manualPttActiveRef.current = true;
    setPttState('requesting');

    try {
      const participantIdentity = await voiceCaptureController.startFromGesture();
      if (!pressTrackerRef.current.isActive(pressId) || !manualPttActiveRef.current) {
        pressTrackerRef.current.cancelPress(pressId);
        voiceCaptureController.setPTTActive(false);
        setPttState(getExternalPttState());
        logger.debug('PTT toggle canceled before voice capture became ready', { pressId });
        return;
      }

      if (!participantIdentity) {
        pressTrackerRef.current.cancelPress(pressId);
        manualPttActiveRef.current = false;
        setPttState(getExternalPttState());
        logger.warn('PTT requested before voice participant identity became available');
        return;
      }

      if (!pressTrackerRef.current.markRequestIssued(pressId)) {
        voiceCaptureController.setPTTActive(false);
        setPttState(getExternalPttState());
        logger.debug('PTT toggle became stale before request was issued', { pressId });
        return;
      }

      manualPttOwnsLockRef.current = true;
      radioService.requestVoicePTT(participantIdentity, currentOperatorId);
      voiceCaptureController.setPTTActive(true);
    } catch (error) {
      pressTrackerRef.current.cancelPress(pressId);
      if (manualPttActiveRef.current) {
        manualPttActiveRef.current = false;
      }
      setPttState(getExternalPttState());
      logger.error('PTT initialization failed', error);
      return;
    }

    void acquireWakeLock();
    if (navigator.vibrate) {
      navigator.vibrate(50);
    }

    logger.debug('PTT toggled on');
  }, [acquireWakeLock, currentOperatorId, getExternalPttState, isOperator, pttState, radioService, voiceCaptureController]);

  const stopManualPtt = useCallback(() => {
    const { pressId, shouldRelease } = pressTrackerRef.current.releaseActivePress();
    if (pressId === null && !manualPttActiveRef.current) return;

    manualPttActiveRef.current = false;

    if (shouldRelease) {
      manualPttReleasePendingRef.current = true;
      radioService?.releaseVoicePTT();
    } else {
      manualPttOwnsLockRef.current = false;
      manualPttReleasePendingRef.current = false;
    }
    voiceCaptureController.setPTTActive(false);

    releaseWakeLock();
    setPttState(shouldRelease ? 'idle' : getExternalPttState());

    if (navigator.vibrate) {
      navigator.vibrate(30);
    }

    logger.debug('PTT toggled off');
  }, [getExternalPttState, radioService, releaseWakeLock, voiceCaptureController]);

  const toggleManualPtt = useCallback(async () => {
    if (manualPttActiveRef.current) {
      stopManualPtt();
      return;
    }

    if (!isOperator || !radioService || !currentOperatorId || pttState === 'locked-by-other') return;
    if (shouldBlockForHttpsWarning()) return;

    await startManualPtt();
  }, [
    isOperator,
    currentOperatorId,
    pttState,
    radioService,
    shouldBlockForHttpsWarning,
    startManualPtt,
    stopManualPtt,
  ]);

  const suppressShortcutEvent = useCallback((event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleShortcutDown = useCallback((repeat: boolean) => {
    if (repeat) return;

    const now = Date.now();
    if (keyboardPressActiveRef.current) {
      const elapsedMs = keyboardPressActiveAtRef.current === null
        ? Number.POSITIVE_INFINITY
        : now - keyboardPressActiveAtRef.current;
      if (elapsedMs < SHORTCUT_STALE_KEYDOWN_RECOVERY_MS) return;
      logger.debug('Voice PTT shortcut keyUp was not observed in renderer; recovering debounce', { elapsedMs });
    }

    keyboardPressActiveRef.current = true;
    keyboardPressActiveAtRef.current = now;
    void toggleManualPtt();
  }, [toggleManualPtt]);

  const handleShortcutUp = useCallback(() => {
    keyboardPressActiveRef.current = false;
    keyboardPressActiveAtRef.current = null;
  }, []);

  useEffect(() => {
    shortcutHandlersRef.current = {
      down: handleShortcutDown,
      up: handleShortcutUp,
    };
  }, [handleShortcutDown, handleShortcutUp]);

  // Keyboard handler (configurable global shortcut)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesVoicePttShortcut(e.code, shortcutPreset)) return;
      suppressShortcutEvent(e);
      shortcutHandlersRef.current.down(e.repeat);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!matchesVoicePttShortcut(e.code, shortcutPreset)) return;
      suppressShortcutEvent(e);
      shortcutHandlersRef.current.up();
    };

    const handlePluginIframeKeyboard = (event: Event) => {
      const { type, code, repeat } = (event as PluginIframeKeyboardEvent).detail;
      if (!matchesVoicePttShortcut(code, shortcutPreset)) return;
      suppressShortcutEvent(event);

      if (type === 'keyup') {
        shortcutHandlersRef.current.up();
        return;
      }

      shortcutHandlersRef.current.down(repeat);
    };

    const resetKeyboardPress = () => {
      keyboardPressActiveRef.current = false;
      keyboardPressActiveAtRef.current = null;
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        resetKeyboardPress();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener(PLUGIN_IFRAME_KEYBOARD_EVENT, handlePluginIframeKeyboard);
    window.addEventListener('blur', resetKeyboardPress);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('keyup', handleKeyUp, { capture: true });
      window.removeEventListener(PLUGIN_IFRAME_KEYBOARD_EVENT, handlePluginIframeKeyboard);
      window.removeEventListener('blur', resetKeyboardPress);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [shortcutPreset, suppressShortcutEvent]);

  useEffect(() => {
    const electronVoicePttShortcut = window.electronAPI?.voicePttShortcut;
    if (!electronVoicePttShortcut) {
      return undefined;
    }

    const handleCommand = (payload: {
      type: 'keydown' | 'keyup';
      code: string;
      repeat: boolean;
    }) => {
      if (!matchesVoicePttShortcut(payload.code, shortcutPreset)) return;

      if (payload.type === 'keyup') {
        shortcutHandlersRef.current.up();
        return;
      }

      shortcutHandlersRef.current.down(payload.repeat);
    };

    void electronVoicePttShortcut
      .setConfig({ enabled: true, preset: shortcutPreset })
      .catch((error: unknown) => logger.warn('Failed to enable Electron Voice PTT shortcut capture', error));
    electronVoicePttShortcut.onCommand(handleCommand);

    return () => {
      electronVoicePttShortcut.offCommand(handleCommand);
      void electronVoicePttShortcut
        .setConfig({ enabled: false, preset: shortcutPreset })
        .catch((error: unknown) => logger.warn('Failed to disable Electron Voice PTT shortcut capture', error));
    };
  }, [shortcutPreset]);

  // Suppress all long-press browser behaviors on the PTT button.
  // React synthetic events are insufficient on Android WebView/WebKit —
  // native listeners in the capture phase with { passive: false } are required.
  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;

    const prevent = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      return false;
    };

    // contextmenu: long-press menu on Android WebView/Chrome, right-click on desktop
    el.addEventListener('contextmenu', prevent, { capture: true, passive: false });
    // selectstart: text selection highlight triggered by long press
    el.addEventListener('selectstart', prevent, { capture: true, passive: false });
    // dragstart: some browsers start drag on long press
    el.addEventListener('dragstart', prevent, { capture: true, passive: false });

    return () => {
      el.removeEventListener('contextmenu', prevent, { capture: true });
      el.removeEventListener('selectstart', prevent, { capture: true });
      el.removeEventListener('dragstart', prevent, { capture: true });
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const { shouldRelease } = pressTrackerRef.current.releaseActivePress();
      if (shouldRelease) {
        radioService?.releaseVoicePTT();
      }
      keyboardPressActiveRef.current = false;
      keyboardPressActiveAtRef.current = null;
      manualPttActiveRef.current = false;
      manualPttOwnsLockRef.current = false;
      manualPttReleasePendingRef.current = false;
      pressTrackerRef.current.reset();
      voiceCaptureControllerRef.current.setPTTActive(false);
      releaseWakeLock();
    };
  }, [radioService, releaseWakeLock]);

  const getShortcutOptionLabel = useCallback((preset: VoicePttShortcutPreset): string => {
    switch (preset) {
      case 'Space':
        return t('ptt.shortcutNameSpace');
      case 'Backquote':
        return t('ptt.shortcutNameBackquote');
      case 'Home':
        return t('ptt.shortcutNameHome');
      default:
        return preset;
    }
  }, [t]);

  const shortcutLabel = getShortcutOptionLabel(shortcutPreset);

  // Button appearance based on state
  const getButtonStyle = (): { buttonClass: string; label: string; subLabel?: string } => {
    switch (pttState) {
      case 'requesting':
        return {
          buttonClass: 'border-2 border-warning-400 bg-warning-500 text-white shadow-lg shadow-warning-500/50',
          label: t('ptt.idle'),
          subLabel: t('ptt.requesting'),
        };
      case 'transmitting':
        return {
          buttonClass: 'border-2 border-danger-600 bg-danger-600 text-white shadow-lg shadow-danger-600/50 animate-pulse',
          label: t('ptt.idle'),
          subLabel: isVoiceKeyerPttLock ? undefined : t('ptt.stopHint', { shortcut: shortcutLabel }),
        };
      case 'locked-by-other':
        return {
          buttonClass: 'border-2 border-default-300 bg-default-300 text-white dark:border-default-500 dark:bg-default-500 cursor-not-allowed',
          label: t('ptt.lockedByOther'),
        };
      case 'idle':
      default:
        return {
          buttonClass: 'border-0 bg-danger-50/20 text-danger-600 ring-4 ring-inset ring-danger-500/70 shadow-sm shadow-danger-500/10 hover:bg-danger-50/80 hover:ring-danger-600/80 active:bg-danger-100/80 dark:bg-danger-950/10 dark:text-danger-300 dark:ring-danger-400/70 dark:hover:bg-danger-950/25 dark:hover:ring-danger-300/80',
          label: t('ptt.idle'),
          subLabel: t('ptt.shortcutHint', { shortcut: shortcutLabel }),
        };
    }
  };

  const { buttonClass, label, subLabel } = getButtonStyle();
  const shortcutToneClass = pttState === 'idle'
    ? 'text-danger-600/85 dark:text-danger-300/90'
    : 'text-white';
  const isDisabled = !isOperator || pttState === 'locked-by-other';
  const useDisabledVisual = !isOperator || pttState === 'locked-by-other';
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const meterPercent = Math.round(Math.max(0, Math.min(1, inputLevel)) * 100);
  const meterHasInput = voiceCaptureController.captureState !== 'idle';
  const meterIsPttActive = voiceCaptureController.isPTTActive || pttState === 'transmitting';
  const meterFillPercent = meterHasInput
    ? Math.max(0, Math.min(100, meterPercent))
    : 0;
  const peakMarkerPercent = meterHasInput
    ? Math.max(0, Math.min(100, meterFillPercent))
    : 0;
  const meterContainerClass = voiceCaptureController.captureState === 'error'
    ? 'bg-danger-50/45 dark:bg-danger-950/20'
    : meterIsPttActive
      ? 'bg-content2 dark:bg-content1'
      : 'bg-content2/85 dark:bg-content1/80 opacity-80';
  const meterFillClass = meterIsPttActive
    ? 'bg-gradient-to-t from-danger-500 via-warning-400 to-success-300'
    : 'bg-default-500/55 dark:bg-default-400/40';
  const peakMarkerClass = meterIsPttActive
    ? 'bg-white/90'
    : 'bg-default-600/40 dark:bg-default-200/30';
  const httpsRoleTitle = isAdmin
    ? t('ptt.httpsRequiredRoleTitleAdmin')
    : isOperator
      ? t('ptt.httpsRequiredRoleTitleOperator')
      : t('ptt.httpsRequiredRoleTitleViewer');
  const httpsRoleBody = isAdmin
    ? t('ptt.httpsRequiredRoleBodyAdmin')
    : isOperator
      ? t('ptt.httpsRequiredRoleBodyOperator')
      : t('ptt.httpsRequiredRoleBodyViewer');
  const currentRoleLabel = authState.isPublicViewer
    ? t('ptt.httpsRequiredRolePublicViewer')
    : authState.role
      ? t(`common:role.${authState.role}`)
      : t('ptt.httpsRequiredRoleUnauthenticated');

  const dismissHttpsWarning = useCallback((rememberChoice: boolean) => {
    if (rememberChoice) {
      persistHttpsWarningBypass(true);
      setHttpsWarningBypassEnabled(true);
    }
    setHttpsRequiredModalOpen(false);
  }, []);

  useEffect(() => {
    if (!shortcutMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (target && shortcutMenuRef.current?.contains(target)) {
        return;
      }

      setShortcutMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShortcutMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [shortcutMenuOpen]);

  return (
    <>
      <div className="flex h-14 w-full items-stretch gap-1.5 md:h-full md:w-[9rem] md:self-stretch">
        <div className="relative flex-1">
          <button
            ref={buttonRef}
            type="button"
            className={`
              h-full w-full rounded-large px-2 flex flex-col items-center justify-center
              transition-all duration-150 select-none touch-none
              font-bold whitespace-nowrap
              [-webkit-touch-callout:none] [-webkit-user-select:none]
              ${buttonClass}
              ${useDisabledVisual ? 'opacity-60 cursor-not-allowed' : isDisabled ? 'cursor-not-allowed' : 'cursor-pointer'}
            `}
            onClick={(e) => {
              e.preventDefault();
              void toggleManualPtt();
            }}
            disabled={isDisabled}
            aria-label={t('ptt.title')}
          >
            <span className="text-lg leading-tight md:text-xl">{label}</span>
            {subLabel && (
              <span className="mt-0.5 text-[11px] font-normal opacity-80 md:mt-1 md:text-xs">
                {pttState === 'idle' ? (
                  <>
                    <span className="md:hidden">{t('ptt.shortcutHintMobile')}</span>
                    <span className="hidden md:inline">{subLabel}</span>
                  </>
                ) : pttState === 'transmitting' && !isVoiceKeyerPttLock ? (
                  <>
                    <span className="md:hidden">{t('ptt.stopHintMobile')}</span>
                    <span className="hidden md:inline">{subLabel}</span>
                  </>
                ) : subLabel}
              </span>
            )}
          </button>
          <div
            ref={shortcutMenuRef}
            className="absolute right-1.5 top-1 z-10 hidden md:block"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label={t('ptt.shortcutSelectAria')}
              className={`flex h-5 items-center justify-end gap-0.5 bg-transparent px-0 py-0 text-[10px] font-medium uppercase tracking-wide outline-none transition-opacity hover:opacity-100 ${shortcutToneClass}`}
              onClick={() => {
                setShortcutMenuOpen((open) => !open);
              }}
            >
              <span className={`whitespace-nowrap ${shortcutToneClass}`}>
                {getShortcutOptionLabel(shortcutPreset)}
              </span>
              <ShortcutChevronIcon open={shortcutMenuOpen} className={shortcutToneClass} />
            </button>
            {shortcutMenuOpen && (
              <div className="absolute bottom-full right-0 mb-1.5 min-w-[4.5rem] rounded-md border border-white/15 bg-black/80 p-1 shadow-lg backdrop-blur-sm">
                {VOICE_PTT_SHORTCUT_PRESETS.map((preset) => {
                  const selected = preset === shortcutPreset;

                  return (
                    <button
                      key={preset}
                      type="button"
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11px] font-medium text-white transition-colors ${
                        selected ? 'bg-white/15' : 'hover:bg-white/10'
                      }`}
                      onClick={() => {
                        setShortcutPreset(preset);
                        saveVoicePttShortcutPreset(preset);
                        setShortcutMenuOpen(false);
                      }}
                    >
                      <span>{getShortcutOptionLabel(preset)}</span>
                      {selected ? <span className="text-[10px] text-white/70">✓</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div
          className={`
            relative h-full w-3.5 shrink-0 rounded-large p-[2px] overflow-hidden md:w-4
            transition-colors duration-150
            ${meterContainerClass}
          `}
          title={t('ptt.inputLevelTitle', { percent: meterPercent })}
          aria-label={t('ptt.inputLevelAria', { percent: meterPercent })}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={meterPercent}
          aria-valuetext={t('ptt.inputLevelAria', { percent: meterPercent })}
        >
          <div className="relative h-full w-full rounded-medium bg-content1/75 dark:bg-default-100/10 overflow-hidden">
            <div
              className={`
                absolute inset-x-0 bottom-0 rounded-md transition-[height,opacity] duration-75 ease-out
                ${meterFillClass}
              `}
              style={{
                height: `${meterFillPercent}%`,
                opacity: meterHasInput ? (meterIsPttActive ? 1 : 0.35) : 0.2,
              }}
            />
            <div
              className={`absolute inset-x-0 h-[2px] rounded-full transition-[bottom,opacity] duration-100 ease-out ${peakMarkerClass}`}
              style={{
                bottom: `${Math.max(0, peakMarkerPercent - 2)}%`,
                opacity: meterHasInput && meterFillPercent > 0 ? (meterIsPttActive ? 1 : 0.35) : 0,
              }}
            />
            {!meterHasInput && (
              <div className="absolute inset-x-0 bottom-0 h-1.5 rounded-full bg-default-500/30 dark:bg-default-300/20" />
            )}
          </div>
        </div>
      </div>

      <Modal isOpen={httpsRequiredModalOpen} onOpenChange={setHttpsRequiredModalOpen} placement="center"
        scrollBehavior="inside"
      >
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{t('ptt.httpsRequiredTitle')}</ModalHeader>
              <ModalBody className="space-y-3">
                <p className="text-sm text-default-700">
                  {t('ptt.httpsRequiredDescription', { origin: currentOrigin })}
                </p>
                <div className="rounded-lg border border-divider bg-default-50 px-3 py-3 text-sm text-default-700">
                  <p className="font-medium">{httpsRoleTitle}</p>
                  <p className="mt-1 text-default-600">{httpsRoleBody}</p>
                </div>
                <div className="rounded-lg border border-warning-200 bg-warning-50 px-3 py-3 text-sm text-warning-900">
                  <p className="font-medium">{t('ptt.httpsRequiredCurrentIdentityLabel')}</p>
                  <p className="mt-1">
                    {t('ptt.httpsRequiredCurrentIdentityValue', { role: currentRoleLabel })}
                  </p>
                </div>
                <p className="text-xs text-default-500">
                  {t('ptt.httpsRequiredBypassHint')}
                </p>
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>
                  {t('ptt.httpsRequiredCancel')}
                </Button>
                <Button color="primary" onPress={() => dismissHttpsWarning(true)}>
                  {t('ptt.httpsRequiredDontWarnAgain')}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
};
