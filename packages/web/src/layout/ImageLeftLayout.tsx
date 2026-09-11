import React, { useEffect, useState } from 'react';
import { Button, Card, CardBody } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGithub } from '@fortawesome/free-brands-svg-icons';
import { UserRole } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { VoiceFrequencyControl } from '../components/voice/VoiceFrequencyControl';
import { ImageReceiveCanvas } from '../components/image-radio/ImageReceiveCanvas';
import { HorizontalPaneDivider } from '../components/common/HorizontalPaneDivider';
import { RadioMetersDisplay } from '../components/radio/control/RadioMetersDisplay';
import { SpectrumDisplay } from '../components/radio/spectrum/SpectrumDisplay';
import { AppBrandAboutLink } from '../components/common/AppBrandAboutLink';
import { ClockDisplay } from '../components/system/ClockDisplay';
import { RemoteAccessPopover } from '../components/system/RemoteAccessPopover';
import { StationInfoPopover } from '../components/station/StationInfoPopover';
import { useConnection, useRadioModeState, useRadioState, useStationInfo } from '../store/radioStore';
import { useHasMinRole } from '../store/authStore';
import { isElectron, isMacOS } from '../utils/config';
import { EMPTY_METER_DATA, shouldShowRadioMetersPanel } from '../utils/radioMeters';
import { useVerticalPaneSplit } from '../hooks/useVerticalPaneSplit';
import { PANE_SPLIT_DIVIDER_HEIGHT_PX } from './paneSplitPreferences';

const IMAGE_LEFT_SPLIT_STORAGE_KEY = 'tx5dr_image_left_split_percent';
const DEFAULT_IMAGE_LEFT_SPLIT_PERCENT = 60;
const IMAGE_LEFT_MIN_PANE_HEIGHT_PX = 120;

export function ImageLeftLayout() {
  const { t } = useTranslation('common');
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const connection = useConnection();
  const radio = useRadioState();
  const stationInfo = useStationInfo();
  const radioMode = useRadioModeState();
  const [isMobile, setIsMobile] = useState(false);
  const [clientCount, setClientCount] = useState(0);
  const [isSpectrumCollapsed, setIsSpectrumCollapsed] = useState(false);
  const {
    containerRef: imageSplitContainerRef,
    leadingPaneRef: imagePaneRef,
    hasCustomSplit,
    isDraggingSplit,
    splitPercent,
    containerHeight,
    leadingPaneHeightPx,
    handleDividerPointerDown,
    handleDividerDoubleClick,
  } = useVerticalPaneSplit({
    storageKey: IMAGE_LEFT_SPLIT_STORAGE_KEY,
    defaultSplitPercent: DEFAULT_IMAGE_LEFT_SPLIT_PERCENT,
    minPaneHeightPx: IMAGE_LEFT_MIN_PANE_HEIGHT_PX,
  });
  const presetMode = radioMode.currentMode?.name === 'FAX' ? 'FAX' : 'SSTV';
  const showRadioMeters = shouldShowRadioMetersPanel({
    radioConnected: radio.state.radioConnected,
    radioConfigType: radio.state.radioConfig?.type,
    meterCapabilities: radio.state.meterCapabilities,
    hasReceivedMeterData: radio.state.hasReceivedMeterData,
  });
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
      {isDraggingSplit && (
        <div className="fixed inset-0 z-[9999] cursor-row-resize bg-transparent" />
      )}
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
        {/* 图像区与频率面板由 8px 分割拖拽条直接相邻，不再叠加外层 gap，保持原有视觉间距。 */}
        <div ref={imageSplitContainerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            ref={imagePaneRef}
            className={`min-h-0 overflow-hidden ${hasCustomSplit ? '' : 'flex-1'}`}
            style={hasCustomSplit
              ? { height: containerHeight > 0 ? `${leadingPaneHeightPx}px` : `${splitPercent}%` }
              : undefined}
          >
            <Card shadow="sm" className="h-full w-full overflow-hidden">
              <CardBody className="h-full p-0"><ImageReceiveCanvas /></CardBody>
            </Card>
          </div>
          <HorizontalPaneDivider
            heightPx={PANE_SPLIT_DIVIDER_HEIGHT_PX}
            isDragging={isDraggingSplit}
            onPointerDown={handleDividerPointerDown}
            onDoubleClick={handleDividerDoubleClick}
            resetHint={t('rightLayout.resetSplitToAuto')}
          />
          <div className={`min-h-0 overflow-hidden ${hasCustomSplit ? 'flex-1' : 'h-48 flex-shrink-0'}`}>
            <VoiceFrequencyControl presetMode={presetMode} compact hideTitle />
          </div>
        </div>
        <Card shadow="sm" className={`${isSpectrumCollapsed ? 'h-8' : 'h-24'} flex-shrink-0 overflow-hidden motion-safe:transition-[height] motion-safe:duration-150`}><CardBody className="p-0"><SpectrumDisplay height={96} showMarkers={false} onCollapsedChange={setIsSpectrumCollapsed} /></CardBody></Card>
        {/* 电台数值表（无电台模式下隐藏，不支持时由组件内部返回 null） */}
        {showRadioMeters && (
          <div className="flex-shrink-0">
            <RadioMetersDisplay
              meterData={radio.state.meterData || EMPTY_METER_DATA}
              isPttActive={radio.state.pttStatus.isTransmitting}
              meterCapabilities={radio.state.meterCapabilities}
            />
          </div>
        )}
      </div>
    </div>
  );
}
