import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperatorRuntimeSlot } from '@tx5dr/contracts';
import { UserRole, WSMessageType } from '@tx5dr/contracts';
import { useCapabilityState, useConnection, useCurrentOperatorId, useOperators } from '../../store/radioStore';
import { useCan, useHasMinRole } from '../../store/authStore';
import { createLogger } from '../../utils/logger';
import { isCapabilityAvailable } from '../../radio-capability/availability';
import { dispatchOperatorForceStopRequested } from '../../utils/operatorForceStopEvents';
import { dispatchOperatorSlotShortcutFeedback } from '../../utils/operatorSlotShortcutFeedbackEvents';
import {
  getShortcutConfig,
  isKnownShortcutActionId,
  isTypingShortcutTarget,
  matchesShortcutEvent,
  normalizeShortcutConfig,
  SHORTCUT_ACTION_IDS,
  SHORTCUT_CONFIG_CHANGED_EVENT,
  type ShortcutActionId,
  type ShortcutConfig,
} from '../../utils/shortcutPreferences';

const logger = createLogger('GlobalShortcutBridge');

function actionIdToSlot(actionId: ShortcutActionId): OperatorRuntimeSlot | null {
  const match = /^select-tx-([1-6])$/.exec(actionId);
  return match ? (`TX${match[1]}` as OperatorRuntimeSlot) : null;
}

async function loadInitialShortcutConfig(): Promise<ShortcutConfig> {
  if (window.electronAPI?.shortcuts) {
    try {
      return normalizeShortcutConfig(await window.electronAPI.shortcuts.getConfig());
    } catch (error) {
      logger.warn('Failed to load Electron shortcut config, falling back to browser config', error);
    }
  }

  return getShortcutConfig();
}

export function GlobalShortcutBridge() {
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();
  const canOperate = useHasMinRole(UserRole.OPERATOR);
  const canStartStopEngine = useCan('execute', 'Engine');
  const canControlRadio = useCan('execute', 'RadioControl');
  const tunerSwitchState = useCapabilityState('tuner_switch');
  const tunerTuneState = useCapabilityState('tuner_tune');
  const [config, setConfig] = useState<ShortcutConfig>(() => getShortcutConfig());
  const configRef = useRef(config);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    void loadInitialShortcutConfig().then((loadedConfig) => {
      if (!cancelled) setConfig(loadedConfig);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleConfigChange = (event: Event) => {
      const detail = (event as CustomEvent<ShortcutConfig>).detail;
      setConfig(normalizeShortcutConfig(detail));
    };

    window.addEventListener(SHORTCUT_CONFIG_CHANGED_EVENT, handleConfigChange);
    return () => window.removeEventListener(SHORTCUT_CONFIG_CHANGED_EVENT, handleConfigChange);
  }, []);

  const runAction = useCallback((actionId: ShortcutActionId) => {
    const radioService = connection.state.radioService;
    if (!connection.state.isConnected || !radioService) return;

    if (actionId === 'start-monitoring') {
      if (canStartStopEngine) radioService.startDecoding();
      return;
    }

    if (actionId === 'stop-monitoring') {
      if (canStartStopEngine) radioService.stopDecoding();
      return;
    }

    if (actionId === 'run-tuner-tune') {
      const tunerEnabled = tunerSwitchState?.value === true;
      const tunerIsTuning = (tunerSwitchState?.meta as { status?: string } | undefined)?.status === 'tuning';
      if (canControlRadio && tunerEnabled && !tunerIsTuning && isCapabilityAvailable(tunerSwitchState) && isCapabilityAvailable(tunerTuneState)) {
        radioService.wsClientInstance.send(WSMessageType.WRITE_RADIO_CAPABILITY, { id: 'tuner_tune', action: true });
      }
      return;
    }

    if (actionId === 'toggle-tuner-switch') {
      if (canControlRadio && isCapabilityAvailable(tunerSwitchState)) {
        radioService.wsClientInstance.send(WSMessageType.WRITE_RADIO_CAPABILITY, { id: 'tuner_switch', value: tunerSwitchState?.value !== true });
      }
      return;
    }

    if (!canOperate) return;

    const activeOperator = operators.find(operator => operator.id === currentOperatorId) ?? operators[0] ?? null;
    const activeOperatorIndex = activeOperator
      ? Math.max(0, operators.findIndex(operator => operator.id === activeOperator.id))
      : -1;

    if (actionId === 'cycle-operator-next' || actionId === 'cycle-operator-previous') {
      if (operators.length === 0) return;
      const direction = actionId === 'cycle-operator-next' ? 1 : -1;
      const startIndex = activeOperatorIndex >= 0 ? activeOperatorIndex : 0;
      const nextIndex = (startIndex + direction + operators.length) % operators.length;
      setCurrentOperatorId(operators[nextIndex].id);
      return;
    }

    if (!activeOperator) return;

    if (actionId === 'toggle-current-operator-tx') {
      if (activeOperator.isTransmitting) {
        radioService.stopOperator(activeOperator.id);
      } else {
        radioService.startOperator(activeOperator.id);
      }
      return;
    }

    if (actionId === 'halt-current-operator-tx') {
      radioService.stopOperator(activeOperator.id);
      if (activeOperator.isInActivePTT) {
        dispatchOperatorForceStopRequested(activeOperator.id);
        radioService.removeOperatorFromTransmission(activeOperator.id);
      }
      return;
    }

    if (actionId === 'force-stop-all-transmission') {
      radioService.forceStopTransmission();
      return;
    }

    if (actionId === 'reset-current-operator-to-cq') {
      radioService.setOperatorContext(activeOperator.id, {
        targetCallsign: '',
        targetGrid: '',
        reportSent: 0,
        reportReceived: 0,
      });
      radioService.setOperatorRuntimeState(activeOperator.id, 'TX6');
      dispatchOperatorSlotShortcutFeedback(activeOperator.id, 'TX6');
      return;
    }

    const slot = actionIdToSlot(actionId);
    if (slot) {
      radioService.setOperatorRuntimeState(activeOperator.id, slot);
      dispatchOperatorSlotShortcutFeedback(activeOperator.id, slot);
    }
  }, [
    canControlRadio,
    canOperate,
    canStartStopEngine,
    connection.state.isConnected,
    connection.state.radioService,
    currentOperatorId,
    operators,
    setCurrentOperatorId,
    tunerSwitchState,
    tunerTuneState,
  ]);

  useEffect(() => {
    const electronShortcuts = window.electronAPI?.shortcuts;
    if (!electronShortcuts) return undefined;

    const handleCommand = (payload: { actionId?: unknown }) => {
      if (!isKnownShortcutActionId(payload?.actionId)) return;
      runAction(payload.actionId);
    };

    electronShortcuts.onCommand(handleCommand);
    return () => electronShortcuts.offCommand(handleCommand);
  }, [runAction]);

  useEffect(() => {
    if (window.electronAPI?.shortcuts) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isTypingShortcutTarget(event.target)) return;

      const matchedActionId = SHORTCUT_ACTION_IDS.find(actionId => (
        matchesShortcutEvent(event, configRef.current[actionId])
      ));
      if (!matchedActionId) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runAction(matchedActionId);
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [runAction]);

  return null;
}
