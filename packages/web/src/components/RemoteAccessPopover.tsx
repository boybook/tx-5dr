import React, { useState, useEffect, useCallback } from 'react';
import { Popover, PopoverTrigger, PopoverContent, Button, Divider } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGlobe, faCopy, faCheck } from '@fortawesome/free-solid-svg-icons';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '@tx5dr/core';
import type { NetworkInfo } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

interface RemoteAccessPopoverProps {
  clientCount: number;
}

export const RemoteAccessPopover: React.FC<RemoteAccessPopoverProps> = ({ clientCount }) => {
  const { t } = useTranslation();
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // 仅在 Popover 打开时加载网络信息
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    api.getNetworkInfo().then((info) => {
      if (!cancelled) setNetworkInfo(info);
    }).catch(() => {
      // 静默失败（可能没有权限）
    });

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

  return (
    <Popover
      placement="bottom-end"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
    >
      <PopoverTrigger>
        <div className="bg-content1 dark:bg-content2 rounded-md px-3 h-6 flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity">
          <FontAwesomeIcon icon={faGlobe} className="text-default-400 text-xs" />
          {clientCount > 1 && (
            <div className="text-xs font-mono text-default-500">
              {clientCount}
            </div>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent>
        <div className="p-3 w-64">
          <h4 className="text-sm font-semibold text-default-800 mb-2">
            {t('common:remoteAccess.title')}
          </h4>

          {networkInfo && networkInfo.addresses.length > 0 ? (
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
            </>
          ) : networkInfo ? (
            <p className="text-xs text-default-400">
              {t('common:remoteAccess.sameNetworkHint')}
            </p>
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
