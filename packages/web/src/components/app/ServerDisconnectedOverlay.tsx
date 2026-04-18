import { useState, useEffect, useRef } from 'react';
import { Button, Spinner } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlug } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { useTranslation } from 'react-i18next';
import type { RadioService } from '../../services/radioService';

interface ServerDisconnectedOverlayProps {
  isConnected: boolean;
  isConnecting: boolean;
  radioService: RadioService | null;
}

export function ServerDisconnectedOverlay({ isConnected, isConnecting, radioService }: ServerDisconnectedOverlayProps) {
  const { t } = useTranslation();
  const [isManualConnecting, setIsManualConnecting] = useState(false);
  const shouldShowRecovering = !isConnected && isConnecting;
  // 控制动画：visible 决定是否渲染，shown 控制 opacity
  const [visible, setVisible] = useState(shouldShowRecovering);
  const [shown, setShown] = useState(shouldShowRecovering);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DISCONNECTED_GRACE_MS = 1200;

  useEffect(() => {
    if (showDelayRef.current) {
      clearTimeout(showDelayRef.current);
      showDelayRef.current = null;
    }

    if (isConnected) {
      // 连接恢复：淡出
      setShown(false);
      // 动画结束后卸载
      timerRef.current = setTimeout(() => setVisible(false), 300);
    } else if (isConnecting) {
      setVisible(true);
      requestAnimationFrame(() => setShown(true));
    } else {
      showDelayRef.current = setTimeout(() => {
        setVisible(true);
        requestAnimationFrame(() => setShown(true));
      }, DISCONNECTED_GRACE_MS);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (showDelayRef.current) clearTimeout(showDelayRef.current);
    };
  }, [isConnected, isConnecting]);

  // 连接恢复后重置手动连接状态
  useEffect(() => {
    if (isConnected) {
      setIsManualConnecting(false);
    }
  }, [isConnected]);

  const handleReconnect = async () => {
    if (!radioService) return;
    setIsManualConnecting(true);
    try {
      await radioService.forceReconnect({ requireHello: true });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : t('errors:code.UNKNOWN_ERROR.userMessage');
      const env = import.meta.env.DEV ? 'development' : 'production';
      const isInElectron = (() => {
        try { return typeof window !== 'undefined' && window.navigator.userAgent.includes('Electron'); } catch { return false; }
      })();
      const lines: string[] = [];
      if (errMsg.toLowerCase().includes('refused') || errMsg.toLowerCase().includes('unavailable') ||
          errMsg.toLowerCase().includes('econnrefused') || errMsg.toLowerCase().includes('failed to fetch')) {
        lines.push(t('common:serverError.diagnose.serviceUnavailable'));
      }
      if (env === 'development') {
        lines.push(t('common:serverError.diagnose.devCheck'));
        lines.push(t('common:serverError.diagnose.devLog'));
      } else if (isInElectron) {
        lines.push(t('common:serverError.diagnose.electronCheck'));
      } else {
        lines.push(t('common:serverError.diagnose.prodCheck'));
        lines.push(t('common:serverError.diagnose.dockerCheck'));
      }
      addToast({
        title: t('common:serverError.title'),
        description: `${t('common:serverError.description', { errMsg })}。\n${lines.join('\n')}`,
      });
    } finally {
      setIsManualConnecting(false);
    }
  };

  if (!visible) return null;

  const connecting = isConnecting || isManualConnecting;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md bg-background/60 transition-opacity duration-300"
      style={{ opacity: shown ? 1 : 0, pointerEvents: shown ? 'auto' : 'none' }}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        {connecting ? (
          <>
            <Spinner size="lg" color="primary" />
            <p className="text-default-500 text-sm">{t('common:serverError.connecting')}</p>
          </>
        ) : (
          <>
            <div className="w-16 h-16 rounded-full bg-default-100 flex items-center justify-center">
              <FontAwesomeIcon icon={faPlug} className="text-default-400 text-2xl" />
            </div>
            <div>
              <p className="text-default-700 font-medium">{t('common:serverError.disconnected')}</p>
              <p className="text-default-400 text-sm mt-1">{t('common:serverError.checkNetwork')}</p>
            </div>
            <Button
              color="primary"
              variant="flat"
              onPress={handleReconnect}
              className="mt-2"
            >
              {t('common:serverError.reconnect')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
