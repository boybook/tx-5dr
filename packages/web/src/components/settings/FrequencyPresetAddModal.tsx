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

const MODE_OPTIONS = ['FT8', 'FT4', 'VOICE'];
const RADIO_MODE_OPTIONS = ['USB', 'LSB', 'FM', 'AM'];
const CUSTOM_BAND = 'custom';

interface FrequencyPresetAddModalProps {
  isOpen: boolean;
  presets: PresetFrequency[];
  initialMode?: string;
  initialRadioMode?: string;
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
        ? (editingPreset.frequency / 1_000_000).toFixed(3)
        : initialFrequencyHz
          ? (initialFrequencyHz / 1_000_000).toFixed(3)
          : '',
    );
    setNewDescription(editingPreset?.description ?? '');
    setAddError('');
    setIsSubmitting(false);
    setIsDeleting(false);
  }, [editingPreset, initialFrequencyHz, initialMode, initialRadioMode, isOpen]);

  const inferredBand = useMemo(() => {
    const freqValue = parseFloat(newFreqMHz);
    if (!Number.isFinite(freqValue) || freqValue <= 0) {
      return null;
    }
    const frequencyHz = Math.round(freqValue * 1_000_000);
    const band = getBandFromFrequency(frequencyHz);
    return band && band !== 'Unknown' ? band : null;
  }, [newFreqMHz]);
  const hasValidFrequencyInput = useMemo(() => {
    const freqValue = parseFloat(newFreqMHz);
    return Number.isFinite(freqValue) && freqValue > 0;
  }, [newFreqMHz]);
  const bandLabel = useMemo(
    () => inferredBand ?? (hasValidFrequencyInput ? t('freqPresets.customBand') : t('freqPresets.bandAutoPending')),
    [hasValidFrequencyInput, inferredBand, t],
  );

  const handleAdd = async () => {
    setAddError('');
    const freqValue = parseFloat(newFreqMHz);
    if (isNaN(freqValue) || freqValue <= 0) {
      setAddError(t('freqPresets.invalidFrequency'));
      return;
    }
    if (freqValue < 0.1 || freqValue > 1000) {
      setAddError(t('freqPresets.frequencyRange'));
      return;
    }

    const frequencyHz = Math.round(freqValue * 1_000_000);
    const band = getBandFromFrequency(frequencyHz);
    const normalizedBand = band && band !== 'Unknown' ? band : CUSTOM_BAND;

    if (presets.some(p => p.frequency === frequencyHz && p.frequency !== editingPreset?.frequency)) {
      setAddError(t('freqPresets.duplicate'));
      return;
    }

    const displayBand = normalizedBand === CUSTOM_BAND ? t('freqPresets.customBand') : normalizedBand;
    const description = newDescription.trim() || `${freqValue.toFixed(3)} MHz ${displayBand}`;
    const newPreset: PresetFrequency = {
      band: normalizedBand,
      mode: newMode,
      radioMode: newRadioMode,
      frequency: frequencyHz,
      description,
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
    <Modal isOpen={isOpen} onClose={onClose} size="md">
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
                if (val) setNewMode(val);
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
                if (val) setNewRadioMode(val);
              }}
              className="flex-1"
            >
              {RADIO_MODE_OPTIONS.map(mode => (
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
            step="0.001"
            description={t('freqPresets.frequencyRange')}
            isInvalid={!!addError}
            errorMessage={addError}
          />
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
