import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
} from '@heroui/react';
import { getBandFromFrequency } from '@tx5dr/core';
import type { PresetFrequency } from '@tx5dr/contracts';
import {
  CTCSS_TONE_TENTHS_HZ_OPTIONS,
  DCS_CODE_OPTIONS,
  formatCtcssTone,
  formatDcsCode,
} from '../../utils/toneSquelch';
import { FALLBACK_VOICE_RADIO_MODES, normalizeVoiceRadioMode } from '../../utils/voiceRadioModeOptions';
import { formatFrequencyMHz, parseFrequencyMHzToHz } from '../../utils/frequencyMHz';

const MODE_OPTIONS = ['FT8', 'FT4', 'VOICE', 'SSTV', 'FAX'];
const REPEATER_SHIFT_OPTIONS = ['none', 'minus', 'plus'] as const;
const TONE_SQUELCH_OPTIONS = ['none', 'ctcss', 'dcs'] as const;
const CUSTOM_BAND = 'custom';
type RepeaterShiftOption = (typeof REPEATER_SHIFT_OPTIONS)[number];
type ToneSquelchOption = (typeof TONE_SQUELCH_OPTIONS)[number];

interface FrequencyPresetAddModalProps {
  isOpen: boolean;
  presets: PresetFrequency[];
  initialMode?: string;
  initialRadioMode?: string;
  voiceRadioModeOptions?: string[];
  initialFrequencyHz?: number;
  editingPreset?: PresetFrequency | null;
  onClose: () => void;
  onAdd: (preset: PresetFrequency, previousPreset?: PresetFrequency | null) => void | Promise<void>;
  onDelete?: (preset: PresetFrequency) => void | Promise<void>;
}

