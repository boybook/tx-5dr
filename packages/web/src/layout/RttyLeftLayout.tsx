import React, { useState, useEffect } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { RadioMetersPanel } from '../components/radio/control/RadioMetersPanel';
import { RttyMacroPanel } from '../components/rtty/RttyMacroPanel';
import { RttyTerminal } from '../components/rtty/RttyTerminal';
import { RttyFrequencyControl } from '../components/rtty/RttyFrequencyControl';
import { RttyLeftPluginSlot } from '../components/rtty/RttyLeftPluginSlot';
import { RttyTuningOverlay } from '../components/rtty/RttyTuningOverlay';
import { RttySettingsModal } from '../components/rtty/RttySettingsModal';
import { RttyMobileQsoBar } from '../components/rtty/RttyMobileQsoBar';
import { rttyQsoDraftStore } from '../store/rttyQsoDraftStore';
import { RemoteAccessPopover } from '../components/system/RemoteAccessPopover';
import { ClockDisplay } from '../components/system/ClockDisplay';
import { StationInfoPopover } from '../components/station/StationInfoPopover';
import { AppBrandAboutLink } from '../components/common/AppBrandAboutLink';
import { useConnection, useStationInfo, useCurrentOperatorId } from '../store/radioStore';
import { useHasMinRole } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { isElectron, isMacOS } from '../utils/config';

/**
 * RttyLeftLayout
 *
 * Left panel layout for RTTY mode, mirroring the CW layout:
 * - Top toolbar (UTC time, GitHub link)
 * - Frequency control and audio spectrum with the mark/space tuning overlay
 * - Radio meters
 * - Receive terminal (takes the remaining height) and the compact macro
 *   panel with the transmit buffer (sized to its content, always visible)
 * - On phones, a QSO strip (call, report, Log) above the terminal
 *
 * RTTY state comes from the RttyProvider that App mounts around both panes.
 */
export const RttyLeftLayout: React.FC = React.memo(() => {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const connection = useConnection();
  const stationInfo = useStationInfo();
  const { currentOperatorId } = useCurrentOperatorId();
  const activeOperatorId = currentOperatorId || null;
  const hasStationContent = !!(stationInfo?.callsign || stationInfo?.name || stationInfo?.qth?.grid || stationInfo?.description);
  const [isMobile, setIsMobile] = useState(false);
  const [isShort, setIsShort] = useState(false);
  const [clientCount, setClientCount] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  // Short viewports (e.g. 1280×720) trade spectrum height for the terminal.
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-height: 820px)');
    setIsShort(mediaQuery.matches);
    const handleChange = (e: MediaQueryListEvent) => setIsShort(e.matches);
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
      <div className={`flex-1 px-2 pb-2 md:px-5 min-h-0 overflow-y-auto flex flex-col gap-2 ${isShort ? 'md:pb-3' : 'md:gap-3 md:pb-5'}`}>
        <RttyLeftPluginSlot operatorId={activeOperatorId} />

        <RttyFrequencyControl />

        {/* Audio spectrum with the draggable mark/space pair */}
        <Card shadow="sm" className="flex-shrink-0 overflow-hidden">
          <CardBody className="p-0 overflow-hidden">
            <RttyTuningOverlay height={isMobile ? 80 : isShort ? 68 : 120} />
          </CardBody>
        </Card>

        {/* Radio Meters (left out on short screens, where the terminal needs the room) */}
        {!isShort && <RadioMetersPanel className="flex-shrink-0" enableAlcOverLimitPrompt={false} />}

        {isMobile && <RttyMobileQsoBar />}

        <RttyTerminal
          className={`flex-1 ${isMobile ? 'min-h-[16rem]' : 'min-h-[14rem]'}`}
          onCallsign={rttyQsoDraftStore.setHisCallsign}
          onReport={rttyQsoDraftStore.setRrst}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="flex-shrink-0">
          <RttyMacroPanel embedded />
        </div>
      </div>
      <RttySettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
});
