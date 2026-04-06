import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Button,
  ButtonGroup,
  Card,
  CardBody,
  CardHeader,
  Listbox,
  ListboxItem,
  ListboxSection,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Input,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { api, ApiError } from '@tx5dr/core';
import { useConnection, useRadioConnectionState, useRadioState } from '../../store/radioStore';
import { useHasMinRole, useCan, useAbility } from '../../store/authStore';
import { UserRole } from '@tx5dr/contracts';
import { subject as caslSubject } from '@casl/ability';
import { showErrorToast } from '../../utils/errorToast';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { isCoreCapabilityAvailable } from '../../utils/radioControl';

const logger = createLogger('VoiceFrequencyControl');
const CURRENT_CUSTOM_VOICE_FREQUENCY_KEY = '__current_custom_voice_frequency__';

/**
 * Shared ref for tracking which digit is currently active (hovered or editing).
 * Global keydown listener dispatches keyboard events to the active digit.
 */
interface ActiveDigitActions {
  onIncrement: () => void;
  onDecrement: () => void;
  onSetDigit: (value: number) => void;
}

const activeDigitRef: { current: ActiveDigitActions | null } = { current: null };
// Track the currently editing digit so clicking another digit can deselect the old one
const editingDigitDeselect: { current: (() => void) | null } = { current: null };

// Global keydown listener - installed once
let globalKeyListenerInstalled = false;
function installGlobalKeyListener() {
  if (globalKeyListenerInstalled) return;
  globalKeyListenerInstalled = true;

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const actions = activeDigitRef.current;
    if (!actions) return;

    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      actions.onIncrement();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      actions.onDecrement();
    } else if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      actions.onSetDigit(parseInt(e.key, 10));
    } else if (e.key === 'Escape') {
      // Exit editing mode
      editingDigitDeselect.current?.();
    }
  });

  // Click anywhere outside deselects the editing digit
  window.addEventListener('mousedown', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('[data-freq-digit]')) {
      editingDigitDeselect.current?.();
    }
  });
}

/**
 * Single interactive frequency digit.
 * - Hover: shows arrows, enables keyboard control
 * - Click: enters "editing" mode (highlighted, locks keyboard to this digit)
 * - Escape / click outside: exits editing mode
 */
