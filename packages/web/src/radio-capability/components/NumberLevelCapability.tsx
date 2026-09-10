import { useCallback, useState } from 'react';
import { Button, ButtonGroup, Input, Slider, Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CapabilityComponentProps } from '../control-types';
import { capabilityShortLabel } from '../control-presentation';
import { formatCapabilityNumber } from '../display-utils';
import { useNumberControl } from '../useNumberControl';
import { canUseRfPowerDiscreteMode, findDiscreteOptionIndex, getDiscreteNumberOptions, getDiscreteOptionDisplayText, inputStep,
  numberInputWidth, shouldUseDiscreteSlider, toInputNumber, type RfPowerInteractionMode } from '../control-values';

export { canUseRfPowerDiscreteMode, findDiscreteOptionIndex, getDiscreteNumberOptions, getDiscreteOptionDisplayText, shouldUseDiscreteSlider } from '../control-values';

export function NumberLevelCapability({ descriptor, capabilityId, state, interactive, scope, onWrite, draftEditor, showSliderInput = true, tooltipContent }: CapabilityComponentProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<RfPowerInteractionMode>('percent');
  const [sliderHovered, setSliderHovered] = useState(false);
  const [sliderFocused, setSliderFocused] = useState(false);
  const options = getDiscreteNumberOptions(descriptor);
  const limits = descriptor.range ?? descriptor.limits;
  const range = descriptor.range;
  const hasRange = Boolean(range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max > range.min);
  const usesSlider = !draftEditor && hasRange;
  const discrete = shouldUseDiscreteSlider(capabilityId, usesSlider, options, mode)
    || (!usesSlider && options.length > 0 && capabilityId !== 'rf_power');
  const write = useCallback((value: number) => onWrite(capabilityId, value), [capabilityId, onWrite]);
  const edit = useNumberControl({ descriptor, state, enabled: interactive && !draftEditor, scope, discrete, onWrite: write });
  const label = capabilityShortLabel(descriptor, t);
  const actualText = state?.value == null ? '—' : formatCapabilityNumber(Number(state.value), descriptor);
  const detailsTooltip = { content: tooltipContent, delay: 350, closeDelay: 0, size: 'sm' as const, classNames: { content: 'max-w-[300px] text-xs' } };
  if (!descriptor.writable) return <Tooltip {...detailsTooltip}><span className="cap-item"><span className="cap-label text-default-500">{label}</span><span className="cap-number-label">{actualText}</span></span></Tooltip>;
  const min = limits?.min == null ? undefined : toInputNumber(limits.min, descriptor);
  const max = limits?.max == null ? undefined : toInputNumber(limits.max, descriptor);
  const inverted = descriptor.display?.mode !== 'percent' && (descriptor.display?.transform?.scale ?? 1) < 0;
  const formatZero = formatCapabilityNumber(0, descriptor);
  const unit = formatZero.replace(formatCapabilityNumber(0, descriptor, false), '').trim();
  const showModes = canUseRfPowerDiscreteMode(capabilityId, options) && !draftEditor;
  const sliderValue = edit.displayValue ?? range?.min ?? 0;
  const selectedOption = discrete && edit.displayValue !== null ? getDiscreteOptionDisplayText(options, descriptor, edit.displayValue, key => t(key)) : null;
  const showInput = !usesSlider || showSliderInput;
  const sliderValueText = edit.displayValue === null ? '—' : selectedOption ?? formatCapabilityNumber(edit.displayValue, descriptor);
  const labelElement = <span className="cap-label text-default-500">{label}</span>;
  return <Tooltip {...detailsTooltip} isDisabled={!showInput}><span className="cap-item">
    {showInput ? labelElement : <Tooltip {...detailsTooltip}>{labelElement}</Tooltip>}
    {showModes && <ButtonGroup size="sm" className="gap-px" aria-label={t('radio:capability.rf_power.label')}>
      {(['percent', 'hamlib-discrete'] as const).map(value => <Tooltip key={value} content={t(`radio:capability.rf_power.modes.${value === 'percent' ? 'percent' : 'hamlib'}`)}>
        <Button className="cap-button cap-segment cap-value-toggle" variant="flat" color={mode === value ? 'primary' : 'default'} aria-pressed={mode === value}
          isDisabled={!interactive} onPress={() => { edit.cancel(); setMode(value); }}>{value === 'percent' ? '%' : t('radio:capability.quick.steps')}</Button>
      </Tooltip>)}
    </ButtonGroup>}
    {usesSlider && range && <Slider size="sm" aria-label={t(descriptor.labelI18nKey)}
      minValue={discrete ? 0 : range.min} maxValue={discrete ? options.length - 1 : range.max} step={discrete ? 1 : range.step ?? 0.01}
      value={discrete ? findDiscreteOptionIndex(options, edit.displayValue) : sliderValue}
      isDisabled={!interactive || (descriptor.readable && edit.actual === null)}
      showTooltip={!showInput}
      tooltipProps={{ content: sliderValueText, size: 'sm', delay: 0, closeDelay: 0, classNames: { content: 'text-xs tabular-nums' },
        isOpen: sliderHovered || sliderFocused ? true : undefined }}
      onMouseEnter={() => setSliderHovered(true)} onMouseLeave={() => setSliderHovered(false)}
      onFocus={event => setSliderFocused(event.target.matches(':focus-visible'))} onBlur={() => setSliderFocused(false)}
      classNames={{ base: 'cap-slider', track: 'cap-slider-track', thumb: 'cap-slider-thumb bg-primary after:bg-primary' }}
      onChange={value => { const number = Array.isArray(value) ? value[0] : value; edit.slide(discrete ? options[Math.round(number)]?.value ?? range.min : number); }}
      onChangeEnd={edit.endSlide} />}
    {showInput && <>
    <Input size="sm" type="number" aria-label={t(descriptor.labelI18nKey)} value={draftEditor?.text ?? edit.input} placeholder="—"
      classNames={{ base: 'cap-input', inputWrapper: 'cap-input-wrapper', input: 'cap-input-field' }}
      style={{ width: numberInputWidth(descriptor, edit.actual) }}
      min={inverted ? max : min} max={inverted ? min : max} step={inputStep(descriptor)}
      onValueChange={draftEditor?.onChange ?? edit.edit} onBlur={draftEditor ? undefined : edit.commit} isDisabled={!interactive}
      onKeyDown={event => {
        if (draftEditor) return;
        if (event.key === 'Enter') { event.preventDefault(); edit.commit(); }
        if (event.key === 'Escape') { event.preventDefault(); edit.cancel(); }
      }} />
    {unit && <span className="cap-number-label text-default-500">{unit}</span>}
    {selectedOption && <span className="cap-number-label text-default-500">{selectedOption}</span>}
    </>}
    {!descriptor.readable && state?.meta?.acknowledgement === 'sent' && <span className="text-[11px] text-default-500">{t('radio:capability.panel.sent')}</span>}
  </span></Tooltip>;
}
