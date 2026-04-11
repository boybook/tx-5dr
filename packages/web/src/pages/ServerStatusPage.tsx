import { useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faServer, faRotateRight, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import type { RadioService } from '../services/radioService';

interface ServerStatusPageProps {
  isConnecting: boolean;
  connectError: string | null;
  radioService: RadioService | null;
}

export function ServerStatusPage({ isConnecting, connectError, radioService }: ServerStatusPageProps) {
  const { t } = useTranslation();
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);

  const isInElectron = (() => {
    try { return typeof window !== 'undefined' && window.navigator.userAgent.includes('Electron'); } catch { return false; }
  })();
  const isDev = import.meta.env.DEV;

  const handleRetry = async () => {
    if (!radioService) return;
    setIsRetrying(true);
    setRetryError(false);
    try {
      await radioService.connect({ requireHello: true });
    } catch {
      setRetryError(true);
    } finally {
      setIsRetrying(false);
    }
  };

  const hints: { label: string; items: string[] }[] = [];
  if (isDev) {
    hints.push({
      label: t('common:serverStatus.hints.devTitle'),
      items: [
        t('common:serverStatus.hints.devStart'),
        t('common:serverStatus.hints.devPort'),
      ],
    });
  } else if (isInElectron) {
    hints.push({
      label: t('common:serverStatus.hints.electronTitle'),
      items: [t('common:serverStatus.hints.electronRestart')],
    });
  } else {
    hints.push({
      label: t('common:serverStatus.hints.linuxTitle'),
      items: [
        t('common:serverStatus.hints.linuxService'),
        t('common:serverStatus.hints.linuxSelinux'),
      ],
    });
    hints.push({
      label: t('common:serverStatus.hints.dockerTitle'),
      items: [t('common:serverStatus.hints.dockerLogs')],
    });
  }

  if (isConnecting && !connectError) {
    return (
      <div className="app-viewport-min-height w-full overflow-y-auto flex flex-col items-center justify-center gap-4 bg-background px-6 py-6">
        <Spinner size="lg" color="primary" />
        <p className="text-default-500 text-sm">{t('common:serverStatus.connecting')}</p>
      </div>
    );
  }

  return (
    <div className="app-viewport-min-height w-full overflow-y-auto flex flex-col items-center justify-center bg-background px-6 py-6">
      <div className="flex flex-col items-center gap-6 max-w-md w-full text-center">
        {/* 图标 */}
        <div className="w-20 h-20 rounded-full bg-danger-50 flex items-center justify-center">
          <FontAwesomeIcon icon={faServer} className="text-danger text-3xl" />
        </div>

        {/* 标题 */}
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {t('common:serverStatus.errorTitle')}
          </h1>
          <p className="text-default-500 text-sm mt-1">
            {t('common:serverStatus.errorSubtitle')}
          </p>
        </div>

        {/* 重试按钮 */}
        <Button
          color="primary"
          variant="flat"
          startContent={
            isRetrying
              ? <Spinner size="sm" color="current" />
              : <FontAwesomeIcon icon={faRotateRight} />
          }
          onPress={handleRetry}
          isDisabled={isRetrying}
          className="w-full max-w-xs"
        >
          {isRetrying ? t('common:serverStatus.retrying') : t('common:serverStatus.retry')}
        </Button>

        {retryError && (
          <p className="text-danger text-xs flex items-center gap-1">
            <FontAwesomeIcon icon={faTriangleExclamation} />
            {t('common:serverStatus.retryFailed')}
          </p>
        )}

        {/* 诊断建议 */}
        <div className="w-full text-left space-y-3 border border-default-200 rounded-lg p-4 bg-default-50">
          <p className="text-xs font-medium text-default-500 uppercase tracking-wide">
            {t('common:serverStatus.diagnoseTitle')}
          </p>
          {hints.map((group) => (
            <div key={group.label}>
              <p className="text-xs font-semibold text-default-600 mb-1">{group.label}</p>
              <ul className="space-y-1">
                {group.items.map((item) => (
                  <li key={item} className="text-xs text-default-500 font-mono bg-default-100 rounded px-2 py-1 break-all">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
