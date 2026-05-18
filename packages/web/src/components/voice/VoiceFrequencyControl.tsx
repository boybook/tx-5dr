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
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { api, ApiError } from '@tx5dr/core';
import { useConnection, useOperators, useRadioConnectionState, useRadioState } from '../../store/radioStore';
import { useAuth, useHasMinRole, useCan, useAbility } from '../../store/authStore';
import { UserRole, type PresetFrequency } from '@tx5dr/contracts';
import { showErrorToast } from '../../utils/errorToast';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { canExecuteRadioFrequency, canWriteRadioFrequency, isCoreCapabilityAvailable } from '../../utils/radioControl';
import { resetOperatorsForOperatingStateChange } from '../../utils/operatorReset';
import { FrequencyPresetAddModal } from '../settings/FrequencyPresetAddModal';
import { formatToneSquelch } from '../../utils/toneSquelch';
import { setRadioFrequencyWithIntent } from '../../utils/radioFrequencyIntent';
import { FrequencyDigit } from '../radio/frequency/FrequencyDigit';

const logger = createLogger('VoiceFrequencyControl');
const CURRENT_CUSTOM_VOICE_FREQUENCY_KEY = '__current_custom_voice_frequency__';
const CUSTOM_BAND = 'custom';

interface FrequencyPreset {
  key: string;
  label: string;
  frequency: number;
  band: string;
  mode: string;
  radioMode?: string;
  repeaterShift?: 'none' | 'minus' | 'plus';
  repeaterOffsetHz?: number;
  toneMode?: 'none' | 'ctcss' | 'dcs';
  ctcssToneTenthsHz?: number;
  dcsCode?: number;
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
  const { operators } = useOperators();
  const radioConnection = useRadioConnectionState();
  const radio = useRadioState();
  const { state: authState } = useAuth();
  const isAdmin = useHasMinRole(UserRole.ADMIN);
  const canUseAuthenticatedRest = !authState.authEnabled || Boolean(authState.jwt);
  const canSetFrequency = useCan('execute', 'RadioFrequency');
  const canManageFrequencyPresets = useCan('update', 'SettingsFrequencyPresets');
  const ability = useAbility();
  const canWriteFrequency = canWriteRadioFrequency(canSetFrequency, radioConnection.coreCapabilities);
  const canWriteTargetFrequency = useCallback((frequency: number) => (
    canWriteFrequency && canExecuteRadioFrequency(ability, frequency)
  ), [ability, canWriteFrequency]);
  const canWriteRadioMode = canSetFrequency && isCoreCapabilityAvailable(radioConnection.coreCapabilities, 'writeRadioMode');

  const [presets, setPresets] = useState<FrequencyPreset[]>([]);
  const [isLoadingPresets, setIsLoadingPresets] = useState(false);
  const [currentFrequency, setCurrentFrequency] = useState<number>(14270000);
  const currentFrequencyRef = React.useRef(currentFrequency);
  currentFrequencyRef.current = currentFrequency;
  const [currentRadioMode, setCurrentRadioMode] = useState<string>('USB');
  const currentRadioModeRef = React.useRef(currentRadioMode);
  currentRadioModeRef.current = currentRadioMode;
  const [isAddPresetModalOpen, setIsAddPresetModalOpen] = useState(false);

  // Pending frequency tracking: suppresses stale server echo (e.g. from 5s radio polling)
  // overwriting user's just-typed value. Also used as a trailing-debounce buffer so that
  // rapid consecutive digit edits (▲/▼ clicks, arrow keys, 0-9 direct entry) coalesce into
  // a single setRadioFrequency call.
  const pendingFreqRef = React.useRef<{ intendedFrequency: number; sentAt: number } | null>(null);
  const freqDebounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const FREQ_PENDING_TIMEOUT_MS = 1500;
  const FREQ_MATCH_TOLERANCE_HZ = 10;
  const FREQ_DEBOUNCE_MS = 50;

  const resetOperatorsAfterOperatingStateChange = useCallback(() => {
    resetOperatorsForOperatingStateChange({
      operators,
      radioService: connection.state.radioService,
    });
  }, [connection.state.radioService, operators]);

