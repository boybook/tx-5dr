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

interface FrequencyPresetAddModalProps {
  isOpen: boolean;
  presets: PresetFrequency[];
  initialMode?: string;
  initialRadioMode?: string;
  initialFrequencyHz?: number;
  editingPreset?: PresetFrequency | null;
  onClose: () => void;
  onAdd: (preset: PresetFrequency, previousPreset?: PresetFrequency | null) => void | Promise<void>;
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
}) => {
  const { t } = useTranslation();
  const [newMode, setNewMode] = useState(initialMode);
  const [newRadioMode, setNewRadioMode] = useState(initialRadioMode);
  const [newFreqMHz, setNewFreqMHz] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [addError, setAddError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

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

    if (!band || band === 'Unknown') {
      setAddError(t('freqPresets.unknownBand'));
      return;
    }

    if (presets.some(p => p.frequency === frequencyHz && p.frequency !== editingPreset?.frequency)) {
      setAddError(t('freqPresets.duplicate'));
      return;
    }

    const description = newDescription.trim() || `${freqValue.toFixed(3)} MHz ${band}`;
    const newPreset: PresetFrequency = {
      band,
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

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md">
      <ModalContent>
        <ModalHeader>{editingPreset ? t('freqPresets.editTitle') : t('freqPresets.addTitle')}</ModalHeader>
        <ModalBody>
          <div className="flex gap-3">
            <Input
              label={t('freqPresets.band')}
              value={inferredBand ?? t('freqPresets.bandAutoPending')}
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
        <ModalFooter>
          <Button variant="flat" onPress={onClose} isDisabled={isSubmitting}>
            {t('common:button.cancel')}
          </Button>
          <Button color="primary" onPress={handleAdd} isLoading={isSubmitting}>
            {editingPreset ? t('freqPresets.saveEdit') : t('freqPresets.add')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};
