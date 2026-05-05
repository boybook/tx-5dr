import React from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from '@heroui/react';
import { ThemeToggle } from '../../components/common/ThemeToggle';
import { useAppVersion } from '../../hooks/useAppVersion';
import { isPackagedBuild, useBuildInfo } from '../../hooks/useBuildInfo';

export const AboutHeader: React.FC = () => {
  const { t } = useTranslation('about');
  const version = useAppVersion();
  const buildInfo = useBuildInfo();
  const packaged = isPackagedBuild(buildInfo);
  const isNightly = packaged && buildInfo?.channel === 'nightly';
  const displayVersion = buildInfo?.version || version || t('versionUnknown');

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex items-center gap-4">
        <img
          src="./favicon.svg"
          alt={t('appName')}
          className="w-16 h-16 flex-shrink-0"
        />
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-foreground">{t('appName')}</h1>
          <p className="text-sm text-default-500">{t('tagline')}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-default-400">
            <span>
              {t('version')}: {displayVersion}
            </span>
            {isNightly && (
              <Chip size="sm" variant="flat" color="warning" className="h-5">
                {t('channel.nightly')}
              </Chip>
            )}
            {packaged && buildInfo && (
              <span className="font-mono">
                · {t('commit')} {buildInfo.commitShort}
              </span>
            )}
          </div>
        </div>
      </div>
      <ThemeToggle />
    </div>
  );
};
