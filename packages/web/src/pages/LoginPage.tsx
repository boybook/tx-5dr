import React, { useState, useEffect } from 'react';
import { Button } from '@heroui/react';
import { AnimatePresence, motion } from 'framer-motion';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight, faComputer, faLocationDot, faSliders, faTowerBroadcast } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { api } from '@tx5dr/core';
import type { StationInfo } from '@tx5dr/contracts';
import { AuthLoginForm } from '../components/auth/AuthLoginForm';
import { hasDesktopCapability } from '../utils/desktopBridge';
import { openStationManager, useCurrentDesktopStation } from '../utils/desktopStations';
import { displayHost } from '../components/stations/stationText';
import { isElectron } from '../utils/config';

const ease = [0.16, 1, 0.3, 1] as const;

/** Station profile shown above the form, as plain text rather than a card. */
const StationProfileLine: React.FC<{ stationInfo: StationInfo }> = ({ stationInfo }) => {
  const { callsign, name, qth } = stationInfo;
  if (!callsign && !name && !qth?.grid && !qth?.location) return null;
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      {(callsign || name) && (
        <p className="text-small text-foreground">
          {callsign && <span className="font-semibold">{callsign}</span>}
          {callsign && name && <span className="mx-1.5 text-default-300">·</span>}
          {name && <span className="text-default-600">{name}</span>}
        </p>
      )}
      {(qth?.location || qth?.grid) && (
        <p className="flex items-center gap-1.5 text-tiny text-default-500">
          <FontAwesomeIcon icon={faLocationDot} className="text-[10px]" />
          {qth?.location}
          {qth?.location && qth?.grid && <span className="text-default-300">·</span>}
          {qth?.grid && <span className="font-mono">{qth.grid}</span>}
        </p>
      )}
    </div>
  );
};

/** In the desktop shell, names the station this window connects to and links to the station manager. */
const DesktopStationFooter: React.FC = () => {
  const { t } = useTranslation('stations');
  const station = useCurrentDesktopStation();
  if (!hasDesktopCapability('stations')) return null;
  const isRemote = station?.kind === 'remote';
  return (
    <div className="flex items-center justify-between gap-3 text-tiny text-default-500">
      <span className="flex min-w-0 items-center gap-2">
        <FontAwesomeIcon icon={isRemote ? faTowerBroadcast : faComputer} className={isRemote ? 'text-secondary' : 'text-primary'} />
        <span className="truncate">
          {isRemote ? (station?.label ?? t('tag.remote')) : t('tag.embedded')}
          {isRemote && station?.url && <span className="ml-1.5 font-mono text-default-400">{displayHost(station.url)}</span>}
        </span>
      </span>
      <Button
        size="sm"
        variant="light"
        className="flex-shrink-0 text-default-500"
        startContent={<FontAwesomeIcon icon={faSliders} className="text-[11px]" />}
        onPress={() => void openStationManager()}
      >
        {t('tag.manage')}
      </Button>
    </div>
  );
};

export function LoginPage() {
  const { t } = useTranslation();
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [stationInfo, setStationInfo] = useState<StationInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getStationInfo().then(resp => {
      if (!cancelled) setStationInfo(resp.data);
    }).catch(() => { /* silent failure — station info is non-essential */ });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="app-viewport-min-height relative flex w-full flex-col overflow-y-auto bg-background text-foreground">
      {isElectron() && (
        <div aria-hidden className="h-10 w-full flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      )}

      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease }}
          className="flex w-full max-w-[360px] flex-col gap-8"
        >
          <header className="flex flex-col items-center gap-4 text-center">
            <img src="./favicon.svg" alt="" className="h-14 w-14 select-none" draggable={false} />
            <div className="flex flex-col gap-1">
              <h1 className="text-3xl font-semibold tracking-tight">TX-5DR</h1>
              <p className="text-small text-default-500">{t('auth:loginPage.subtitle')}</p>
            </div>
            {stationInfo && <StationProfileLine stationInfo={stationInfo} />}
          </header>

          <AuthLoginForm autoFocus inputVariant="flat" />

          <div className="flex flex-col">
            <button
              type="button"
              className="flex w-fit items-center gap-1.5 rounded-small text-tiny text-default-400 outline-none transition-colors hover:text-default-600 focus-visible:ring-2 focus-visible:ring-focus"
              aria-expanded={helpExpanded}
              onClick={() => setHelpExpanded(!helpExpanded)}
            >
              <motion.span animate={{ rotate: helpExpanded ? 90 : 0 }} transition={{ duration: 0.2, ease }} className="flex">
                <FontAwesomeIcon icon={faChevronRight} className="text-[10px]" />
              </motion.span>
              {t('auth:loginPage.helpTitle')}
            </button>
            <AnimatePresence initial={false}>
              {helpExpanded && (
                <motion.p
                  key="help"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.22, ease }}
                  className="overflow-hidden pl-4 text-tiny leading-relaxed text-default-400"
                >
                  <span className="block pt-1.5">{t('auth:loginPage.helpContent')}</span>
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </main>

      <footer className="mx-auto w-full max-w-[680px] px-6 pb-5">
        <DesktopStationFooter />
      </footer>
    </div>
  );
}
