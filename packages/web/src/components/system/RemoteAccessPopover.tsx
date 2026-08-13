import React, { useState, useEffect, useCallback } from 'react';
import { Popover, PopoverTrigger, PopoverContent, Button, Chip, Divider } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGlobe, faCopy, faCheck, faHouseLaptop, faShieldHalved } from '@fortawesome/free-solid-svg-icons';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@tx5dr/core';
import type { NetworkInfo, RemoteAccessPreset, RemoteAccessSecurityStatus } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

interface RemoteAccessPopoverProps {
  clientCount: number;
}

export const RemoteAccessPopover: React.FC<RemoteAccessPopoverProps> = ({ clientCount }) => {
  const { t } = useTranslation();
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [settings, setSettings] = useState<RemoteAccessSecurityStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getNetworkInfo().then(info => { if (!cancelled) setNetworkInfo(info); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 仅在 Popover 打开时加载网络信息
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    api.getNetworkInfo().then((info) => {
      if (!cancelled) setNetworkInfo(info);
    }).catch(() => {
      // 静默失败（可能没有权限）
    });
    api.getRemoteAccessSettings().then(value => {
      if (!cancelled) setSettings(value);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [isOpen]);

  const handleCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 2000);
    } catch {
      // 剪贴板 API 不可用时静默失败
    }
  }, []);

  const primaryUrl = networkInfo?.addresses?.[0]?.url;
  const supportedPresets = networkInfo?.supportedPresets ?? ['lan', 'public'];
  // External deployments cannot become loopback-only from this web UI.
  const rawPreset = settings?.preset ?? networkInfo?.exposure;
  const preset = rawPreset && supportedPresets.includes(rawPreset) ? rawPreset : 'lan';
  const isLocal = preset === 'local' && networkInfo?.supportsLocalOnly === true;

  const openAccessSettings = (remoteAccessPreset?: RemoteAccessPreset) => {
    setIsOpen(false);
    window.dispatchEvent(new CustomEvent('openSettingsModal', {
      detail: { tab: 'system', remoteAccessPreset },
    }));
  };

  return (
    <Popover
      placement="bottom-end"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
    >
      <PopoverTrigger>
        <div
          className="bg-content1 dark:bg-content2 rounded-md px-2 md:px-3 h-6 flex flex-shrink-0 items-center gap-1 md:gap-2 whitespace-nowrap cursor-pointer hover:opacity-80 transition-opacity"
          aria-label={t('common:remoteAccess.title')}
          title={t('common:remoteAccess.title')}
        >
          <FontAwesomeIcon icon={faGlobe} className="text-default-400 text-xs" />
          {clientCount > 1 && (
            <div className="text-xs font-mono text-default-500">
              {clientCount}
            </div>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent>
        <div className="w-72 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h4 className="text-sm font-semibold text-default-800">
              {t('common:remoteAccess.title')}
            </h4>
            {preset && (
              <Chip size="sm" variant="flat" color={isLocal ? 'default' : preset === 'lan' ? 'primary' : 'warning'}>
                {t(`system.remoteAccessPreset.${preset}.title`)}
              </Chip>
            )}
          </div>

          {isLocal ? (
            <div className="space-y-3">
              <div className="rounded-xl bg-default-50 px-3 py-3">
                <p className="text-sm font-medium text-default-800">{t('common:remoteAccess.localTitle')}</p>
                <p className="mt-1 text-xs leading-5 text-default-500">{t('common:remoteAccess.localDescription')}</p>
              </div>

              <div className="grid gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-primary-200 bg-primary-50/70 p-3 text-left transition hover:border-primary-400 dark:bg-primary-500/10"
                  onClick={() => openAccessSettings('lan')}
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-primary-700 dark:text-primary-300">
                    <FontAwesomeIcon icon={faHouseLaptop} />
                    {t('common:remoteAccess.enableLan')}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-default-500">{t('common:remoteAccess.enableLanDesc')}</p>
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-divider bg-content1 p-3 text-left transition hover:border-warning-400"
                  onClick={() => openAccessSettings('public')}
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-default-800">
                    <FontAwesomeIcon icon={faShieldHalved} className="text-warning-500" />
                    {t('common:remoteAccess.configurePublic')}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-default-500">{t('common:remoteAccess.configurePublicDesc')}</p>
                </button>
              </div>

              <p className="text-[11px] leading-4 text-default-400">{t('common:remoteAccess.saveInSettingsHint')}</p>
            </div>
          ) : networkInfo && networkInfo.addresses.length > 0 ? (
            <>
              <p className="text-xs text-default-500 mb-2">
                {t('common:remoteAccess.description')}
              </p>

              {/* 地址列表 */}
              <div className="space-y-1.5 mb-3">
                {networkInfo.addresses.map((addr) => (
                  <div key={addr.ip} className="flex items-center gap-1.5 bg-default-100 rounded-md px-2 py-1.5">
                    <code className="flex-1 text-xs text-default-700 truncate">{addr.url}</code>
                    <Button
                      size="sm"
                      variant="light"
                      isIconOnly
                      className="min-w-6 w-6 h-6"
                      onPress={() => handleCopy(addr.url)}
                      title={t('common:remoteAccess.copyLink')}
                    >
                      <FontAwesomeIcon
                        icon={copiedUrl === addr.url ? faCheck : faCopy}
                        className={copiedUrl === addr.url ? 'text-success text-xs' : 'text-default-400 text-xs'}
                      />
                    </Button>
                  </div>
                ))}
              </div>

              {/* QR 码 */}
              {primaryUrl && (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="bg-white p-2 rounded-md">
                    <QRCodeSVG value={primaryUrl} size={120} />
                  </div>
                  <span className="text-xs text-default-400">
                    {t('common:remoteAccess.scanToAccess')}
                  </span>
                </div>
              )}

              {/* 客户端数量 */}
              {clientCount > 1 && (
                <>
                  <Divider className="my-2" />
                  <p className="text-xs text-default-400 text-center">
                    {t('common:remoteAccess.clientCount', { count: clientCount })}
                  </p>
                </>
              )}
              {settings && (
                <>
                  <Divider className="my-3" />
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-default-700">{t('common:remoteAccess.publicViewer')}</p>
                      <p className="text-[11px] text-default-400">{settings.allowPublicViewing ? t('common:remoteAccess.publicOn') : t('common:remoteAccess.loginRequired')}</p>
                    </div>
                    <Chip size="sm" variant="flat" color={settings.allowPublicViewing ? 'warning' : 'success'}>
                      {settings.allowPublicViewing ? t('common:remoteAccess.enabled') : t('common:remoteAccess.disabled')}
                    </Chip>
                  </div>
                </>
              )}
              <Button fullWidth size="sm" variant="flat" className="mt-3" onPress={() => openAccessSettings()}>
                {t('common:remoteAccess.manageSettings')}
              </Button>
            </>
          ) : networkInfo ? (
            <div className="space-y-3">
              <p className="text-xs text-default-400">{t('common:remoteAccess.sameNetworkHint')}</p>
              <Button fullWidth size="sm" variant="flat" onPress={() => openAccessSettings()}>
                {t('common:remoteAccess.manageSettings')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-default-400">
              {t('common:status.loading')}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