  // Accept a server-pushed frequency, honoring any pending local intent.
  // Server echoes (via WS frequencyChanged OR global radio store sync) can lag behind
  // rapid user edits — if a pending intent exists and the echo doesn't match it within
  // the tolerance window, ignore the echo to keep UI stable. Pending auto-releases
  // after FREQ_PENDING_TIMEOUT_MS so a stuck hardware won't leave UI permanently out of sync.
  const acceptServerFrequency = useCallback((incoming: number | null | undefined) => {
    if (typeof incoming !== 'number' || incoming <= 0) return;
    const pending = pendingFreqRef.current;
    if (pending) {
      const withinWindow = Date.now() - pending.sentAt < FREQ_PENDING_TIMEOUT_MS;
      const matched = Math.abs(incoming - pending.intendedFrequency) < FREQ_MATCH_TOLERANCE_HZ;
      if (withinWindow && !matched) return;
      if (matched) pendingFreqRef.current = null;
    }
    setCurrentFrequency(incoming);
  }, []);

  // Send the most recent pending frequency to the server. Reused by both the debounced
  // digit-edit path and the preset-select path (which bypasses debounce for snappy feel).
  const flushPendingFrequency = useCallback(async (
    overrides?: { band?: string; description?: string; radioMode?: string },
  ) => {
    const pending = pendingFreqRef.current;
    if (!pending) return;

    if (!canWriteTargetFrequency(pending.intendedFrequency) || !connection.state.isConnected) {
      pendingFreqRef.current = null;
      return;
    }

    const freq = pending.intendedFrequency;
    pendingFreqRef.current = { intendedFrequency: freq, sentAt: Date.now() };
    try {
      const response = await setRadioFrequencyWithIntent({
        frequency: freq,
        mode: 'VOICE',
        band: overrides?.band ?? 'Custom',
        description: overrides?.description ?? `${(freq / 1000000).toFixed(3)} MHz`,
        radioMode: overrides?.radioMode ?? currentRadioModeRef.current,
        repeaterShift: 'none',
        toneMode: 'none',
      });
      if (response.success) {
        resetOperatorsAfterOperatingStateChange();
      }
    } catch (error) {
      logger.error('Failed to set frequency:', error);
    }
  }, [canWriteTargetFrequency, connection.state.isConnected, resetOperatorsAfterOperatingStateChange]);

  // Apply a new frequency from digit edits. Updates UI immediately, marks pending,
  // and coalesces rapid consecutive edits via a 50ms trailing debounce.
  const applyFrequency = useCallback((newFreq: number) => {
    if (!canWriteTargetFrequency(newFreq) || !connection.state.isConnected) {
      pendingFreqRef.current = null;
      return;
    }

    setCurrentFrequency(newFreq);
    pendingFreqRef.current = { intendedFrequency: newFreq, sentAt: Date.now() };
    if (freqDebounceTimerRef.current) {
      clearTimeout(freqDebounceTimerRef.current);
    }
    freqDebounceTimerRef.current = setTimeout(() => {
      freqDebounceTimerRef.current = null;
      void flushPendingFrequency();
    }, FREQ_DEBOUNCE_MS);
  }, [canWriteTargetFrequency, connection.state.isConnected, flushPendingFrequency]);

  // Cleanup debounce timer on unmount
  useEffect(() => () => {
    if (freqDebounceTimerRef.current) {
      clearTimeout(freqDebounceTimerRef.current);
      freqDebounceTimerRef.current = null;
    }
  }, []);

