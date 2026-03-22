import React, { useState, useEffect } from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { SpectrumDisplay } from '../components/SpectrumDisplay';
import { RadioMetersDisplay } from '../components/RadioMetersDisplay';
import { VoiceFrequencyControl } from '../components/voice/VoiceFrequencyControl';
import { RemoteAccessPopover } from '../components/RemoteAccessPopover';
import { StationInfoPopover } from '../components/StationInfoPopover';
import { useRadioState, useConnection } from '../store/radioStore';
import { useHasMinRole } from '../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { isElectron } from '../utils/config';

/**
 * VoiceLeftLayout
 *
 * Left panel layout for voice mode:
 * - Top toolbar (UTC time, GitHub link)
 * - VoiceFrequencyControl (frequency display + presets + mode buttons)
 * - SpectrumDisplay (without frequency markers)
 * - RadioMetersDisplay
 */
export const VoiceLeftLayout: React.FC = () => {
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const radio = useRadioState();
  const connection = useConnection();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [isMobile, setIsMobile] = useState(false);
  const [clientCount, setClientCount] = useState(0);

  // Update current time
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

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

  const formatUTCTime = (date: Date) => date.toISOString().slice(11, 19);

  return (
    <div className="h-full flex flex-col">
      {/* Top toolbar */}
      <div
        className="flex-shrink-0 flex justify-between items-center p-1 px-2 md:p-2 md:px-3 cursor-default select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        {/* Left: App name (non-Electron) */}
        <div className="flex items-center">
          {!isElectron() && (
            <div className="text-lg font-bold text-foreground cursor-default select-none pl-2 flex items-center gap-1">
              <span className="text-default-800">TX-5DR</span>
              <Button
                onPress={() => window.open('https://github.com/boybook/tx-5dr', '_blank')}
                isIconOnly
                variant="light"
                size="sm"
                title="Github"
                aria-label="Github"
              >
                <FontAwesomeIcon icon={faGithub} className="text-default-400 text-sm" />
              </Button>
            </div>
          )}
          <div
            className={isElectron() ? 'pl-16' : 'pl-2'}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
          >
            <StationInfoPopover />
          </div>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}>
          {isAdmin && <RemoteAccessPopover clientCount={clientCount} />}
          <div className="bg-content1 dark:bg-content2 rounded-md px-3 py-1">
            <div className="text-xs font-mono text-default-500">
              UTC {formatUTCTime(currentTime)}
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 px-2 pb-2 md:px-5 md:pb-5 min-h-0 flex flex-col gap-2 md:gap-4">
        {/* Voice Frequency Control - fills remaining space */}
        <div className="flex-1 min-h-0">
          <VoiceFrequencyControl />
        </div>

        {/* Spectrum Display (no frequency markers for voice mode) */}
        <div className="flex-shrink-0 bg-content2 rounded-lg shadow-sm overflow-hidden">
          <SpectrumDisplay
            height={isMobile ? 80 : 128}
            showMarkers={false}
          />
        </div>

        {/* Radio Meters */}
        {radio.state.radioConnected && radio.state.radioConfig?.type !== 'none' && (
          <div className="flex-shrink-0">
            <RadioMetersDisplay
              meterData={radio.state.meterData || { swr: null, alc: null, level: null, power: null }}
              isPttActive={radio.state.pttStatus.isTransmitting}
            />
          </div>
        )}
      </div>
    </div>
  );
};