export const FrequencyPresetAddModal: React.FC<FrequencyPresetAddModalProps> = ({
  isOpen,
  presets,
  initialMode = 'FT8',
  initialRadioMode = 'USB',
  voiceRadioModeOptions = [...FALLBACK_VOICE_RADIO_MODES],
  initialFrequencyHz,
  editingPreset,
  onClose,
  onAdd,
  onDelete,
}) => {
  const { t } = useTranslation();
  const [newMode, setNewMode] = useState(initialMode);
  const [newRadioMode, setNewRadioMode] = useState(initialRadioMode);
  const [newFreqMHz, setNewFreqMHz] = useState('');
  const [newRepeaterShift, setNewRepeaterShift] = useState<RepeaterShiftOption>('none');
  const [newRepeaterOffsetKHz, setNewRepeaterOffsetKHz] = useState('');
  const [newToneMode, setNewToneMode] = useState<ToneSquelchOption>('none');
  const [newCtcssToneTenthsHz, setNewCtcssToneTenthsHz] = useState('');
  const [newDcsCode, setNewDcsCode] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [addError, setAddError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setNewMode(editingPreset?.mode ?? initialMode);
    setNewRadioMode(editingPreset?.radioMode ?? initialRadioMode);
    setNewFreqMHz(
      editingPreset?.frequency
        ? formatFrequencyMHz(editingPreset.frequency)
        : initialFrequencyHz
          ? formatFrequencyMHz(initialFrequencyHz)
          : '',
    );
    setNewRepeaterShift((editingPreset?.repeaterShift ?? 'none') as RepeaterShiftOption);
    setNewRepeaterOffsetKHz(
      editingPreset?.repeaterOffsetHz
        ? String(editingPreset.repeaterOffsetHz / 1_000)
        : '',
    );
    setNewToneMode((editingPreset?.toneMode ?? 'none') as ToneSquelchOption);
    setNewCtcssToneTenthsHz(
      editingPreset?.ctcssToneTenthsHz ? String(editingPreset.ctcssToneTenthsHz) : '',
    );
    setNewDcsCode(
      editingPreset?.dcsCode ? String(editingPreset.dcsCode) : '',
    );
    setNewDescription(editingPreset?.description ?? '');
    setAddError('');
    setIsSubmitting(false);
    setIsDeleting(false);
  }, [editingPreset, initialFrequencyHz, initialMode, initialRadioMode, isOpen]);

  const inferredBand = useMemo(() => {
    const frequencyHz = parseFrequencyMHzToHz(newFreqMHz);
    if (frequencyHz === null) {
      return null;
    }
    const band = getBandFromFrequency(frequencyHz);
    return band && band !== 'Unknown' ? band : null;
  }, [newFreqMHz]);
  const hasValidFrequencyInput = useMemo(() => {
    return parseFrequencyMHzToHz(newFreqMHz) !== null;
  }, [newFreqMHz]);
  const bandLabel = useMemo(
    () => inferredBand ?? (hasValidFrequencyInput ? t('freqPresets.customBand') : t('freqPresets.bandAutoPending')),
    [hasValidFrequencyInput, inferredBand, t],
  );
  const radioModeOptions = useMemo(() => {
    const normalizedModes = voiceRadioModeOptions
      .map(normalizeVoiceRadioMode)
      .filter((mode): mode is string => Boolean(mode));
    return normalizedModes.length > 0 ? Array.from(new Set(normalizedModes)) : [...FALLBACK_VOICE_RADIO_MODES];
  }, [voiceRadioModeOptions]);
  const supportsFmOptions = newMode === 'VOICE' && newRadioMode === 'FM';

  const clearFmOptions = () => {
    setNewRepeaterShift('none');
    setNewRepeaterOffsetKHz('');
    setNewToneMode('none');
    setNewCtcssToneTenthsHz('');
    setNewDcsCode('');
  };

  const handleAdd = async () => {
    setAddError('');
    const frequencyHz = parseFrequencyMHzToHz(newFreqMHz);
    if (frequencyHz === null) {
      setAddError(t('freqPresets.invalidFrequency'));
      return;
    }
    const freqValue = frequencyHz / 1_000_000;
    if (freqValue < 0.1 || freqValue > 1000) {
      setAddError(t('freqPresets.frequencyRange'));
      return;
    }

    let repeaterOffsetHz: number | undefined;
    let ctcssToneTenthsHz: number | undefined;
    let dcsCode: number | undefined;
    if (supportsFmOptions && newRepeaterShift !== 'none') {
      const offsetKHz = parseFloat(newRepeaterOffsetKHz);
      if (!Number.isFinite(offsetKHz) || offsetKHz <= 0) {
        setAddError(t('freqPresets.invalidRepeaterOffset'));
        return;
      }
      repeaterOffsetHz = Math.round(offsetKHz * 1_000);
    }
    if (supportsFmOptions && newToneMode === 'ctcss') {
      ctcssToneTenthsHz = Number(newCtcssToneTenthsHz);
      if (!Number.isInteger(ctcssToneTenthsHz) || ctcssToneTenthsHz <= 0) {
        setAddError(t('freqPresets.invalidCtcssTone'));
        return;
      }
    }
    if (supportsFmOptions && newToneMode === 'dcs') {
      dcsCode = Number(newDcsCode);
      if (!Number.isInteger(dcsCode) || dcsCode <= 0) {
        setAddError(t('freqPresets.invalidDcsCode'));
        return;
      }
    }

    const band = getBandFromFrequency(frequencyHz);
    const normalizedBand = band && band !== 'Unknown' ? band : CUSTOM_BAND;

    const isCurrentPreset = (preset: PresetFrequency) => Boolean(
      editingPreset
      && preset.mode === editingPreset.mode
      && preset.frequency === editingPreset.frequency
    );
    if (presets.some(p => p.mode === newMode && p.frequency === frequencyHz && !isCurrentPreset(p))) {
      setAddError(t('freqPresets.duplicate'));
      return;
    }

    const displayBand = normalizedBand === CUSTOM_BAND ? t('freqPresets.customBand') : normalizedBand;
    const description = newDescription.trim() || `${formatFrequencyMHz(frequencyHz)} MHz ${displayBand}`;
    const preserveModeMetadata = editingPreset?.mode === newMode;
    const assignedOffsetHz = preserveModeMetadata && editingPreset.assignedFrequency !== undefined
      ? editingPreset.assignedFrequency - editingPreset.frequency
      : null;
    const legacyCarrierOffsetHz = preserveModeMetadata && editingPreset.carrierFrequency !== undefined
      ? editingPreset.carrierFrequency - editingPreset.frequency
      : null;
    const newPreset: PresetFrequency = {
      band: normalizedBand,
      mode: newMode,
      radioMode: newRadioMode,
      frequency: frequencyHz,
      description,
      ...(preserveModeMetadata && editingPreset.region ? { region: editingPreset.region } : {}),
      ...(preserveModeMetadata && editingPreset.imagePurpose ? { imagePurpose: editingPreset.imagePurpose } : {}),
      ...(preserveModeMetadata && editingPreset.audioCenterHz ? { audioCenterHz: editingPreset.audioCenterHz } : {}),
      ...(preserveModeMetadata && editingPreset.faxEmission ? { faxEmission: editingPreset.faxEmission } : {}),
      ...(assignedOffsetHz !== null ? { assignedFrequency: frequencyHz + assignedOffsetHz } : {}),
      ...(legacyCarrierOffsetHz !== null ? { carrierFrequency: frequencyHz + legacyCarrierOffsetHz } : {}),
      ...(supportsFmOptions && newRepeaterShift !== 'none'
        ? { repeaterShift: newRepeaterShift, repeaterOffsetHz }
        : {}),
      ...(supportsFmOptions && newToneMode === 'ctcss'
        ? { toneMode: 'ctcss' as const, ctcssToneTenthsHz }
        : {}),
      ...(supportsFmOptions && newToneMode === 'dcs'
        ? { toneMode: 'dcs' as const, dcsCode }
        : {}),
    };

    setIsSubmitting(true);
    try {
      await onAdd(newPreset, editingPreset);
      onClose();
    } catch {
      setAddError(t('freqPresets.saveFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!editingPreset || !onDelete || presets.length <= 1) return;

    setAddError('');
    setIsDeleting(true);
    try {
      await onDelete(editingPreset);
      onClose();
    } catch {
      setAddError(t('freqPresets.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md"
      placement="center"
      scrollBehavior="inside"
    >
      <ModalContent>
        <ModalHeader>{editingPreset ? t('freqPresets.editTitle') : t('freqPresets.addTitle')}</ModalHeader>
        <ModalBody>
          <div className="flex gap-3">
            <Input
              label={t('freqPresets.band')}
              value={bandLabel}
              description={hasValidFrequencyInput && !inferredBand ? t('freqPresets.unknownBand') : undefined}
              color={hasValidFrequencyInput && !inferredBand ? 'warning' : 'default'}
              isReadOnly
              className="flex-1"
            />
            <Select
              label={t('freqPresets.mode')}
              selectedKeys={[newMode]}
              onSelectionChange={(keys) => {
                const val = Array.from(keys)[0] as string;
                if (val) {
                  setNewMode(val);
                  if (val !== 'VOICE' || newRadioMode !== 'FM') {
                    clearFmOptions();
                  }
                }
              }}
              className="flex-1"
            >
              {MODE_OPTIONS.map(mode => (
                <SelectItem key={mode} textValue={mode}>{mode}</SelectItem>
              ))}
            </Select>
            <Select
              label={t('freqPresets.radioMode')}
              selectedKeys={[newRadioMode]}
              onSelectionChange={(keys) => {
                const val = Array.from(keys)[0] as string;
                if (val) {
                  setNewRadioMode(val);
                  if (newMode !== 'VOICE' || val !== 'FM') {
                    clearFmOptions();
                  }
                }
              }}
              className="flex-1"
            >
              {radioModeOptions.map(mode => (
                <SelectItem key={mode} textValue={mode}>{mode}</SelectItem>
              ))}
            </Select>
          </div>
          <Input
            label={t('freqPresets.frequencyMHz')}
            placeholder={t('freqPresets.freqPlaceholder')}
            value={newFreqMHz}
            onValueChange={(value) => {
              setNewFreqMHz(value);
              if (addError) setAddError('');
            }}
            type="number"
            inputMode="decimal"
            step="0.000001"
            description={t('freqPresets.frequencyRange')}
            isInvalid={!!addError}
            errorMessage={addError}
          />
          {supportsFmOptions && (
            <div className="flex gap-3">
              <Select
                label={t('freqPresets.repeaterShift')}
                selectedKeys={[newRepeaterShift]}
                onSelectionChange={(keys) => {
                  const val = Array.from(keys)[0] as RepeaterShiftOption;
                  if (val) {
                    setNewRepeaterShift(val);
                    if (addError) setAddError('');
                  }
                }}
                className="flex-1"
              >
                {REPEATER_SHIFT_OPTIONS.map(shift => (
                  <SelectItem key={shift} textValue={t(`freqPresets.repeaterShiftOptions.${shift}`)}>
                    {t(`freqPresets.repeaterShiftOptions.${shift}`)}
                  </SelectItem>
                ))}
              </Select>
              <Input
                label={t('freqPresets.repeaterOffsetKHz')}
                placeholder={t('freqPresets.repeaterOffsetPlaceholder')}
                value={newRepeaterOffsetKHz}
                onValueChange={(value) => {
                  setNewRepeaterOffsetKHz(value);
                  if (addError) setAddError('');
                }}
                type="number"
                step="0.1"
                min="0"
                isDisabled={newRepeaterShift === 'none'}
                description={newRepeaterShift === 'none' ? t('freqPresets.repeaterOffsetDisabled') : undefined}
                className="flex-1"
              />
            </div>
          )}
          {supportsFmOptions && (
            <div className="flex gap-3">
              <Select
                label={t('freqPresets.toneSquelch')}
                selectedKeys={[newToneMode]}
                onSelectionChange={(keys) => {
                  const val = Array.from(keys)[0] as ToneSquelchOption;
                  if (val) {
                    setNewToneMode(val);
                    if (addError) setAddError('');
                  }
                }}
                className="flex-1"
              >
                {TONE_SQUELCH_OPTIONS.map(mode => (
                  <SelectItem key={mode} textValue={t(`freqPresets.toneSquelchOptions.${mode}`)}>
                    {t(`freqPresets.toneSquelchOptions.${mode}`)}
                  </SelectItem>
                ))}
              </Select>
              {newToneMode === 'ctcss' && (
                <Select
                  label={t('freqPresets.ctcssTone')}
                  placeholder={t('freqPresets.ctcssTonePlaceholder')}
                  selectedKeys={newCtcssToneTenthsHz ? [newCtcssToneTenthsHz] : []}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    setNewCtcssToneTenthsHz(val || '');
                    if (addError) setAddError('');
                  }}
                  className="flex-1"
                >
                  {CTCSS_TONE_TENTHS_HZ_OPTIONS.map(tone => (
                    <SelectItem key={String(tone)} textValue={formatCtcssTone(tone)}>
                      {formatCtcssTone(tone)}
                    </SelectItem>
                  ))}
                </Select>
              )}
              {newToneMode === 'dcs' && (
                <Select
                  label={t('freqPresets.dcsCode')}
                  placeholder={t('freqPresets.dcsCodePlaceholder')}
                  selectedKeys={newDcsCode ? [newDcsCode] : []}
                  onSelectionChange={(keys) => {
                    const val = Array.from(keys)[0] as string;
                    setNewDcsCode(val || '');
                    if (addError) setAddError('');
                  }}
                  className="flex-1"
                >
                  {DCS_CODE_OPTIONS.map(code => (
                    <SelectItem key={String(code)} textValue={formatDcsCode(code)}>
                      {formatDcsCode(code)}
                    </SelectItem>
                  ))}
                </Select>
              )}
            </div>
          )}
          <Input
            label={t('freqPresets.descriptionLabel')}
            placeholder={t('freqPresets.descPlaceholder')}
            value={newDescription}
            onValueChange={setNewDescription}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isSubmitting) {
                void handleAdd();
              }
            }}
          />
        </ModalBody>
        <ModalFooter className="justify-between">
          <div>
            {editingPreset && onDelete && (
              <Button
                color="danger"
                variant="flat"
                onPress={handleDelete}
                isLoading={isDeleting}
                isDisabled={isSubmitting || presets.length <= 1}
              >
                {t('freqPresets.delete')}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="flat" onPress={onClose} isDisabled={isSubmitting || isDeleting}>
              {t('common:button.cancel')}
            </Button>
            <Button color="primary" onPress={handleAdd} isLoading={isSubmitting} isDisabled={isDeleting}>
              {editingPreset ? t('freqPresets.saveEdit') : t('freqPresets.add')}
            </Button>
          </div>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
