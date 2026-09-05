import React, { useMemo } from 'react';
import { Input, Select, SelectItem, Switch, Tab, Tabs } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type {
  SpectrumCustomSettings,
  SpectrumPreset,
  SpectrumRenderConfig,
  SpectrumWindowFunction,
} from '@tx5dr/contracts';

const FFT_SIZES = [1024, 2048, 4096, 8192, 16384] as const;
const TARGET_SAMPLE_RATES = [3000, 4000, 6000, 8000, 12000] as const;
const WINDOW_FUNCTIONS: SpectrumWindowFunction[] = ['blackmanHarris', 'hann', 'hamming', 'blackman', 'none'];

export interface SpectrumAnalysisSettingsProps {
  config: SpectrumRenderConfig | null;
  enabled: boolean;
  pending?: boolean;
  customDraft: SpectrumCustomSettings;
  customEditing: boolean;
  onPresetChange: (preset: Exclude<SpectrumPreset, 'custom'>) => void;
  onCustomEditingChange: (editing: boolean) => void;
  onCustomDraftChange: (settings: SpectrumCustomSettings) => void;
}

export function deriveSpectrumCustomSettings(config: SpectrumRenderConfig | null): SpectrumCustomSettings {
  const custom = config?.customSettings;
  if (custom) {
    return { ...custom };
  }

  return {
    analysisIntervalMs: Math.round(config?.analysisIntervalMs ?? 150),
    fftSize: (FFT_SIZES.includes(config?.fftSize as typeof FFT_SIZES[number])
      ? config?.fftSize
      : 8192) as SpectrumCustomSettings['fftSize'],
    targetSampleRate: (TARGET_SAMPLE_RATES.includes(config?.targetSampleRate as typeof TARGET_SAMPLE_RATES[number])
      ? config?.targetSampleRate
      : 6000) as SpectrumCustomSettings['targetSampleRate'],
    windowFunction: config?.windowFunction ?? 'blackmanHarris',
    haloReduce: config?.haloReduce ?? false,
  };
}

function formatResolution(value: number): string {
  return value >= 1 ? `${value.toFixed(2)} Hz/bin` : `${value.toFixed(3)} Hz/bin`;
}

