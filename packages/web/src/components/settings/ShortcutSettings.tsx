import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Chip, Switch } from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faKeyboard, faRotateLeft, faTrash } from '@fortawesome/free-solid-svg-icons';
import {
  createDisabledShortcutBinding,
  createShortcutBindingFromKeyboardEvent,
  DEFAULT_SHORTCUT_CONFIG,
  dispatchShortcutConfigChanged,
  dispatchShortcutTogglesChanged,
  findShortcutConflicts,
  formatShortcutBinding,
  getShortcutConfig,
  getShortcutToggles,
  isModifierOnlyShortcutEvent,
  normalizeShortcutConfig,
  normalizeShortcutToggles,
  saveShortcutConfig,
  saveShortcutToggles,
  shortcutTogglesEqual,
  type ShortcutActionId,
  type ShortcutConfig,
  type ShortcutToggles,
} from '../../utils/shortcutPreferences';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ShortcutSettings');

export interface ShortcutSettingsRef {
  hasUnsavedChanges: () => boolean;
  save: () => Promise<void>;
}

interface ShortcutSettingsProps {
  onUnsavedChanges?: (hasChanges: boolean) => void;
}

function configsEqual(left: ShortcutConfig, right: ShortcutConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const ACTION_LABEL_KEYS: Record<ShortcutActionId, string> = {
  'toggle-current-operator-tx': 'shortcuts.actions.toggleTx',
  'halt-current-operator-tx': 'shortcuts.actions.haltTx',
  'select-tx-1': 'shortcuts.actions.selectTx1',
  'select-tx-2': 'shortcuts.actions.selectTx2',
  'select-tx-3': 'shortcuts.actions.selectTx3',
  'select-tx-4': 'shortcuts.actions.selectTx4',
  'select-tx-5': 'shortcuts.actions.selectTx5',
  'select-tx-6': 'shortcuts.actions.selectTx6',
  'start-monitoring': 'shortcuts.actions.startMonitoring',
  'stop-monitoring': 'shortcuts.actions.stopMonitoring',
  'cycle-operator-next': 'shortcuts.actions.cycleOperatorNext',
  'cycle-operator-previous': 'shortcuts.actions.cycleOperatorPrevious',
  'reset-current-operator-to-cq': 'shortcuts.actions.resetToCQ',
  'force-stop-all-transmission': 'shortcuts.actions.forceStopAll',
  'run-tuner-tune': 'shortcuts.actions.runTunerTune',
  'toggle-tuner-switch': 'shortcuts.actions.toggleTunerSwitch',
};

const SHORTCUT_GROUPS: Array<{ titleKey: string; actionIds: ShortcutActionId[] }> = [
  {
    titleKey: 'shortcuts.groups.transmit',
    actionIds: ['toggle-current-operator-tx', 'halt-current-operator-tx', 'force-stop-all-transmission'],
  },
  {
    titleKey: 'shortcuts.groups.txSlots',
    actionIds: ['select-tx-1', 'select-tx-2', 'select-tx-3', 'select-tx-4', 'select-tx-5', 'select-tx-6'],
  },
  {
    titleKey: 'shortcuts.groups.monitoring',
    actionIds: ['start-monitoring', 'stop-monitoring'],
  },
  {
    titleKey: 'shortcuts.groups.operators',
    actionIds: ['cycle-operator-next', 'cycle-operator-previous', 'reset-current-operator-to-cq'],
  },
  {
    titleKey: 'shortcuts.groups.advanced',
    actionIds: ['run-tuner-tune', 'toggle-tuner-switch'],
  },
];

function actionLabelKey(actionId: ShortcutActionId): string {
  return ACTION_LABEL_KEYS[actionId] ?? 'shortcuts.actions.unknown';
}

export const ShortcutSettings = forwardRef<ShortcutSettingsRef, ShortcutSettingsProps>(
  ({ onUnsavedChanges }, ref) => {
    const { t } = useTranslation('settings');
    const isElectron = Boolean(window.electronAPI?.shortcuts);
    const [draftConfig, setDraftConfig] = useState<ShortcutConfig>(() => getShortcutConfig());
    const [originalConfig, setOriginalConfig] = useState<ShortcutConfig>(() => getShortcutConfig());
    const [draftToggles, setDraftToggles] = useState<ShortcutToggles>(() => getShortcutToggles());
    const [originalToggles, setOriginalToggles] = useState<ShortcutToggles>(() => getShortcutToggles());
    const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId | null>(null);
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [failedRegistrations, setFailedRegistrations] = useState<Array<{ actionId: ShortcutActionId; accelerator: string; reason: string }>>([]);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        try {
          const electronShortcuts = window.electronAPI?.shortcuts;
          const loadedConfig = electronShortcuts
            ? normalizeShortcutConfig(await electronShortcuts.getConfig())
            : getShortcutConfig();
          const loadedToggles = electronShortcuts
            ? normalizeShortcutToggles(await electronShortcuts.getToggles())
            : getShortcutToggles();
          if (cancelled) return;
          setDraftConfig(loadedConfig);
          setOriginalConfig(loadedConfig);
          setDraftToggles(loadedToggles);
          setOriginalToggles(loadedToggles);
        } catch (error) {
          logger.warn('Failed to load shortcut settings', error);
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [isElectron]);

    const hasUnsavedChanges = useCallback(() => (
      !configsEqual(draftConfig, originalConfig)
      || !shortcutTogglesEqual(draftToggles, originalToggles)
    ), [draftConfig, draftToggles, originalConfig, originalToggles]);

    useEffect(() => {
      onUnsavedChanges?.(hasUnsavedChanges());
    }, [draftConfig, hasUnsavedChanges, onUnsavedChanges]);

    const conflicts = useMemo(() => findShortcutConflicts(draftConfig), [draftConfig]);

    const save = useCallback(async () => {
      const currentConflicts = findShortcutConflicts(draftConfig);
      if (currentConflicts.length > 0) {
        const message = t('shortcuts.conflictError');
        setErrorMessage(message);
        throw new Error(message);
      }

      setIsSaving(true);
      setErrorMessage('');
      setFailedRegistrations([]);

      try {
        const normalized = normalizeShortcutConfig(draftConfig);
        const normalizedToggles = normalizeShortcutToggles(draftToggles);
        if (isElectron && window.electronAPI?.shortcuts) {
          await window.electronAPI.shortcuts.setToggles(normalizedToggles);
          const status = await window.electronAPI.shortcuts.setConfig(normalized);
          const nextConfig = normalizeShortcutConfig(status.config);
          setDraftConfig(nextConfig);
          setOriginalConfig(nextConfig);
          setDraftToggles(normalizedToggles);
          setOriginalToggles(normalizedToggles);
          setFailedRegistrations(status.failed);
          dispatchShortcutConfigChanged(nextConfig);
          dispatchShortcutTogglesChanged(normalizedToggles);

          if (status.failed.length > 0) {
            addToast({
              title: t('shortcuts.savePartialTitle'),
              description: t('shortcuts.savePartialDesc'),
              color: 'warning',
            });
          } else {
            addToast({ title: t('shortcuts.saveSuccess'), color: 'success' });
          }
        } else {
          const nextConfig = saveShortcutConfig(normalized);
          saveShortcutToggles(normalizedToggles);
          setDraftConfig(nextConfig);
          setOriginalConfig(nextConfig);
          setDraftToggles(normalizedToggles);
          setOriginalToggles(normalizedToggles);
          addToast({ title: t('shortcuts.saveSuccess'), color: 'success' });
        }
      } catch (error) {
        logger.error('Failed to save shortcut settings', error);
        const message = error instanceof Error ? error.message : t('shortcuts.saveFailed');
        setErrorMessage(message);
        throw error;
      } finally {
        setIsSaving(false);
      }
    }, [draftConfig, draftToggles, isElectron, t]);

    useImperativeHandle(ref, () => ({
      hasUnsavedChanges,
      save,
    }));

    useEffect(() => {
      if (!recordingActionId) return undefined;

      const electronShortcuts = window.electronAPI?.shortcuts;

      const commitBinding = (binding: ShortcutConfig[ShortcutActionId]) => {
        setDraftConfig(prev => ({
          ...prev,
          [recordingActionId]: binding,
        }));
        setErrorMessage('');
        setRecordingActionId(null);
      };

      if (electronShortcuts) {
        const handleRecorded = (payload: { actionId: ShortcutActionId; binding: ShortcutConfig[ShortcutActionId] }) => {
          if (payload.actionId !== recordingActionId) return;
          commitBinding(payload.binding);
        };
        const handleCancelled = (payload: { actionId: ShortcutActionId }) => {
          if (payload.actionId !== recordingActionId) return;
          setRecordingActionId(null);
        };

        electronShortcuts.onRecorded(handleRecorded);
        electronShortcuts.onRecordingCancelled(handleCancelled);
        void electronShortcuts.startRecording(recordingActionId).catch((error) => {
          logger.warn('Failed to start Electron shortcut recording', error);
          setErrorMessage(t('shortcuts.saveFailed'));
          setRecordingActionId(null);
        });

        return () => {
          electronShortcuts.offRecorded(handleRecorded);
          electronShortcuts.offRecordingCancelled(handleCancelled);
          void electronShortcuts.stopRecording().catch((error) => {
            logger.warn('Failed to stop Electron shortcut recording', error);
          });
        };
      }

      const suppressEvent = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        suppressEvent(event);

        if (event.key === 'Escape') {
          setRecordingActionId(null);
          return;
        }

        if (isModifierOnlyShortcutEvent(event)) {
          return;
        }

        const binding = createShortcutBindingFromKeyboardEvent(event);
        if (!binding) {
          setErrorMessage(t('shortcuts.requireModifier'));
          return;
        }

        commitBinding(binding);
      };

      window.addEventListener('keydown', handleKeyDown, { capture: true });
      return () => {
        window.removeEventListener('keydown', handleKeyDown, { capture: true });
      };
    }, [recordingActionId, t]);

    const updateAction = useCallback((actionId: ShortcutActionId, update: ShortcutConfig[ShortcutActionId]) => {
      setDraftConfig(prev => ({ ...prev, [actionId]: update }));
      setErrorMessage('');
      setFailedRegistrations([]);
    }, []);

    const handleResetDefaults = useCallback(() => {
      const defaults = normalizeShortcutConfig(DEFAULT_SHORTCUT_CONFIG);
      setDraftConfig(defaults);
      setErrorMessage('');
      setFailedRegistrations([]);
    }, []);

    const handleRecordButtonPress = useCallback((actionId: ShortcutActionId) => {
      setRecordingActionId(prev => (prev === actionId ? null : actionId));
    }, []);

    const handleClearAction = useCallback((actionId: ShortcutActionId) => {
      setRecordingActionId(prev => (prev === actionId ? null : prev));
      updateAction(actionId, createDisabledShortcutBinding());
    }, [updateAction]);

    const updateToggles = useCallback((update: Partial<ShortcutToggles>) => {
      setDraftToggles(prev => normalizeShortcutToggles({ ...prev, ...update }));
      setErrorMessage('');
      setFailedRegistrations([]);
    }, []);

    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-default-900">{t('shortcuts.title')}</h3>
          <p className="text-xs leading-5 text-default-500">{t('shortcuts.description')}</p>
        </div>

        <Alert color={isElectron ? 'primary' : 'warning'} variant="flat" className="text-xs">
          {isElectron ? t('shortcuts.electronScope') : t('shortcuts.browserScope')}
        </Alert>

        {errorMessage && (
          <Alert color="danger" variant="flat" className="text-xs">
            {errorMessage}
          </Alert>
        )}

        {conflicts.length > 0 && (
          <Alert color="danger" variant="flat" className="text-xs">
            {t('shortcuts.conflictError')}
          </Alert>
        )}

        {failedRegistrations.length > 0 && (
          <Alert color="warning" variant="flat" className="text-xs">
            <div className="space-y-1">
              <div>{t('shortcuts.registrationFailed')}</div>
              {failedRegistrations.map(item => (
                <div key={`${item.actionId}-${item.accelerator}`} className="font-mono text-xs">
                  {t(actionLabelKey(item.actionId))}: {item.accelerator} ({item.reason})
                </div>
              ))}
            </div>
          </Alert>
        )}

        <div className="overflow-hidden rounded-medium border border-divider bg-content1">
          <div className="divide-y divide-divider">
            <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium text-default-900">{t('shortcuts.masterEnabled')}</div>
                <div className="text-xs leading-5 text-default-500">{t('shortcuts.masterEnabledDescription')}</div>
              </div>
              <Switch
                size="sm"
                color="primary"
                className="shrink-0"
                aria-label={t('shortcuts.masterEnabled')}
                isDisabled={isSaving}
                isSelected={draftToggles.enabled}
                onValueChange={(isSelected) => updateToggles({ enabled: isSelected })}
              />
            </div>
            <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium text-default-900">{t('shortcuts.globalEnabled')}</div>
                <div className="text-xs leading-5 text-default-500">
                  {isElectron ? t('shortcuts.globalEnabledDescription') : t('shortcuts.globalEnabledBrowserDescription')}
                </div>
              </div>
              <Switch
                size="sm"
                color="primary"
                className="shrink-0"
                aria-label={t('shortcuts.globalEnabled')}
                isDisabled={isSaving || !isElectron || !draftToggles.enabled}
                isSelected={draftToggles.globalEnabled}
                onValueChange={(isSelected) => updateToggles({ globalEnabled: isSelected })}
              />
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-medium border border-divider bg-content1">
          <div className="divide-y divide-divider">
            {SHORTCUT_GROUPS.map(group => (
              <div key={group.titleKey}>
                <div className="bg-default-50 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-default-500">
                  {t(group.titleKey)}
                </div>
                <div className="divide-y divide-divider">
                  {group.actionIds.map(actionId => {
                    const binding = draftConfig[actionId];
                    const isRecording = recordingActionId === actionId;
                    return (
                      <div key={actionId} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-sm font-medium text-default-900">{t(actionLabelKey(actionId))}</div>
                          <div className="text-xs leading-5 text-default-500">{t(`shortcuts.actionDescriptions.${actionId}`)}</div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <Chip
                            size="sm"
                            variant="flat"
                            color={binding.enabled ? 'primary' : 'default'}
                          className="font-mono text-xs"
                        >
                          {isRecording
                            ? t('shortcuts.recording')
                            : binding.enabled
                              ? formatShortcutBinding(binding)
                              : t('shortcuts.disabled')}
                        </Chip>
                          <Button
                            size="sm"
                            variant={isRecording ? 'solid' : 'flat'}
                            color={isRecording ? 'primary' : 'default'}
                            isDisabled={isSaving}
                            onPress={() => handleRecordButtonPress(actionId)}
                            className="h-7 min-w-0 px-2 text-xs"
                            startContent={<FontAwesomeIcon icon={faKeyboard} className="text-[10px]" />}
                          >
                            {isRecording ? t('shortcuts.pressShortcut') : t('shortcuts.record')}
                          </Button>
                          <Button
                            size="sm"
                            variant="light"
                            isIconOnly
                            isDisabled={isSaving}
                            onPress={() => handleClearAction(actionId)}
                            className="h-7 w-7 min-w-0"
                            aria-label={t('shortcuts.clear')}
                          >
                            <FontAwesomeIcon icon={faTrash} className="text-[10px]" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="flat"
            onPress={handleResetDefaults}
            isDisabled={isSaving}
            className="h-8 text-xs"
            startContent={<FontAwesomeIcon icon={faRotateLeft} className="text-xs" />}
          >
            {t('shortcuts.restoreDefaults')}
          </Button>
        </div>
      </div>
    );
  }
);

ShortcutSettings.displayName = 'ShortcutSettings';