  const RADIO_MODES = ['USB', 'LSB', 'FM', 'AM'];
  const formatFrequencyLabel = useCallback((frequency: number) => `${(frequency / 1000000).toFixed(3)} MHz`, []);
  const formatBandLabel = useCallback((band?: string | null) => {
    if (!band || band.toLowerCase() === CUSTOM_BAND) {
      return t('frequency.customBand');
    }
    return band;
  }, [t]);
  const formatRepeaterDuplex = useCallback((preset: Pick<FrequencyPreset, 'repeaterShift' | 'repeaterOffsetHz'>) => {
    const shift = preset.repeaterShift ?? 'none';
    if (shift === 'none' || !preset.repeaterOffsetHz) {
      return '';
    }
    return `${shift === 'plus' ? '+' : '-'}${preset.repeaterOffsetHz / 1_000} kHz`;
  }, []);
  const loadVoicePresets = useCallback(async () => {
    if (!connection.state.isConnected) return;
    if (!canUseAuthenticatedRest) {
      setPresets([]);
      return;
    }

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
            label: p.description || `${formatBandLabel(p.band)} ${(p.frequency / 1000000).toFixed(3)} MHz`,
            frequency: p.frequency,
            band: p.band,
            mode: p.mode,
            radioMode: p.radioMode,
            repeaterShift: p.repeaterShift,
            repeaterOffsetHz: p.repeaterOffsetHz,
            toneMode: p.toneMode,
            ctcssToneTenthsHz: p.ctcssToneTenthsHz,
            dcsCode: p.dcsCode,
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
        logger.info('Restored last voice frequency', {
          frequency: lastVoice.frequency,
          radioMode: lastVoice.radioMode,
          repeaterShift: lastVoice.repeaterShift,
          repeaterOffsetHz: lastVoice.repeaterOffsetHz,
          toneMode: lastVoice.toneMode,
          ctcssToneTenthsHz: lastVoice.ctcssToneTenthsHz,
          dcsCode: lastVoice.dcsCode,
        });
      }
    } catch (error) {
      logger.error('Failed to load voice presets:', error);
    } finally {
      setIsLoadingPresets(false);
    }
  }, [canUseAuthenticatedRest, connection.state.isConnected, formatBandLabel]);

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

  // Sync current frequency from radio state (via global store). Goes through
  // acceptServerFrequency to honor pending local intent and avoid echo-triggered flicker.
  useEffect(() => {
    acceptServerFrequency(radio.state.currentRadioFrequency);
  }, [radio.state.currentRadioFrequency, acceptServerFrequency]);

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
      acceptServerFrequency(data?.frequency);
      if (data?.radioMode) setCurrentRadioMode(data.radioMode);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient.onWSEvent('frequencyChanged', handleFreqChanged as any);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wsClient.offWSEvent('frequencyChanged', handleFreqChanged as any);
    };
  }, [connection.state.radioService, acceptServerFrequency]);

  // Group presets by band (with CASL frequency condition filtering)
  const groupedPresets = useMemo(() => {
    let filtered = presets;
    // CASL 条件过滤：非 admin 用户只显示被允许的频率预设
    if (!isAdmin && canSetFrequency) {
      filtered = presets.filter(preset =>
        canExecuteRadioFrequency(ability, preset.frequency),
      );
    }
    const groups: Record<string, FrequencyPreset[]> = {};
    for (const preset of filtered) {
      const band = formatBandLabel(preset.band);
      if (!groups[band]) groups[band] = [];
      groups[band].push(preset);
    }
    return groups;
  }, [presets, isAdmin, canSetFrequency, ability, formatBandLabel]);

  const currentPresetSelection = useMemo(() => {
    const preset = presets.find(item => item.frequency === currentFrequency);
    if (preset) {
      return preset;
    }

    return {
      key: CURRENT_CUSTOM_VOICE_FREQUENCY_KEY,
      label: formatFrequencyLabel(currentFrequency),
      frequency: currentFrequency,
      band: CUSTOM_BAND,
      mode: 'VOICE',
      radioMode: currentRadioMode,
      repeaterShift: 'none',
      toneMode: 'none',
    } satisfies FrequencyPreset;
  }, [currentFrequency, currentRadioMode, formatFrequencyLabel, presets, t]);

  const currentPresetForEdit = useMemo<PresetFrequency | null>(() => {
    const preset = presets.find(item => item.frequency === currentFrequency);
    if (!preset) return null;
    const supportsFmOptions = (preset.radioMode ?? currentRadioMode) === 'FM';

    return {
      band: preset.band,
      mode: 'VOICE',
      radioMode: preset.radioMode ?? currentRadioMode,
      frequency: preset.frequency,
      description: preset.label,
      ...(supportsFmOptions && preset.repeaterShift && preset.repeaterShift !== 'none'
        ? { repeaterShift: preset.repeaterShift, repeaterOffsetHz: preset.repeaterOffsetHz }
        : {}),
      ...(supportsFmOptions && preset.toneMode === 'ctcss'
        ? { toneMode: 'ctcss' as const, ctcssToneTenthsHz: preset.ctcssToneTenthsHz }
        : {}),
      ...(supportsFmOptions && preset.toneMode === 'dcs'
        ? { toneMode: 'dcs' as const, dcsCode: preset.dcsCode }
        : {}),
    };
  }, [currentFrequency, currentRadioMode, presets]);

  const listboxSections = useMemo(() => {
    const entries = Object.entries(groupedPresets);

    if (currentPresetSelection.key !== CURRENT_CUSTOM_VOICE_FREQUENCY_KEY) {
      return entries;
    }

    const currentBand = formatBandLabel(currentPresetSelection.band);
    const merged = entries.map(([band, bandPresets]) => (
      band === currentBand
        ? [band, [currentPresetSelection, ...bandPresets]]
        : [band, bandPresets]
    )) as [string, FrequencyPreset[]][];

    if (merged.some(([band]) => band === currentBand)) {
      return merged;
    }

    return [[currentBand, [currentPresetSelection]], ...entries] as [string, FrequencyPreset[]][];
  }, [currentPresetSelection, formatBandLabel, groupedPresets]);

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
    if (!canWriteTargetFrequency(preset.frequency)) return;

    // Immediately update UI + register pending intent so any stale server echo
    // (incl. in-flight debounced digit edits) is suppressed until preset confirms.
    setCurrentFrequency(preset.frequency);
    if (preset.radioMode) setCurrentRadioMode(preset.radioMode);
    pendingFreqRef.current = { intendedFrequency: preset.frequency, sentAt: Date.now() };
    if (freqDebounceTimerRef.current) {
      clearTimeout(freqDebounceTimerRef.current);
      freqDebounceTimerRef.current = null;
    }

    try {
      const supportsFmOptions = preset.radioMode === 'FM';
      const response = await setRadioFrequencyWithIntent({
        frequency: preset.frequency,
        mode: 'VOICE',
        band: preset.band,
        description: preset.label,
        radioMode: preset.radioMode,
        repeaterShift: supportsFmOptions ? (preset.repeaterShift ?? 'none') : 'none',
        repeaterOffsetHz: supportsFmOptions ? preset.repeaterOffsetHz : undefined,
        toneMode: supportsFmOptions ? (preset.toneMode ?? 'none') : 'none',
        ctcssToneTenthsHz: supportsFmOptions ? preset.ctcssToneTenthsHz : undefined,
        dcsCode: supportsFmOptions ? preset.dcsCode : undefined,
      });

      if (response.success) {
        if (pendingFreqRef.current) {
          pendingFreqRef.current = { intendedFrequency: preset.frequency, sentAt: Date.now() };
        }
        resetOperatorsAfterOperatingStateChange();
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

  const handleOpenVoicePresetSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('openSettingsModal', {
      detail: {
        tab: 'frequency_presets',
        frequencyPresetMode: 'VOICE',
      },
    }));
  }, []);

  const handleSaveCurrentFrequencyPreset = useCallback(async (
    preset: PresetFrequency,
    previousPreset?: PresetFrequency | null,
  ) => {
    try {
      const currentPresetsResponse = await api.getFrequencyPresets();
      if (!currentPresetsResponse.success) {
        throw new Error('Failed to load frequency presets');
      }

      const nextPresets = [...currentPresetsResponse.presets];
      if (previousPreset) {
        const existingIndex = nextPresets.findIndex(item =>
          item.mode === previousPreset.mode && item.frequency === previousPreset.frequency,
        );
        if (existingIndex >= 0) {
          nextPresets[existingIndex] = preset;
        } else {
          nextPresets.push(preset);
        }
      } else {
        nextPresets.push(preset);
      }

      const updateResponse = await api.updateFrequencyPresets(nextPresets);
      if (!updateResponse.success) {
        throw new Error('Failed to save frequency preset');
      }

      window.dispatchEvent(new CustomEvent('frequencyPresetsUpdated'));
      addToast({
        title: previousPreset ? t('frequency.editPresetSuccess') : t('frequency.addPresetSuccess'),
        description: preset.description || formatFrequencyLabel(preset.frequency),
        color: 'success',
        timeout: 3000,
      });
      void loadVoicePresets();
    } catch (error) {
      logger.error('Failed to save current voice frequency preset:', error);
      if (error instanceof ApiError) {
        showErrorToast({ userMessage: error.userMessage, suggestions: error.suggestions, severity: error.severity, code: error.code });
        throw error;
      }
      showErrorToast({ userMessage: t('common:freqPresets.saveFailed'), severity: 'error' });
      throw error;
    }
  }, [formatFrequencyLabel, loadVoicePresets, t]);

  const handleDeleteCurrentFrequencyPreset = useCallback(async (preset: PresetFrequency) => {
    try {
      const currentPresetsResponse = await api.getFrequencyPresets();
      if (!currentPresetsResponse.success) {
        throw new Error('Failed to load frequency presets');
      }

      const nextPresets = currentPresetsResponse.presets.filter(item =>
        !(item.mode === preset.mode && item.frequency === preset.frequency),
      );
      if (nextPresets.length === currentPresetsResponse.presets.length || nextPresets.length === 0) {
        throw new Error('Failed to delete frequency preset');
      }

      const updateResponse = await api.updateFrequencyPresets(nextPresets);
      if (!updateResponse.success) {
        throw new Error('Failed to delete frequency preset');
      }

      window.dispatchEvent(new CustomEvent('frequencyPresetsUpdated'));
      addToast({
        title: t('frequency.deletePresetSuccess'),
        description: preset.description || formatFrequencyLabel(preset.frequency),
        color: 'success',
        timeout: 3000,
      });
      void loadVoicePresets();
    } catch (error) {
      logger.error('Failed to delete current voice frequency preset:', error);
      if (error instanceof ApiError) {
        showErrorToast({ userMessage: error.userMessage, suggestions: error.suggestions, severity: error.severity, code: error.code });
        throw error;
      }
      showErrorToast({ userMessage: t('common:freqPresets.deleteFailed'), severity: 'error' });
      throw error;
    }
  }, [formatFrequencyLabel, loadVoicePresets, t]);

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
            <div className="min-w-0 shrink overflow-hidden flex justify-end" aria-hidden="true">
              <span className="mr-3 translate-y-1.5 text-xs font-semibold text-default-400 invisible">{t('frequency.mhz')}</span>
            </div>
            <div className="flex flex-none items-center justify-center">
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
            <span className="ml-3 flex-none self-center translate-y-1.5 text-xs font-semibold text-default-400">{t('frequency.mhz')}</span>
          </div>
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
              {listboxSections.map(([band, bandPresets], sectionIndex) => (
                <ListboxSection key={`voice-frequency-section-${sectionIndex}-${band}`} title={band} showDivider>
                  {bandPresets.map((preset) => (
                    <ListboxItem
                      key={preset.key}
                      textValue={preset.label}
                      className="text-sm"
                      endContent={
                        <span className="text-xs text-default-400 text-right">
                          {[preset.radioMode, preset.radioMode === 'FM' ? formatRepeaterDuplex(preset) : '', preset.radioMode === 'FM' ? formatToneSquelch(preset as PresetFrequency, t, { showNone: false }) : ''].filter(Boolean).join(' ')}
                        </span>
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
        {canManageFrequencyPresets && (
          <div className="flex-shrink-0">
            <div className="grid gap-2 grid-cols-2">
              <Button
                size="sm"
                variant="flat"
                color="primary"
                onPress={() => setIsAddPresetModalOpen(true)}
                className="w-full h-auto min-h-8 whitespace-normal leading-tight"
              >
                {currentPresetForEdit ? t('frequency.editCurrentPreset') : t('frequency.addCurrentPreset')}
              </Button>
              <Button
                size="sm"
                variant="flat"
                onPress={handleOpenVoicePresetSettings}
                className="w-full h-auto min-h-8 whitespace-normal leading-tight"
              >
                {t('frequency.managePresets')}
              </Button>
            </div>
          </div>
        )}
      </CardBody>

      <FrequencyPresetAddModal
        isOpen={isAddPresetModalOpen}
        presets={presets}
        initialMode="VOICE"
        initialRadioMode={currentRadioMode}
        initialFrequencyHz={currentFrequency}
        editingPreset={currentPresetForEdit}
        onClose={() => setIsAddPresetModalOpen(false)}
        onAdd={handleSaveCurrentFrequencyPreset}
        onDelete={handleDeleteCurrentFrequencyPreset}
      />
    </Card>
  );
};
