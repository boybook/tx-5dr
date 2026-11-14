import React, { useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronUp, faWaveSquare } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';
import { addToast } from '@heroui/toast';
import type { RttyScanChannel } from '@tx5dr/contracts';
import { useRtty, useRttyScan } from '../../hooks/useRtty';
import { useCan } from '../../store/authStore';
import { describeRttyError } from './rttyErrors';
import { lastCallsignIn } from './rttyText';

const COLLAPSED_ROWS = 3;
/** Within this the row counts as the signal being received (closer than AFC needs). */
const TUNED_TOLERANCE_HZ = 10;

export interface RttySignalBrowserProps {
  /** Callsign of this station, never offered as the other station. */
  myCallsign?: string;
  /** Tunes to the signal and takes its callsign as the other station. */
  onCallsign?: (callsign: string) => void;
}

/**
 * Signals found across the passband by the server's wideband scanner, each
 * with a decoded preview. Clicking a row tunes the receiver there (the recent
 * audio is then re-decoded); the callsign button also fills the QSO draft.
 */
export const RttySignalBrowser: React.FC<RttySignalBrowserProps> = ({ myCallsign, onCallsign }) => {
  const { t } = useTranslation('radio');
  const scan = useRttyScan();
  const { config, txStatus, updateConfig } = useRtty();
  const canConfigure = useCan('update', 'RttyDecoderConfig');
  const [expanded, setExpanded] = useState(false);
  if (!scan?.enabled || !config) return null;

  const channels = scan.channels;
  const transmitting = txStatus?.active ?? false;
  const visible = expanded ? channels : channels.slice(0, COLLAPSED_ROWS);
  const isTuned = (channel: RttyScanChannel) => Math.abs(channel.centerHz - config.centerHz) <= TUNED_TOLERANCE_HZ;

  const tune = (channel: RttyScanChannel) => {
    if (isTuned(channel)) return;
    updateConfig({ centerHz: Math.round(channel.centerHz) }).catch((error: unknown) => {
      addToast({ title: t('rtty.settings.saveFailed', 'Could not change RTTY settings'), description: describeRttyError(error, t), color: 'danger' });
    });
  };

  return (
    <div className="mt-2 rounded-lg bg-content2/60 px-2 py-1.5" data-testid="rtty-signal-browser">
      <div className="flex items-center justify-between gap-2 text-[11px] text-default-500">
        <span className="flex items-center gap-1.5">
          <FontAwesomeIcon icon={faWaveSquare} className="text-[10px]" />
          {t('rtty.browser.title', 'Signals')}
          <span className="text-default-400">{channels.length}</span>
        </span>
        {channels.length > COLLAPSED_ROWS && (
          <Button
            size="sm"
            variant="light"
            className="h-5 min-w-0 px-1 text-[10px]"
            onPress={() => setExpanded((value) => !value)}
            endContent={<FontAwesomeIcon icon={expanded ? faChevronUp : faChevronDown} className="text-[9px]" />}
          >
            {expanded ? t('rtty.browser.less', 'Less') : t('rtty.browser.more', 'All')}
          </Button>
        )}
      </div>
      {channels.length === 0 ? (
        <div className="py-1 text-[11px] text-default-400">{t('rtty.browser.empty', 'No other RTTY signals in the passband')}</div>
      ) : (
        <ul className="mt-1 flex flex-col gap-0.5">
          {visible.map((channel) => {
            const tuned = isTuned(channel);
            const callsign = lastCallsignIn(channel.preview, myCallsign);
            return (
              <li key={channel.id} className={`flex items-center gap-2 rounded-md px-1 ${tuned ? 'bg-primary/10' : 'hover:bg-default-100'}`}>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left disabled:cursor-default"
                  disabled={!canConfigure || transmitting || tuned}
                  title={tuned ? t('rtty.browser.tuned', 'Receiving this signal') : t('rtty.browser.tune', 'Tune to {{hz}} Hz', { hz: Math.round(channel.centerHz) })}
                  onClick={() => tune(channel)}
                >
                  <span className={`w-12 shrink-0 font-mono text-[11px] ${tuned ? 'font-semibold text-primary' : 'text-default-600'}`}>
                    {Math.round(channel.centerHz)}
                  </span>
                  <span className="w-11 shrink-0 font-mono text-[10px] text-default-400">{`${Math.round(channel.snrDb)} dB`}</span>
                  <span className={`min-w-0 flex-1 truncate font-mono text-[11px] ${channel.locked ? 'text-foreground' : 'text-default-400'}`}>
                    {channel.preview.trim() || '…'}
                  </span>
                </button>
                {callsign && onCallsign && (
                  <Tooltip content={t('rtty.browser.useCallsign', 'Tune here and work {{callsign}}', { callsign })}>
                    <Button
                      size="sm"
                      variant="flat"
                      color="primary"
                      className="h-5 min-w-0 shrink-0 px-1.5 font-mono text-[10px]"
                      isDisabled={transmitting}
                      onPress={() => {
                        tune(channel);
                        onCallsign(callsign);
                      }}
                    >
                      {callsign}
                    </Button>
                  </Tooltip>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