export const SpectrumAnalysisSettings: React.FC<SpectrumAnalysisSettingsProps> = ({
  config,
  enabled,
  pending = false,
  customDraft,
  customEditing,
  onPresetChange,
  onCustomEditingChange,
  onCustomDraftChange,
}) => {
  const { t } = useTranslation('common');

  const derived = useMemo(() => ({
    frameRateHz: 1000 / customDraft.analysisIntervalMs,
    windowMs: (customDraft.fftSize / customDraft.targetSampleRate) * 1000,
    resolutionHz: customDraft.targetSampleRate / customDraft.fftSize,
    bins: customDraft.fftSize / 2 + 1,
    maxFrequencyHz: customDraft.targetSampleRate / 2,
  }), [customDraft]);

  const selectedKey = customEditing || config?.preset === 'custom' ? 'custom' : (config?.preset ?? 'balanced');

  const updateDraft = <K extends keyof SpectrumCustomSettings>(key: K, value: SpectrumCustomSettings[K]) => {
    onCustomDraftChange({ ...customDraft, [key]: value });
  };

  const handleSelectionChange = (key: React.Key) => {
    if (key === 'custom') {
      onCustomEditingChange(true);
      return;
    }
    onCustomEditingChange(false);
    onPresetChange(key as Exclude<SpectrumPreset, 'custom'>);
  };

  return (
    <section className="space-y-3 rounded-lg bg-default-100/50 px-2 py-2 dark:bg-default-50/10">
      <div>
        <div className="text-xs font-medium text-default-700">{t('spectrum.analysisPreset')}</div>
        <div className="text-[11px] leading-tight text-default-400">
          {t('spectrum.analysisPresetDescription')}
        </div>
      </div>
      <Tabs
        selectedKey={selectedKey}
        isDisabled={!enabled || pending}
        onSelectionChange={handleSelectionChange}
        fullWidth
        size="sm"
        classNames={{
          base: 'w-full',
          tabList: 'w-full',
          cursor: 'w-full',
          tab: 'w-full',
        }}
      >
        <Tab key="responsive" title={t('spectrum.analysisPresetResponsive')} />
        <Tab key="balanced" title={t('spectrum.analysisPresetBalanced')} />
        <Tab key="block" title={t('spectrum.analysisPresetBlock')} />
        <Tab key="fine" title={t('spectrum.analysisPresetFine')} />
        <Tab key="custom" title={t('spectrum.analysisPresetCustom')} />
      </Tabs>

      <div className="text-[11px] tabular-nums text-default-500">
        {t('spectrum.analysisPresetSummary', {
          interval: customDraft.analysisIntervalMs,
          frameRate: derived.frameRateHz.toFixed(2),
          fft: customDraft.fftSize,
          resolution: formatResolution(derived.resolutionHz),
        })}
      </div>

      {customEditing && (
        <div className="space-y-3 rounded-lg bg-default-50/40 px-2 py-2">
          <Input
            label={t('spectrum.customRefreshInterval')}
            type="number"
            min={50}
            max={1000}
            step={10}
            size="sm"
            value={String(customDraft.analysisIntervalMs)}
            onValueChange={(value) => {
              const next = Math.max(50, Math.min(1000, Math.round(Number(value) || 50)));
                updateDraft('analysisIntervalMs', next);
            }}
            endContent={<span className="text-xs text-default-400">ms</span>}
          />
          <Select
            label={t('spectrum.customFftSize')}
            size="sm"
            selectedKeys={[String(customDraft.fftSize)]}
            onSelectionChange={(keys) => {
              const next = Number(Array.from(keys)[0]);
              if (FFT_SIZES.includes(next as typeof FFT_SIZES[number])) {
                updateDraft('fftSize', next as SpectrumCustomSettings['fftSize']);
              }
            }}
          >
            {FFT_SIZES.map((size) => <SelectItem key={String(size)}>{String(size)}</SelectItem>)}
          </Select>
          <Select
            label={t('spectrum.customSampleRate')}
            size="sm"
            selectedKeys={[String(customDraft.targetSampleRate)]}
            onSelectionChange={(keys) => {
              const next = Number(Array.from(keys)[0]);
              if (TARGET_SAMPLE_RATES.includes(next as typeof TARGET_SAMPLE_RATES[number])) {
                updateDraft('targetSampleRate', next as SpectrumCustomSettings['targetSampleRate']);
              }
            }}
          >
            {TARGET_SAMPLE_RATES.map((rate) => <SelectItem key={String(rate)}>{`${rate} Hz`}</SelectItem>)}
          </Select>
          <Select
            label={t('spectrum.customWindowFunction')}
            size="sm"
            selectedKeys={[customDraft.windowFunction]}
            onSelectionChange={(keys) => {
              const next = String(Array.from(keys)[0]) as SpectrumWindowFunction;
              if (WINDOW_FUNCTIONS.includes(next)) {
                updateDraft('windowFunction', next);
              }
            }}
          >
            {WINDOW_FUNCTIONS.map((windowFunction) => (
              <SelectItem key={windowFunction}>{t(`spectrum.windowFunctions.${windowFunction}`)}</SelectItem>
            ))}
          </Select>
          <Switch
            size="sm"
            isSelected={customDraft.haloReduce}
            onValueChange={(value) => updateDraft('haloReduce', value)}
          >
            {t('spectrum.customBaselineFlatten')}
          </Switch>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-default-50/40 px-2 py-2 text-[11px] text-default-500">
            <span>{t('spectrum.customTimeWindow')}</span><span className="text-right tabular-nums">{derived.windowMs.toFixed(1)} ms</span>
            <span>{t('spectrum.customResolution')}</span><span className="text-right tabular-nums">{formatResolution(derived.resolutionHz)}</span>
            <span>{t('spectrum.customFrequencyRange')}</span><span className="text-right tabular-nums">0 - {derived.maxFrequencyHz} Hz</span>
            <span>{t('spectrum.customDisplayBins')}</span><span className="text-right tabular-nums">{derived.bins}</span>
          </div>

        </div>
      )}
    </section>
  );
};
