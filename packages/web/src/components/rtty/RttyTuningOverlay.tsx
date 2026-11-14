import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveRttyAudioTones } from '@tx5dr/contracts';
import { SpectrumDisplay } from '../radio/spectrum/SpectrumDisplay';
import type { FrequencyBandOverlayChange } from '../radio/spectrum/WebGLWaterfall';
import { useRtty, useRttyScan } from '../../hooks/useRtty';
import { useCan } from '../../store/authStore';
import { addToast } from '@heroui/toast';
import { describeRttyError } from './rttyErrors';

const OVERLAY_ID = 'rtty-tones';
const PREVIEW_THROTTLE_MS = 120;
/** A pick within a detected signal's tones (plus this margin) snaps onto its centre. */
const SNAP_MARGIN_HZ = 40;
const MIN_CENTER_HZ = 300;
const MAX_CENTER_HZ = 3000;

interface RttyTuningOverlayProps {
  height: number;
  showMarkers?: boolean;
}

function clampCenter(hz: number): number {
  return Math.round(Math.min(MAX_CENTER_HZ, Math.max(MIN_CENTER_HZ, hz)));
}

/**
 * Audio spectrum with the RTTY tone pair: a band spanning both tones with
 * mark and space lines. Dragging retunes the receiver live and saves on release.
 */
export const RttyTuningOverlay: React.FC<RttyTuningOverlayProps> = ({ height, showMarkers = true }) => {
  const { t } = useTranslation('radio');
  const { config, txStatus, previewTuning, updateConfig } = useRtty();
  // Retuning mid-transmission is refused by the server; lock the overlay instead.
  const canConfigure = useCan('update', 'RttyDecoderConfig') && !(txStatus?.active ?? false);
  const lastPreviewRef = useRef(0);
  const scan = useRttyScan();
  // Centre shown in the label while dragging, before the change is saved.
  const [dragCenter, setDragCenter] = useState<number | null>(null);
  useEffect(() => { setDragCenter(null); }, [config?.centerHz]);

  const tuneTo = useCallback((centerHz: number) => {
    const target = clampCenter(centerHz);
    updateConfig({ centerHz: target }).catch((error: unknown) => {
      addToast({ title: t('rtty.settings.saveFailed', 'Could not change RTTY settings'), description: describeRttyError(error, t), color: 'danger' });
    });
  }, [t, updateConfig]);

  const handlePick = useCallback((frequencyHz: number) => {
    const nearest = (scan?.channels ?? [])
      .map((channel) => ({ channel, distance: Math.abs(channel.centerHz - frequencyHz) }))
      .filter((item) => item.distance <= item.channel.shiftHz / 2 + SNAP_MARGIN_HZ)
      .sort((a, b) => a.distance - b.distance)[0];
    tuneTo(nearest ? nearest.channel.centerHz : frequencyHz);
  }, [scan, tuneTo]);

  const handlePreview = useCallback((_id: string, change: FrequencyBandOverlayChange) => {
    const now = Date.now();
    if (now - lastPreviewRef.current < PREVIEW_THROTTLE_MS) return;
    lastPreviewRef.current = now;
    setDragCenter(clampCenter(change.centerFrequency));
    previewTuning(clampCenter(change.centerFrequency));
  }, [previewTuning]);

  const handleCommit = useCallback((_id: string, change: FrequencyBandOverlayChange) => {
    setDragCenter(null);
    updateConfig({ centerHz: clampCenter(change.centerFrequency) }).catch((error: unknown) => {
      // Put the receiver back on the saved tones the preview moved it away from.
      if (config) previewTuning(config.centerHz);
      addToast({ title: t('rtty.settings.saveFailed', 'Could not change RTTY settings'), description: describeRttyError(error, t), color: 'danger' });
    });
  }, [config, previewTuning, t, updateConfig]);

  const overlays = useMemo(() => {
    if (!config) return [];
    // Marker offsets come from the saved tones (the band itself moves while
    // dragging); the dragged centre only updates the label.
    const tones = resolveRttyAudioTones(config);
    const labelTones = resolveRttyAudioTones({ ...config, centerHz: dragCenter ?? config.centerHz });
    const halfWidth = config.shiftHz / 2 + config.baud;
    return [{
      id: OVERLAY_ID,
      label: 'RTTY',
      centerFrequency: config.centerHz,
      rangeStartFrequency: config.centerHz - halfWidth,
      rangeEndFrequency: config.centerHz + halfWidth,
      draggable: canConfigure,
      resizable: false,
      minCenterFrequency: MIN_CENTER_HZ,
      maxCenterFrequency: MAX_CENTER_HZ,
      centerStepHz: 5,
      markers: [
        { offsetHz: tones.markHz - config.centerHz, label: t('rtty.tuning.mark', 'M'), tone: 'primary' as const },
        { offsetHz: tones.spaceHz - config.centerHz, label: t('rtty.tuning.space', 'S'), tone: 'secondary' as const },
      ],
      description: t('rtty.tuning.description', 'Mark {{mark}} Hz · Space {{space}} Hz', {
        mark: Math.round(labelTones.markHz),
        space: Math.round(labelTones.spaceHz),
      }),
    }, ...(scan?.channels ?? [])
      // Other signals found by the signal browser (the tuned one is the main band).
      .filter((channel) => Math.abs(channel.centerHz - config.centerHz) > config.shiftHz / 2)
      .map((channel) => ({
        id: `rtty-signal-${channel.id}`,
        label: `${Math.round(channel.centerHz)}`,
        centerFrequency: channel.centerHz,
        rangeStartFrequency: channel.centerHz - channel.shiftHz / 2,
        rangeEndFrequency: channel.centerHz + channel.shiftHz / 2,
        draggable: false,
        resizable: false,
        description: channel.preview ? channel.preview.slice(-32) : undefined,
      }))];
  }, [canConfigure, config, dragCenter, scan, t]);

  // The spectrum is large and not memoised itself; RTTY status updates arrive
  // several times a second, so only rebuild it when its inputs change.
  return useMemo(() => (
    <SpectrumDisplay
      height={height}
      showMarkers={showMarkers}
      frequencyBandOverlays={overlays}
      onFrequencyBandOverlayPreviewChange={canConfigure ? handlePreview : undefined}
      onFrequencyBandOverlayCommit={canConfigure ? handleCommit : undefined}
      onAudioFrequencyPick={canConfigure ? handlePick : undefined}
    />
  ), [canConfigure, handleCommit, handlePick, handlePreview, height, overlays, showMarkers]);
};
