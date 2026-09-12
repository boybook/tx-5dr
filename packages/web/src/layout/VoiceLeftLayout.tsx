import React, { useState, useEffect } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { SpectrumDisplay } from '../components/radio/spectrum/SpectrumDisplay';
import { RadioMetersPanel } from '../components/radio/control/RadioMetersPanel';
import { VoiceFrequencyControl } from '../components/voice/VoiceFrequencyControl';
import { VoiceLeftPluginSlot } from '../components/voice/VoiceLeftPluginSlot';
import { RemoteAccessPopover } from '../components/system/RemoteAccessPopover';
import { ClockDisplay } from '../components/system/ClockDisplay';
import { StationInfoPopover } from '../components/station/StationInfoPopover';
import { AppBrandAboutLink } from '../components/common/AppBrandAboutLink';
import { useConnection, useStationInfo, useCurrentOperatorId } from '../store/radioStore';
import { useHasMinRole } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { isElectron, isMacOS } from '../utils/config';

/**
 * VoiceLeftLayout
 *
 * Left panel layout for voice mode:
 * - Top toolbar (UTC time, GitHub link)
 * - VoiceFrequencyControl (frequency display + presets + mode buttons)
 * - SpectrumDisplay (without frequency markers)
 * - RadioMetersDisplay
 */
export const VoiceLeftLayout: React.FC = React.memo(() => {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const connection = useConnection();
  const stationInfo = useStationInfo();
  const { currentOperatorId } = useCurrentOperatorId();
  const activeOperatorId = currentOperatorId || null;
  const hasStationContent = !!(stationInfo?.callsign || stationInfo?.name || stationInfo?.qth?.grid || stationInfo?.description);
  const [isMobile, setIsMobile] = useState(false);
  const [clientCount, setClientCount] = useState(0);

  const stationInfoOffsetClassName = isElectron() && isMacOS()
    ? 'pl-16'
    : (isMobile && hasStationContent ? 'pl-0' : 'pl-2');

  // Mobile detection
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    setIsMobile(mediaQuery.matches);
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Client count subscription
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;
    const wsClient = radioService.wsClientInstance;
    const handleClientCount = (data: { count: number }) => setClientCount(data.count);
    wsClient.onWSEvent('clientCountChanged', handleClientCount);
    return () => { wsClient.offWSEvent('clientCountChanged', handleClientCount); };
  }, [connection.state.radioService]);

  return (
    <div className="h-full flex flex-col">
      {/* Top toolbar */}
      <div
        className="flex-shrink-0 flex justify-between items-center gap-2 p-1 px-2 md:p-2 md:px-3 cursor-default select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        {/* Left: App name (non-Electron) */}
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {!isElectron() && (
            <div className="text-lg font-bold text-foreground cursor-default select-none pl-1 md:pl-2 flex shrink-0 items-center gap-1 whitespace-nowrap">
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
                <FontAwesomeIcon icon={faGithub} className="text-default-400 text-sm" />
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
        <div className="flex flex-shrink-0 items-center gap-0.5 md:gap-1 whitespace-nowrap" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          {isAdmin && <RemoteAccessPopover clientCount={clientCount} />}
          <ClockDisplay />
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 px-2 pb-2 md:px-5 md:pb-5 min-h-0 flex flex-col gap-2 md:gap-4">
        <VoiceLeftPluginSlot operatorId={activeOperatorId} />

        {/* Voice Frequency Control - fills remaining space */}
        <div className="flex-1 min-h-0">
          <VoiceFrequencyControl />
        </div>

        {/* Spectrum Display (no frequency markers for voice mode) */}
        <Card shadow="sm" className="flex-shrink-0 overflow-hidden">
          <CardBody className="p-0 overflow-hidden">
            <SpectrumDisplay
              height={isMobile ? 80 : 128}
              showMarkers={false}
            />
          </CardBody>
        </Card>

        {/* Radio Meters */}
        <RadioMetersPanel className="flex-shrink-0" enableAlcOverLimitPrompt={false} />
      </div>
    </div>
  );
});
