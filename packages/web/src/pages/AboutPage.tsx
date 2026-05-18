import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, CardBody, Divider } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { faBug, faFileLines, faUser } from '@fortawesome/free-solid-svg-icons';
import { useTheme } from '../hooks/useTheme';
import { useAppVersion } from '../hooks/useAppVersion';
import { isPackagedBuild, useBuildInfo } from '../hooks/useBuildInfo';
import { openExternal } from '../utils/openExternal';
import { isElectron } from '../utils/config';
import { AboutHeader } from './about/AboutHeader';
import { DependencyList } from './about/DependencyList';
import { SponsorList } from './about/SponsorList';
import { DesktopUpdateCard } from '../components/app/DesktopUpdateCard';
import { useLanguage } from '../hooks/useLanguage';

const REPO_URL = 'https://github.com/boybook/tx-5dr';
const ISSUES_URL = 'https://github.com/boybook/tx-5dr/issues';
const LICENSE_URL = 'https://github.com/boybook/tx-5dr/blob/main/LICENSE';
const AUTHOR_URL = 'https://github.com/boybook';
const TITLEBAR_HEIGHT = 32;

interface AboutPageProps {
  embedded?: boolean;
  showUpdateCard?: boolean;
}

export const AboutPage: React.FC<AboutPageProps> = ({ embedded, showUpdateCard = false }) => {
  useTheme();
  useLanguage();
  const { t } = useTranslation('about');
  const version = useAppVersion();
  const buildInfo = useBuildInfo();
  const packaged = isPackagedBuild(buildInfo);
  const isNightly = packaged && buildInfo?.channel === 'nightly';
  const displayVersion = buildInfo?.version || version || t('versionUnknown');
  const year = new Date().getFullYear();
  const isEmbedded = embedded ?? (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('embed') === '1');
  const showMacTitlebar = !isEmbedded && isElectron() && navigator.userAgent.includes('Macintosh');

  useEffect(() => {
    if (isEmbedded) {
      return undefined;
    }

    document.documentElement.classList.add('about-page');
    document.body.classList.add('about-page');
    return () => {
      document.documentElement.classList.remove('about-page');
      document.body.classList.remove('about-page');
    };
  }, [isEmbedded]);

  return (
    <div className={`${isEmbedded ? 'h-full overflow-y-auto' : 'min-h-screen'} bg-default-100 text-foreground`}>
      {showMacTitlebar && (
        <div
          className="fixed top-0 left-0 right-0 z-50 flex"
          style={{ height: TITLEBAR_HEIGHT, pointerEvents: 'none' } as React.CSSProperties}
        >
          <div className="h-full" style={{ width: 80 }} />
          <div
            className="flex-1 h-full"
            style={{ pointerEvents: 'auto', WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
          <div className="h-full" style={{ width: 80 }} />
        </div>
      )}
      <div
        className="max-w-3xl mx-auto p-6 space-y-4"
        style={showMacTitlebar ? { paddingTop: TITLEBAR_HEIGHT + 16 } : undefined}
      >
        <Card shadow="none">
          <CardBody className="px-6 py-5">
            <AboutHeader />
          </CardBody>
        </Card>

        {showUpdateCard && <DesktopUpdateCard />}

        <Card shadow="none">
          <CardBody className="gap-3 px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-default-500">{t('author')}</span>
              <Button
                size="sm"
                variant="light"
                startContent={<FontAwesomeIcon icon={faUser} />}
                onPress={() => openExternal(AUTHOR_URL)}
              >
                {t('authorCallsign')} (boybook)
              </Button>
            </div>
            <Divider />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-default-500">{t('license')}</span>
              <Button
                size="sm"
                variant="light"
                startContent={<FontAwesomeIcon icon={faFileLines} />}
                onPress={() => openExternal(LICENSE_URL)}
              >
                GPL-3.0
              </Button>
            </div>
            <p className="text-xs text-default-400 leading-relaxed">{t('licenseNote')}</p>
            <Divider />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="flat"
                color="primary"
                startContent={<FontAwesomeIcon icon={faGithub} />}
                onPress={() => openExternal(REPO_URL)}
              >
                {t('repository')}
              </Button>
              <Button
                size="sm"
                variant="flat"
                startContent={<FontAwesomeIcon icon={faBug} />}
                onPress={() => openExternal(ISSUES_URL)}
              >
                {t('issues')}
              </Button>
              <Button
                size="sm"
                variant="flat"
                startContent={<FontAwesomeIcon icon={faFileLines} />}
                onPress={() => openExternal(LICENSE_URL)}
              >
                {t('viewLicense')}
              </Button>
            </div>
          </CardBody>
        </Card>

        <DependencyList />

        <SponsorList />

        <p className="text-center text-xs text-default-400 pt-2 pb-4">
          © {year} {t('authorCallsign')} · GPL-3.0 · {t('version')} {displayVersion}
          {isNightly && ' · Nightly'}
          {packaged && buildInfo && ` · ${buildInfo.commitShort}`}
        </p>
      </div>
    </div>
  );
};
