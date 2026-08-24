import React, { useEffect, useState } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { UserRole } from '@tx5dr/contracts';

import { VoiceFrequencyControl } from '../components/voice/VoiceFrequencyControl';
import { ImageReceiveCanvas } from '../components/image-radio/ImageReceiveCanvas';
import { SpectrumDisplay } from '../components/radio/spectrum/SpectrumDisplay';
import { AppBrandAboutLink } from '../components/common/AppBrandAboutLink';
import { ClockDisplay } from '../components/system/ClockDisplay';
import { RemoteAccessPopover } from '../components/system/RemoteAccessPopover';
import { StationInfoPopover } from '../components/station/StationInfoPopover';
import { useConnection, useRadioModeState, useStationInfo } from '../store/radioStore';
import { useHasMinRole } from '../store/authStore';
import { isElectron, isMacOS } from '../utils/config';

export function ImageLeftLayout() {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const connection = useConnection();
  const stationInfo = useStationInfo();
  const radioMode = useRadioModeState();
  const [isMobile, setIsMobile] = useState(false);
  const [clientCount, setClientCount] = useState(0);
  const [isSpectrumCollapsed, setIsSpectrumCollapsed] = useState(false);
  const presetMode = radioMode.currentMode?.name === 'FAX' ? 'FAX' : 'SSTV';
  const hasStationContent = !!(stationInfo?.callsign || stationInfo?.name || stationInfo?.qth?.grid || stationInfo?.description);
  const stationInfoOffsetClassName = isElectron() && isMacOS()
    ? 'pl-16'
    : (isMobile && hasStationContent ? 'pl-0' : 'pl-2');

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    setIsMobile(mediaQuery.matches);
    const handleChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;
    const wsClient = radioService.wsClientInstance;
    const handleClientCount = (data: { count: number }) => setClientCount(data.count);
    wsClient.onWSEvent('clientCountChanged', handleClientCount);
    return () => { wsClient.offWSEvent('clientCountChanged', handleClientCount); };
  }, [connection.state.radioService]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="flex flex-shrink-0 items-center justify-between gap-2 p-1 px-2 cursor-default select-none md:p-2 md:px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {!isElectron() && (
            <div className="flex shrink-0 cursor-default select-none items-center gap-1 whitespace-nowrap pl-1 text-lg font-bold text-foreground md:pl-2">
              <AppBrandAboutLink />
              <Button
                onPress={() => window.open('https://github.com/boybook/tx-5dr', '_blank')}
                isIconOnly
                variant="light"
                size="sm"
                title="Github"
                aria-label="Github"
                className="hidden md:inline-flex"
              >
                <FontAwesomeIcon icon={faGithub} className="text-sm text-default-400" />
              </Button>
            </div>
          )}
          <div
            className={`min-w-0 ${stationInfoOffsetClassName}`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
          >
            <StationInfoPopover />
          </div>
        </div>
        <div
          className="flex flex-shrink-0 items-center gap-0.5 whitespace-nowrap md:gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
        >
          {isAdmin && <RemoteAccessPopover clientCount={clientCount} />}
          <ClockDisplay />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-2 pb-2 md:px-5 md:pb-5">
        <Card shadow="sm" className="min-h-0 flex-[3] overflow-hidden"><CardBody className="p-0"><ImageReceiveCanvas /></CardBody></Card>
        <div className="h-48 flex-shrink-0"><VoiceFrequencyControl presetMode={presetMode} compact hideTitle /></div>
        <Card shadow="sm" className={`${isSpectrumCollapsed ? 'h-8' : 'h-24'} flex-shrink-0 overflow-hidden motion-safe:transition-[height] motion-safe:duration-150`}><CardBody className="p-0"><SpectrumDisplay height={96} showMarkers={false} onCollapsedChange={setIsSpectrumCollapsed} /></CardBody></Card>
      </div>
    </div>
  );
}
