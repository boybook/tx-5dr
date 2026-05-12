import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SpectrumDisplay } from '../radio/spectrum/SpectrumDisplay';
import type { FrequencyBandOverlayChange } from '../radio/spectrum/WebGLWaterfall';
import { useCWDecoder } from '../../hooks/useCWDecoder';
import { useCan } from '../../store/authStore';
import {
  CW_DECODER_FILTER_MAX_WIDTH_HZ,
  CW_DECODER_FILTER_MIN_WIDTH_HZ,
  CW_DECODER_FILTER_WIDTH_TUNING_STEP_HZ,
  CW_DECODER_TARGET_MAX_HZ,
  CW_DECODER_TARGET_MIN_HZ,
  CW_DECODER_TARGET_TUNING_STEP_HZ,
  clampCWDecoderFilterWidth,
  clampCWDecoderTargetFreq,
} from '../../utils/cwDecoderTuning';

interface CWSpectrumFilterOverlayProps {
  height: number;
  showMarkers?: boolean;
}

const CW_FILTER_OVERLAY_ID = 'cw-decoder-filter';
const RUNTIME_TUNING_THROTTLE_MS = 120;

type TuningPatch = {
  targetFreqHz: number;
  filterWidthHz: number;
};

function normalizeChange(change: FrequencyBandOverlayChange): TuningPatch {
  return {
    targetFreqHz: clampCWDecoderTargetFreq(change.centerFrequency),
    filterWidthHz: clampCWDecoderFilterWidth(change.widthHz),
  };
}

export const CWSpectrumFilterOverlay: React.FC<CWSpectrumFilterOverlayProps> = ({
  height,
  showMarkers = false,
}) => {
  const { t } = useTranslation('radio');
  const { config, status, tuneRuntime, updateConfig } = useCWDecoder();
  const canConfigureDecoder = useCan('update', 'CWDecoderConfig');
  const pendingRuntimePatchRef = useRef<TuningPatch | null>(null);
  const runtimeTuningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const targetFreqHz = clampCWDecoderTargetFreq(typeof config?.targetFreqHz === 'number' ? config.targetFreqHz : 800);
  const filterWidthHz = clampCWDecoderFilterWidth(typeof config?.filterWidthHz === 'number' ? config.filterWidthHz : 800);
  const decoderVisible = status.state === 'starting' || status.state === 'running' || status.running;

  useEffect(() => () => {
    if (runtimeTuningTimerRef.current) {
      clearTimeout(runtimeTuningTimerRef.current);
    }
  }, []);

  const flushRuntimeTuning = useCallback(() => {
    if (runtimeTuningTimerRef.current) {
      clearTimeout(runtimeTuningTimerRef.current);
      runtimeTuningTimerRef.current = null;
    }
    const patch = pendingRuntimePatchRef.current;
    pendingRuntimePatchRef.current = null;
    if (patch) {
      void tuneRuntime(patch);
    }
  }, [tuneRuntime]);

  const scheduleRuntimeTuning = useCallback((patch: TuningPatch) => {
    if (!canConfigureDecoder) return;
    pendingRuntimePatchRef.current = patch;
    if (runtimeTuningTimerRef.current) return;
    runtimeTuningTimerRef.current = setTimeout(flushRuntimeTuning, RUNTIME_TUNING_THROTTLE_MS);
  }, [canConfigureDecoder, flushRuntimeTuning]);

  const handlePreview = useCallback((_id: string, change: FrequencyBandOverlayChange) => {
    scheduleRuntimeTuning(normalizeChange(change));
  }, [scheduleRuntimeTuning]);

  const handleCommit = useCallback((_id: string, change: FrequencyBandOverlayChange) => {
    if (!canConfigureDecoder) return;
    const patch = normalizeChange(change);
    pendingRuntimePatchRef.current = patch;
    flushRuntimeTuning();
    void updateConfig(patch);
  }, [canConfigureDecoder, flushRuntimeTuning, updateConfig]);

  const frequencyBandOverlays = useMemo(() => {
    if (!decoderVisible) return [];
    const start = targetFreqHz - filterWidthHz / 2;
    const end = targetFreqHz + filterWidthHz / 2;
    return [{
      id: CW_FILTER_OVERLAY_ID,
      label: t('cw.decoder.filterOverlayLabel', 'CW filter'),
      centerFrequency: targetFreqHz,
      rangeStartFrequency: start,
      rangeEndFrequency: end,
      draggable: canConfigureDecoder,
      resizable: canConfigureDecoder,
      minCenterFrequency: CW_DECODER_TARGET_MIN_HZ,
      maxCenterFrequency: CW_DECODER_TARGET_MAX_HZ,
      minWidthHz: CW_DECODER_FILTER_MIN_WIDTH_HZ,
      maxWidthHz: CW_DECODER_FILTER_MAX_WIDTH_HZ,
      centerStepHz: CW_DECODER_TARGET_TUNING_STEP_HZ,
      widthStepHz: CW_DECODER_FILTER_WIDTH_TUNING_STEP_HZ,
      description: t('cw.decoder.filterOverlayDescription', '{{target}} Hz · {{width}} Hz audio filter', {
        target: targetFreqHz,
        width: filterWidthHz,
      }),
    }];
  }, [canConfigureDecoder, decoderVisible, filterWidthHz, t, targetFreqHz]);

  return (
    <SpectrumDisplay
      height={height}
      showMarkers={showMarkers}
      frequencyBandOverlays={frequencyBandOverlays}
      onFrequencyBandOverlayPreviewChange={canConfigureDecoder ? handlePreview : undefined}
      onFrequencyBandOverlayCommit={canConfigureDecoder ? handleCommit : undefined}
    />
  );
};
