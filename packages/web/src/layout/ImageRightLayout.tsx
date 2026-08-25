import React, { useEffect, useState } from 'react';
import { Tab, Tabs } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faImages, faPaperPlane } from '@fortawesome/free-solid-svg-icons';

import { ImageHistoryTimeline } from '../components/image-radio/ImageHistoryTimeline';
import { SstvComposer } from '../components/image-radio/SstvComposer';
import { VoiceQSOLogCard } from '../components/voice/VoiceQSOLogCard';
import { VoicePTTButton } from '../components/voice/VoicePTTButton';
import { RadioControl } from '../components/radio/control/RadioControl';
import { ThemeToggle } from '../components/common/ThemeToggle';
import { SettingsButton } from '../components/common/SettingsButton';
import { ServerHealthButton } from '../components/system/ServerHealthButton';
import { useConnection, useRadioModeState } from '../store/radioStore';
import { useVoiceCaptureController } from '../hooks/useVoiceCaptureController';
import { useTranslation } from 'react-i18next';
import { useImageRadioControls } from '../hooks/useImageRadio';
import { api } from '@tx5dr/core';

export function ImageRightLayout() {
  const { t } = useTranslation('image');
  const connection = useConnection();
  const radioMode = useRadioModeState();
  const isFax = radioMode.currentMode?.name === 'FAX';
  const [selectedTab, setSelectedTab] = useState<'history' | 'transmit'>('history');
  const [qsoCollapsed, setQsoCollapsed] = useState(true);
  const { txStatus } = useImageRadioControls();
  const voiceCaptureController = useVoiceCaptureController(connection.state.radioService, radioMode.engineMode);

  useEffect(() => {
    if (isFax) setSelectedTab('history');
  }, [isFax]);

  return (
    <div className="image-right-layout flex h-full min-h-0 flex-col overflow-hidden">
      <div
        className="flex flex-shrink-0 items-center justify-between gap-2 p-1 px-2 md:p-2 md:px-3"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        <div
          className="min-w-0"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
        >
          <Tabs
            aria-label="Image radio"
            variant="underlined"
            selectedKey={selectedTab}
            onSelectionChange={(key) => setSelectedTab(key as 'history' | 'transmit')}
            classNames={{
              base: 'w-auto',
              tabList: 'w-auto gap-1 p-0',
              tab: 'w-auto px-3',
              panel: 'hidden p-0',
            }}
          >
            <Tab key="history" title={<span className="flex items-center gap-2"><FontAwesomeIcon icon={faImages} /><span>{t('history')}</span></span>} />
            {!isFax ? <Tab key="transmit" title={<span className="flex items-center gap-2"><FontAwesomeIcon icon={faPaperPlane} /><span>{t('transmit')}</span></span>} /> : null}
          </Tabs>
        </div>
        <div
          className="flex items-center"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion: string }}
        >
          <ServerHealthButton /><ThemeToggle variant="dropdown" size="sm" /><SettingsButton />
        </div>
      </div>
      <div className="min-h-0 flex-1 px-2 md:px-5">
        {selectedTab === 'transmit' && !isFax ? <SstvComposer /> : <ImageHistoryTimeline />}
      </div>
      {!isFax ? (
        <div className="flex-shrink-0 px-2 pb-2 md:px-5">
          <VoiceQSOLogCard
            collapsed={qsoCollapsed}
            onCollapsedChange={setQsoCollapsed}
            modeOverride="SSTV"
            defaultReport="595"
            titleOverride="SSTV QSO"
            onCreateComplete={(qso) => {
              if (txStatus?.phase === 'completed' && txStatus.historyId) void api.updateImageHistoryRecord(txStatus.historyId, { qsoId: qso.id });
            }}
          />
        </div>
      ) : null}
      <div className={`image-radio-bottom-controls flex-shrink-0 gap-2 px-2 pb-2 md:px-5 md:pb-5 ${isFax ? 'image-radio-bottom-controls--fax' : ''}`}>
        {!isFax ? <div className="image-radio-voice-ptt"><VoicePTTButton voiceCaptureController={voiceCaptureController} idleLabel={t('voice')} /></div> : null}
        <div className="min-w-0 flex-1"><RadioControl onOpenRadioSettings={() => window.dispatchEvent(new Event('openProfileModal'))} voiceCaptureController={isFax ? undefined : voiceCaptureController} /></div>
      </div>
    </div>
  );
}
