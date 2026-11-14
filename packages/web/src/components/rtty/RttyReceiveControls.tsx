import React from 'react';
import { Button, Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { addToast } from '@heroui/toast';
import type { RttySignal } from '@tx5dr/contracts';
import { useRtty, useRttyScan } from '../../hooks/useRtty';
import { useCan } from '../../store/authStore';
import { describeRttyError } from './rttyErrors';

/** Offsets below this are not worth re-centring for. */
const ALIGN_MIN_HZ = 5;
/** Range of the decoder's tone levels (contrast against the other tone, saturating near 18 dB). */
const LEVEL_MIN_DB = 0;
const LEVEL_MAX_DB = 20;

function levelPercent(db: number): number {
  return Math.round(Math.max(0, Math.min(1, (db - LEVEL_MIN_DB) / (LEVEL_MAX_DB - LEVEL_MIN_DB))) * 100);
}

/** Two small bars with the mark and space tone levels: both move when tuned. */
function ToneLevels({ signal }: { signal: RttySignal | null }) {
  const { t } = useTranslation('radio');
  const bars: Array<[string, number | null]> = [
    [t('rtty.tuning.mark', 'M'), signal ? signal.markDb : null],
    [t('rtty.tuning.space', 'S'), signal ? signal.spaceDb : null],
  ];
  return (
    <Tooltip content={t('rtty.receive.levelsHint', 'Mark and space levels: both bars rise when the tones sit on the signal')}>
      <div className="flex h-6 items-end gap-0.5" data-testid="rtty-tone-levels" aria-hidden="true">
        {bars.map(([label, db]) => (
          <div key={label} className="flex h-full flex-col items-center justify-end">
            <div className="relative h-4 w-1.5 overflow-hidden rounded-sm bg-default-200">
              <div
                className={`absolute inset-x-0 bottom-0 rounded-sm ${signal?.locked ? 'bg-success' : 'bg-primary'} transition-[height] duration-200`}
                style={{ height: `${db === null ? 0 : levelPercent(db)}%` }}
              />
            </div>
            <span className="text-[8px] leading-none text-default-400">{label}</span>
          </div>
        ))}
      </div>
    </Tooltip>
  );
}

/**
 * Tuning helpers in the receive header: tone levels, AFC re-centring, and the
 * REV switch with the automatic polarity state.
 */
export const RttyReceiveControls: React.FC = () => {
  const { t } = useTranslation('radio');
  const { config, decoderStatus, txStatus, updateConfig } = useRtty();
  const canConfigure = useCan('update', 'RttyDecoderConfig');
  const signal = decoderStatus?.signal ?? null;
  const scan = useRttyScan();
  if (!config) return null;
  const transmitting = txStatus?.active ?? false;
  // The scanner's centre of a signal near the tones is more accurate than the
  // AFC offset, which lags and is capped at its range; fall back to the AFC.
  const scanned = (scan?.channels ?? [])
    .filter((channel) => Math.abs(channel.centerHz - config.centerHz) <= config.shiftHz)
    .sort((a, b) => Math.abs(a.centerHz - config.centerHz) - Math.abs(b.centerHz - config.centerHz))[0];
  const offset = scanned ? scanned.centerHz - config.centerHz : (signal?.frequencyOffsetHz ?? 0);
  const canAlign = canConfigure && !transmitting && (Boolean(scanned) || config.afc) && Math.abs(offset) >= ALIGN_MIN_HZ;
  const autoReversed = !config.reverse && (signal?.reversed ?? false);

  const save = (patch: Parameters<typeof updateConfig>[0]) => {
    updateConfig(patch).catch((error: unknown) => {
      addToast({ title: t('rtty.settings.saveFailed', 'Could not change RTTY settings'), description: describeRttyError(error, t), color: 'danger' });
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <ToneLevels signal={signal} />
      {(canAlign || signal?.afcLimited) && (
        <Tooltip
          content={signal?.afcLimited
            ? t('rtty.receive.afcLimitedHint', 'The signal is too far from the tones for AFC. Re-centre, or double-click the signal on the waterfall.')
            : t('rtty.receive.alignHint', 'Move the tones onto the signal (AFC is following it {{offset}} Hz away)', { offset: Math.round(offset) })}
        >
          <Button
            size="sm"
            variant="flat"
            color={signal?.afcLimited ? 'warning' : 'default'}
            className="h-6 min-w-0 px-2 text-[11px]"
            isDisabled={!canAlign}
            onPress={() => save({ centerHz: Math.round(config.centerHz + offset) })}
            data-testid="rtty-afc-align"
          >
            {t('rtty.receive.align', 'Align {{offset}} Hz', { offset: `${offset > 0 ? '+' : ''}${Math.round(offset)}` })}
          </Button>
        </Tooltip>
      )}
      <Tooltip
        content={config.reverse
          ? t('rtty.receive.reverseOn', 'REV on: mark and space are swapped for receive and transmit')
          : autoReversed
            ? t('rtty.receive.reverseAuto', 'Receiving with reversed polarity (auto). Turn REV on to transmit reversed too.')
            : t('rtty.receive.reverseOff', 'Swap mark and space (REV)')}
      >
        <Button
          size="sm"
          variant={config.reverse ? 'solid' : 'flat'}
          color={config.reverse ? 'warning' : autoReversed ? 'secondary' : 'default'}
          className="h-6 min-w-0 px-2 text-[11px] font-semibold"
          aria-pressed={config.reverse}
          isDisabled={!canConfigure || transmitting}
          onPress={() => save({ reverse: !config.reverse })}
          data-testid="rtty-rev"
        >
          {autoReversed ? t('rtty.receive.reverseAutoLabel', 'REV (auto)') : 'REV'}
        </Button>
      </Tooltip>
    </div>
  );
};
