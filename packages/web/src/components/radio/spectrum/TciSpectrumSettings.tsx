import React, { useEffect, useState } from 'react';
import { Slider } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CapabilityDescriptor, CapabilityState, TciSpectrumSettings } from '@tx5dr/contracts';
import { EnumCapabilityPanel } from '../../../radio-capability/components/EnumCapability';

export interface TciSpectrumSettingsProps {
  settings: TciSpectrumSettings;
  pending?: boolean;
  canWrite: boolean;
  sampleRateState?: CapabilityState;
  sampleRateDescriptor?: CapabilityDescriptor;
  onCapabilityWrite?: (id: string, value?: boolean | number | string, action?: boolean) => void;
  onChange: (settings: TciSpectrumSettings) => void;
}

export const TciSpectrumSettingsPanel: React.FC<TciSpectrumSettingsProps> = ({
  settings,
  pending = false,
  canWrite,
  sampleRateState,
  sampleRateDescriptor,
  onCapabilityWrite,
  onChange,
}) => {
  const { t } = useTranslation('radio');
  const [draft, setDraft] = useState(settings);
  const fftOptions = [4096, 8192, 16384, 32768, 65536] as const;
  const fftIndex = Math.max(0, fftOptions.indexOf(draft.fftSize));
  useEffect(() => setDraft(settings), [settings]);
  const update = (partial: Partial<TciSpectrumSettings>) => setDraft(current => ({ ...current, ...partial }));
  const commit = () => onChange(draft);

  return (
    <div className="space-y-3 rounded-lg bg-default-100/50 px-2 py-2 dark:bg-default-50/10">
      <div>
        <div className="text-sm font-medium text-default-700">{t('spectrum.tciSettings.title')}</div>
        <div className="text-[11px] leading-tight text-default-400">{t('spectrum.tciSettings.description')}</div>
      </div>
      <Slider
        label={t('spectrum.tciSettings.fftSize')}
        minValue={0}
        maxValue={fftOptions.length - 1}
        step={1}
        value={fftIndex}
        isDisabled={!canWrite || pending}
        onChange={(value) => update({ fftSize: fftOptions[Math.round(Number(value))] ?? 65536 })}
        onChangeEnd={commit}
        getValue={(value) => `${fftOptions[Math.round(Number(value))] ?? 65536}`}
        showTooltip
      />
      <Slider
        label={t('spectrum.tciSettings.displayBins')}
        minValue={1024}
        maxValue={16384}
        step={256}
        value={draft.displayBinCount}
        isDisabled={!canWrite || pending}
        onChange={(value) => update({ displayBinCount: Number(value) })}
        onChangeEnd={commit}
        getValue={(value) => `${Number(value).toLocaleString()}`}
        showTooltip
      />
      <Slider
        label={t('spectrum.tciSettings.refreshInterval')}
        minValue={20}
        maxValue={1000}
        step={10}
        value={draft.analysisIntervalMs}
        isDisabled={!canWrite || pending}
        onChange={(value) => update({ analysisIntervalMs: Number(value) })}
        onChangeEnd={commit}
        getValue={(value) => `${value} ms`}
        showTooltip
      />
      {sampleRateState?.supported && sampleRateDescriptor && onCapabilityWrite && (
        <EnumCapabilityPanel
          capabilityId="tci_iq_sample_rate"
          state={sampleRateState}
          descriptor={sampleRateDescriptor}
          onWrite={onCapabilityWrite}
        />
      )}
    </div>
  );
};