const FrequencyDigit: React.FC<{
  digit: string;
  placeValue: number;
  disabled: boolean;
  isLeadingZero?: boolean;
  onIncrement: () => void;
  onDecrement: () => void;
  onSetDigit: (value: number) => void;
}> = React.memo(({ digit, disabled, isLeadingZero, onIncrement, onDecrement, onSetDigit }) => {
  const [hovered, setHovered] = useState(false);
  const [editing, setEditing] = useState(false);
  const handleDeselectEditing = useCallback(() => {
    setEditing(false);
  }, []);

  // Active = hovered OR editing
  const isActive = hovered || editing;

  useEffect(() => {
    installGlobalKeyListener();
  }, []);

  // Keep activeDigitRef in sync when this digit is active
  useEffect(() => {
    if (isActive && !disabled) {
      activeDigitRef.current = { onIncrement, onDecrement, onSetDigit };
    }
  }, [isActive, disabled, onIncrement, onDecrement, onSetDigit]);

  const handleMouseEnter = useCallback(() => {
    if (disabled) return;
    setHovered(true);
    activeDigitRef.current = { onIncrement, onDecrement, onSetDigit };
  }, [disabled, onIncrement, onDecrement, onSetDigit]);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    // Only clear activeDigitRef if not in editing mode
    if (!editing) {
      activeDigitRef.current = null;
    }
  }, [editing]);

  const handleClick = useCallback(() => {
    if (disabled) return;
    // Deselect previous editing digit
    if (editingDigitDeselect.current) {
      editingDigitDeselect.current();
    }
    setEditing(true);
    activeDigitRef.current = { onIncrement, onDecrement, onSetDigit };
    editingDigitDeselect.current = handleDeselectEditing;
  }, [disabled, handleDeselectEditing, onIncrement, onDecrement, onSetDigit]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (editingDigitDeselect.current === handleDeselectEditing) {
        editingDigitDeselect.current = null;
      }
    };
  }, [handleDeselectEditing]);

  // When disabled, never show interactive states
  const showActive = isActive && !disabled;

  return (
    <div
      data-freq-digit
      className={`relative flex flex-col items-center select-none ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
    >
      {/* Up arrow */}
      <div
        className={`h-4 text-xs leading-none transition-opacity duration-150 ${
          showActive ? 'opacity-100' : 'opacity-0'
        } flex items-center justify-center text-default-400 hover:text-primary`}
        onClick={(e) => { e.stopPropagation(); if (!disabled) onIncrement(); }}
      >
        ▲
      </div>

      {/* Digit */}
      <span className={`text-3xl leading-none transition-colors ${
        !disabled && editing
          ? 'text-primary'
          : !disabled && hovered
            ? 'text-primary'
            : isLeadingZero
              ? 'text-default-300 dark:text-default-500'
              : 'text-foreground'
      }`}>
        {digit}
      </span>

      {/* Editing indicator - underline cursor */}
      <div className={`h-0.5 w-full mt-0.5 rounded-full transition-all duration-150 ${
        !disabled && editing
          ? 'bg-primary opacity-100'
          : 'bg-transparent opacity-0'
      }`} />

      {/* Down arrow */}
      <div
        className={`h-4 text-xs leading-none transition-opacity duration-150 ${
          showActive ? 'opacity-100' : 'opacity-0'
        } flex items-center justify-center text-default-400 hover:text-primary`}
        onClick={(e) => { e.stopPropagation(); if (!disabled) onDecrement(); }}
      >
        ▼
      </div>
    </div>
  );
});
FrequencyDigit.displayName = 'FrequencyDigit';

interface FrequencyPreset {
  key: string;
  label: string;
  frequency: number;
  band: string;
  mode: string;
  radioMode?: string;
}

/**
 * Voice Frequency Control Component
 *
 * Large frequency display, radio mode selector (USB/LSB/FM/AM),
 * scrollable preset frequency list with band grouping.
 */
export const VoiceFrequencyControl: React.FC = () => {
  const { t } = useTranslation('voice');
  const connection = useConnection();
  const radioConnection = useRadioConnectionState();
  const radio = useRadioState();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const canManageFrequencyPresets = useCan('update', 'SettingsFrequencyPresets');
  const ability = useAbility();
  const canWriteFrequency = canSetFrequency && isCoreCapabilityAvailable(radioConnection.coreCapabilities, 'writeFrequency');
  const canWriteRadioMode = canSetFrequency && isCoreCapabilityAvailable(radioConnection.coreCapabilities, 'writeRadioMode');

  const [presets, setPresets] = useState<FrequencyPreset[]>([]);
  const [isLoadingPresets, setIsLoadingPresets] = useState(false);
  const [currentFrequency, setCurrentFrequency] = useState<number>(14270000);
  const currentFrequencyRef = React.useRef(currentFrequency);
  currentFrequencyRef.current = currentFrequency;
  const [currentRadioMode, setCurrentRadioMode] = useState<string>('USB');
  const currentRadioModeRef = React.useRef(currentRadioMode);
  currentRadioModeRef.current = currentRadioMode;
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [customError, setCustomError] = useState('');
  const [isSettingFreq, setIsSettingFreq] = useState(false);

  const RADIO_MODES = ['USB', 'LSB', 'FM', 'AM'];
  const formatFrequencyLabel = useCallback((frequency: number) => `${(frequency / 1000000).toFixed(3)} MHz`, []);
  const loadVoicePresets = useCallback(async () => {
    if (!connection.state.isConnected) return;

    setIsLoadingPresets(true);
    try {
      const [presetsResponse, lastFreqResponse] = await Promise.all([
        api.getPresetFrequencies(),
        api.getLastFrequency(),
      ]);

      if (presetsResponse.success && Array.isArray(presetsResponse.presets)) {
        // Filter for VOICE mode presets and always present them in ascending frequency order.
        // The settings editor still preserves manual ordering for editing, but the operator-facing
        // voice control list should remain predictable and frequency-centric.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const voicePresets: FrequencyPreset[] = presetsResponse.presets
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((p: any) => p.mode === 'VOICE')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((p: any) => ({
            key: String(p.frequency),
            label: p.description || `${p.band} ${(p.frequency / 1000000).toFixed(3)} MHz`,
            frequency: p.frequency,
            band: p.band,
            mode: p.mode,
            radioMode: p.radioMode,
          }))
          .sort((a, b) => a.frequency - b.frequency);
        setPresets(voicePresets);
      }

      // Restore last voice frequency (separate from digital mode frequency)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lastVoice = (lastFreqResponse as any).lastVoiceFrequency;
      if (lastVoice && lastVoice.frequency) {
        setCurrentFrequency(lastVoice.frequency);
        if (lastVoice.radioMode) setCurrentRadioMode(lastVoice.radioMode);
        logger.info('Restored last voice frequency', { frequency: lastVoice.frequency, radioMode: lastVoice.radioMode });
      }
    } catch (error) {
      logger.error('Failed to load voice presets:', error);
    } finally {
      setIsLoadingPresets(false);
    }
  }, [connection.state.isConnected]);

  // Load voice frequency presets + restore last frequency
  useEffect(() => {
    void loadVoicePresets();
  }, [loadVoicePresets]);

  useEffect(() => {
    const handleFrequencyPresetsUpdated = () => {
      void loadVoicePresets();
    };

    window.addEventListener('frequencyPresetsUpdated', handleFrequencyPresetsUpdated);
    return () => {
      window.removeEventListener('frequencyPresetsUpdated', handleFrequencyPresetsUpdated);
    };
  }, [loadVoicePresets]);

  // Sync current frequency from radio state
  useEffect(() => {
    if (radio.state.currentRadioMode) {
      setCurrentRadioMode(radio.state.currentRadioMode);
    }
  }, [radio.state.currentRadioMode]);

  // Listen for frequency changes from server
  useEffect(() => {
    const radioService = connection.state.radioService;
    if (!radioService) return;
    const wsClient = radioService.wsClientInstance;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleFreqChanged = (data: any) => {
      if (data.frequency) setCurrentFrequency(data.frequency);
      if (data.radioMode) setCurrentRadioMode(data.radioMode);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged', handleFreqChanged as any);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged', handleFreqChanged as any);
    };
  }, [connection.state.radioService]);

  // Group presets by band (with CASL frequency condition filtering)
  const groupedPresets = useMemo(() => {
    let filtered = presets;
    // CASL 条件过滤：非 admin 用户只显示被允许的频率预设
    if (!isAdmin && canSetFrequency) {
      filtered = presets.filter(preset =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ability.can('execute', caslSubject('RadioFrequency', { frequency: preset.frequency }) as any),
      );
    }
    const groups: Record<string, FrequencyPreset[]> = {};
    for (const preset of filtered) {
      const band = preset.band || 'Other';
      if (!groups[band]) groups[band] = [];
      groups[band].push(preset);
    }
    return groups;
  }, [presets, isAdmin, canSetFrequency, ability]);

  const currentPresetSelection = useMemo(() => {
    const preset = presets.find(item => item.frequency === currentFrequency);
    if (preset) {
      return preset;
    }

    return {
      key: CURRENT_CUSTOM_VOICE_FREQUENCY_KEY,
      label: formatFrequencyLabel(currentFrequency),
      frequency: currentFrequency,
      band: t('frequency.customFrequency'),
      mode: 'VOICE',
      radioMode: currentRadioMode,
    } satisfies FrequencyPreset;
  }, [currentFrequency, currentRadioMode, formatFrequencyLabel, presets, t]);

  const listboxSections = useMemo(() => {
    const entries = Object.entries(groupedPresets);

    if (currentPresetSelection.key !== CURRENT_CUSTOM_VOICE_FREQUENCY_KEY) {
      return entries;
    }

    return [
      [t('frequency.customFrequency'), [currentPresetSelection]],
      ...entries,
    ] as [string, FrequencyPreset[]][];
  }, [currentPresetSelection, groupedPresets, t]);

  // Break frequency into individual digits with their place values
  // Fixed format: XXX.XXX.XXX (3+3+3 digits, leading zeros shown dimmed)
  const frequencyDigits = useMemo(() => {
    const freq = Math.round(currentFrequency);
    const mhzWhole = Math.floor(freq / 1000000);
    const remainder = freq % 1000000;
    const khzPart = Math.floor(remainder / 1000);
    const hzPart = remainder % 1000;

    // Always 3 digits for each group
    const mhzStr = String(mhzWhole).padStart(3, '0');
    const khzStr = String(khzPart).padStart(3, '0');
    const hzStr = String(hzPart).padStart(3, '0');

    type DigitEntry = { char: string; placeValue: number; isSeparator: false; index: number; isLeadingZero: boolean }
      | { char: string; isSeparator: true };
    const result: DigitEntry[] = [];

    // MHz digits (fixed 3 digits: 000-999)
    const mhzPlaces = [100000000, 10000000, 1000000];
    let seenNonZero = false;
    for (let i = 0; i < 3; i++) {
      const isLeadingZero = !seenNonZero && mhzStr[i] === '0';
      if (mhzStr[i] !== '0') seenNonZero = true;
      result.push({ char: mhzStr[i], placeValue: mhzPlaces[i], isSeparator: false, index: result.length, isLeadingZero });
    }
    result.push({ char: '.', isSeparator: true });

    // kHz digits (always 3)
    const khzPlaces = [100000, 10000, 1000];
    for (let i = 0; i < 3; i++) {
      result.push({ char: khzStr[i], placeValue: khzPlaces[i], isSeparator: false, index: result.length, isLeadingZero: false });
    }
    result.push({ char: '.', isSeparator: true });

    // Hz digits (always 3)
    const hzPlaces = [100, 10, 1];
    for (let i = 0; i < 3; i++) {
      result.push({ char: hzStr[i], placeValue: hzPlaces[i], isSeparator: false, index: result.length, isLeadingZero: false });
    }

    return result;
  }, [currentFrequency]);

  // Apply a new frequency to radio (reads latest state from refs, stable reference)
  const applyFrequency = useCallback(async (newFreq: number) => {
    setCurrentFrequency(newFreq);
    try {
      await api.setRadioFrequency({
        frequency: newFreq,
        mode: 'VOICE',
        band: 'Custom',
        description: `${(newFreq / 1000000).toFixed(3)} MHz`,
        radioMode: currentRadioModeRef.current,
      });
    } catch (error) {
      logger.error('Failed to set frequency:', error);
    }
  }, []);

  // Change a single digit at a given place value (stable - reads from ref)
  const changeDigitAtPlace = useCallback((placeValue: number, delta: number) => {
    const freq = currentFrequencyRef.current;
    const newFreq = Math.max(0, freq + delta * placeValue);
    if (newFreq < 1000000 || newFreq > 1000000000) return;
    applyFrequency(newFreq);
  }, [applyFrequency]);

  // Set a specific digit value at a given place value (stable - reads from ref)
  const setDigitAtPlace = useCallback((placeValue: number, newDigitValue: number) => {
    const freq = Math.round(currentFrequencyRef.current);
    const currentDigit = Math.floor(freq / placeValue) % 10;
    const delta = newDigitValue - currentDigit;
    if (delta === 0) return;
    const newFreq = freq + delta * placeValue;
    if (newFreq < 1000000 || newFreq > 1000000000) return;
    applyFrequency(newFreq);
  }, [applyFrequency]);

  // Handle frequency preset selection
  const handlePresetSelect = async (key: string) => {
    if (!canWriteFrequency || !connection.state.isConnected) return;

    const preset = presets.find(p => p.key === key);
    if (!preset) return;

    try {
      const response = await api.setRadioFrequency({
        frequency: preset.frequency,
        mode: 'VOICE',
        band: preset.band,
        description: preset.label,
        radioMode: preset.radioMode,
      });

      if (response.success) {
        setCurrentFrequency(preset.frequency);
        if (preset.radioMode) setCurrentRadioMode(preset.radioMode);
        addToast({
          title: t('frequency.switchSuccess'),
          description: t('frequency.switched', { freq: (preset.frequency / 1000000).toFixed(3) }),
          color: 'success',
          timeout: 3000,
        });
      }
    } catch (error) {
      logger.error('Failed to set voice frequency:', error);
      if (error instanceof ApiError) {
        showErrorToast({ userMessage: error.userMessage, suggestions: error.suggestions, severity: error.severity, code: error.code });
      }
    }
  };

  // Handle radio mode change
  const handleRadioModeChange = (mode: string) => {
    if (!canWriteRadioMode) return;
    setCurrentRadioMode(mode);
    connection.state.radioService?.setVoiceRadioMode(mode);
  };

  // Handle custom frequency confirm
  const handleCustomConfirm = async () => {
    const trimmed = customInput.trim();
    if (!trimmed) return;

    const value = parseFloat(trimmed);
    if (isNaN(value) || value <= 0) {
      setCustomError(t('frequency.switchFailed'));
      return;
    }

    let frequencyHz: number;
    if (trimmed.includes('.')) {
      frequencyHz = Math.round(value * 1000000);
    } else {
      frequencyHz = Math.round(value);
    }

    if (frequencyHz < 1000000 || frequencyHz > 1000000000) {
      setCustomError(t('frequency.switchFailed'));
      return;
    }

    setIsSettingFreq(true);
    try {
      const response = await api.setRadioFrequency({
        frequency: frequencyHz,
        mode: 'VOICE',
        band: 'Custom',
        description: `${(frequencyHz / 1000000).toFixed(3)} MHz`,
      });

      if (response.success) {
        setCurrentFrequency(frequencyHz);
        setIsCustomModalOpen(false);
        setCustomInput('');
        setCustomError('');
        addToast({
          title: t('frequency.switchSuccess'),
          description: t('frequency.switched', { freq: (frequencyHz / 1000000).toFixed(3) }),
          color: 'success',
          timeout: 3000,
        });
      }
    } catch (error) {
      logger.error('Failed to set custom voice frequency:', error);
      if (error instanceof ApiError) {
        showErrorToast({ userMessage: error.userMessage, suggestions: error.suggestions, severity: error.severity, code: error.code });
      }
    } finally {
      setIsSettingFreq(false);
    }
  };

  const handleOpenVoicePresetSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('openSettingsModal', {
      detail: {
        tab: 'frequency_presets',
        frequencyPresetMode: 'VOICE',
      },
    }));
  }, []);

  return (
    <Card className="w-full h-full bg-default-50 dark:bg-default-100/50 border border-default-200 dark:border-default-100" shadow="none">
      <CardHeader className="pb-1 flex-shrink-0">
        <div className="flex items-center justify-between w-full">
          <span className="text-sm font-semibold">{t('frequency.title')}</span>
        </div>
      </CardHeader>
      <CardBody className="pt-1 gap-3 overflow-hidden">
        {/* Interactive frequency display */}
        <div className="flex-shrink-0 text-center py-2">
          <div className="flex items-center justify-center font-mono font-bold text-foreground">
            {frequencyDigits.map((entry, i) => {
              if (entry.isSeparator) {
                return <span key={`sep-${i}`} className="text-3xl mx-0.5 text-default-400 select-none">.</span>;
              }
              return (
                <FrequencyDigit
                  key={`d-${i}`}
                  digit={entry.char}
                  placeValue={entry.placeValue}
                  disabled={!canWriteFrequency}
                  isLeadingZero={entry.isLeadingZero}
                  onIncrement={() => changeDigitAtPlace(entry.placeValue, 1)}
                  onDecrement={() => changeDigitAtPlace(entry.placeValue, -1)}
                  onSetDigit={(v) => setDigitAtPlace(entry.placeValue, v)}
                />
              );
            })}
          </div>
          <div className="text-xs text-default-400 mt-1">{t('frequency.mhz')}</div>
        </div>

        {/* Radio mode buttons */}
        <div className="flex-shrink-0 flex justify-center">
          <ButtonGroup size="sm" variant="flat">
            {RADIO_MODES.map((mode) => (
              <Button
                key={mode}
                color={currentRadioMode === mode ? 'primary' : 'default'}
                variant={currentRadioMode === mode ? 'solid' : 'flat'}
                onPress={() => handleRadioModeChange(mode)}
                isDisabled={!canWriteRadioMode}
                className="min-w-12"
              >
                {mode}
              </Button>
            ))}
          </ButtonGroup>
        </div>

        {/* Preset frequency list - fills remaining space */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {isLoadingPresets ? (
            <div className="text-center text-default-400 py-4 text-sm">{t('frequency.noPresets')}</div>
          ) : (
              <Listbox
              aria-label={t('frequency.presets')}
              selectionMode="single"
              selectedKeys={new Set([currentPresetSelection.key])}
              onSelectionChange={(keys) => {
                if (!canWriteFrequency) return;
                if (keys === 'all') return;
                const key = Array.from(keys)[0] as string;
                if (key === CURRENT_CUSTOM_VOICE_FREQUENCY_KEY) return;
                if (key) handlePresetSelect(key);
              }}
              variant="flat"
              className={`p-0${!canWriteFrequency ? ' opacity-50 pointer-events-none' : ''}`}
            >
              {listboxSections.map(([band, bandPresets]) => (
                <ListboxSection key={band} title={band} showDivider>
                  {bandPresets.map((preset) => (
                    <ListboxItem
                      key={preset.key}
                      textValue={preset.label}
                      className="text-sm"
                      endContent={
                        <span className="text-xs text-default-400">{preset.radioMode}</span>
                      }
                    >
                      {preset.label}
                    </ListboxItem>
                  ))}
                </ListboxSection>
              ))}
            </Listbox>
          )}
        </div>

        {/* Voice frequency actions */}
        {(canWriteFrequency || canManageFrequencyPresets) && (
          <div className="flex-shrink-0">
            <div className={`grid gap-2 ${canWriteFrequency && canManageFrequencyPresets ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {canWriteFrequency && (
                <Button
                  size="sm"
                  variant="flat"
                  onPress={() => setIsCustomModalOpen(true)}
                  className="w-full"
                >
                  {t('frequency.manualTune')}
                </Button>
              )}
              {canManageFrequencyPresets && (
                <Button
                  size="sm"
                  variant="flat"
                  onPress={handleOpenVoicePresetSettings}
                  className="w-full"
                >
                  {t('frequency.managePresets')}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardBody>

      {/* Custom frequency modal */}
      <Modal
        isOpen={isCustomModalOpen}
        onClose={() => {
          setIsCustomModalOpen(false);
          setCustomInput('');
          setCustomError('');
        }}
        placement="center"
        size="sm"
      >
        <ModalContent>
          <ModalHeader>{t('frequency.customTitle')}</ModalHeader>
          <ModalBody>
            <Input
              autoFocus
              label={t('frequency.currentFrequency')}
              placeholder={t('frequency.inputPlaceholder')}
              value={customInput}
              onValueChange={(v) => {
                setCustomInput(v);
                if (customError) setCustomError('');
              }}
              variant="flat"
              isInvalid={!!customError}
              errorMessage={customError}
              description={t('frequency.inputHint')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isSettingFreq) handleCustomConfirm();
              }}
            />
          </ModalBody>
          <ModalFooter>
            <Button
              variant="flat"
              onPress={() => {
                setIsCustomModalOpen(false);
                setCustomInput('');
                setCustomError('');
              }}
              isDisabled={isSettingFreq}
            >
              {t('common:button.cancel')}
            </Button>
            <Button
              color="primary"
              onPress={handleCustomConfirm}
              isLoading={isSettingFreq}
              isDisabled={!customInput.trim()}
            >
              {t('frequency.confirm')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Card>
  );
};
