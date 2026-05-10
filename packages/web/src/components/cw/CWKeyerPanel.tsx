import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Alert,
  Input,
  Textarea,
  Switch,
  Slider,
  Select,
  SelectItem,
  Tabs,
  Tab,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  useDisclosure,
  Chip,
  Tooltip,
} from '@heroui/react';
import { addToast } from '@heroui/toast';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPlay,
  faStop,
  faPen,
  faTrash,
  faPaperPlane,
  faRepeat,
  faTowerBroadcast,
  faPlug,
  faPlus,
  faMinus,
  faChevronDown,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import { useOperators, useCurrentOperatorId, useRadioState } from '../../store/radioStore';
import { CWSidetone } from './CWSidetone';
import {
  getCWKeyerShortcutPresetsForCallsign,
  saveCWKeyerSlotShortcutPreset,
  matchesCWKeyerShortcut,
  CW_KEYER_SHORTCUT_PRESETS,
  CW_KEYER_SHORTCUT_NONE,
  CW_KEYER_SHORTCUT_CHANGED_EVENT,
} from '../../utils/cwKeyerShortcutPreferences';
import type { CWKeyerBackend, CWKeyerConfig, CWMessagePanel, CWMessageSlot } from '@tx5dr/contracts';
import type { CWKeyerShortcutPreset, CWKeyerShortcutChangedDetail } from '../../utils/cwKeyerShortcutPreferences';

const WPM_MIN = 5;
const WPM_MAX = 60;
const CW_ALERT_CLASS_NAMES = {
  base: '!flex-none !grow-0 py-2.5 px-3',
  mainWrapper: '!h-auto !min-h-0 justify-center',
  title: 'text-sm leading-5',
  description: 'text-xs leading-4',
  iconWrapper: 'w-8 h-8',
  alertIcon: 'w-5',
} as const;

interface CWKeyerPanelProps {
  embedded?: boolean;
}

export function CWKeyerPanel({ embedded = false }: CWKeyerPanelProps = {}) {
  const { t } = useTranslation();
  const { cwKeyerStatus, cwConfig, isCWMode, sendText, playMessage, stopMessage } = useCWKeyer();
  const radioState = useRadioState();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();

  const textInputRef = useRef<HTMLDivElement>(null);
  const [textInput, setTextInput] = useState('');
  const [lastSentText, setLastSentText] = useState<string | null>(null);
  const [panel, setPanel] = useState<CWMessagePanel | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [editingSlot, setEditingSlot] = useState<CWMessageSlot | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editText, setEditText] = useState('');
  const [editRepeatEnabled, setEditRepeatEnabled] = useState(false);
  const [editRepeatInterval, setEditRepeatInterval] = useState(5);
  const { isOpen, onOpen, onClose } = useDisclosure();
  const [slotShortcuts, setSlotShortcuts] = useState<Record<string, CWKeyerShortcutPreset>>({});
  const [shortcutMenuSlotId, setShortcutMenuSlotId] = useState<string | null>(null);
  const [loadedConfig, setLoadedConfig] = useState<CWKeyerConfig | null>(null);

  // WPM 本地状态，跟随 cwConfig 变化
  const [wpm, setWpm] = useState(cwConfig?.wpm ?? 20);
  const effectiveConfig = cwConfig ?? loadedConfig;
  const backend: CWKeyerBackend = effectiveConfig?.backend ?? 'cat';
  const isSerialBackend = backend === 'serial';
  const serialKeyPort = effectiveConfig?.keyPort?.trim() ?? '';
  const showSerialPortAlert = isSerialBackend && !serialKeyPort;
  const radioConnected = radioState.state.radioConnected;
  const radioConfigType = radioState.state.radioConfig?.type;
  const isHamlibRadioConfig = radioConfigType === 'serial' || radioConfigType === 'network';
  const catUnavailableReason = !radioConnected
    ? t('radio:cw.catUnavailableDisconnected', 'Connect a Hamlib radio before using CAT CW.')
    : !isHamlibRadioConfig
      ? t('radio:cw.catUnavailableHamlibOnly', 'CAT CW currently supports Hamlib serial or network radio connections only.')
      : cwKeyerStatus?.backend === 'cat' && cwKeyerStatus.backendAvailable === false
        ? cwKeyerStatus.backendError
        : null;
  const showCatAlert = backend === 'cat' && Boolean(catUnavailableReason);

  useEffect(() => {
    if (!isCWMode) return;
    let cancelled = false;
    api.getCWKeyerConfig()
      .then((resp) => {
        if (!cancelled) setLoadedConfig(resp.config);
      })
      .catch(() => {
        // Keep default CAT mode if the config endpoint is temporarily unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, [isCWMode]);

  useEffect(() => {
    if (effectiveConfig) {
      setWpm(effectiveConfig.wpm);
    }
  }, [effectiveConfig]);

  const myCallsign = operators.find(o => o.id === currentOperatorId)?.context?.myCall?.trim() || '';

  const isActive = cwKeyerStatus?.active ?? false;
  const statusMode = cwKeyerStatus?.mode ?? 'idle';
  const playingSlotId = (statusMode === 'playing' || statusMode === 'repeat-waiting')
    ? cwKeyerStatus?.messageId ?? null
    : null;
  // 手动文字发射中（非预设报文）
  const isManualTextPlaying = isActive && statusMode === 'playing' && !cwKeyerStatus?.messageId;

  // 加载报文面板
  const loadPanel = useCallback(async () => {
    if (!myCallsign) return;
    setPanelLoading(true);
    try {
      const resp = await api.getCWMessagePanel(myCallsign);
      setPanel(resp.panel);
    } catch {
      // 静默处理
    } finally {
      setPanelLoading(false);
    }
  }, [myCallsign]);

  useEffect(() => {
    if (isCWMode && myCallsign) {
      loadPanel();
    }
  }, [isCWMode, myCallsign, loadPanel]);

  const visibleSlots = panel?.slots.slice(0, panel.slotCount) ?? [];
  const canIncreaseSlots = (panel?.slotCount ?? 0) < (panel?.maxSlotCount ?? 12);
  const canDecreaseSlots = (panel?.slotCount ?? 3) > 3;

  // 加载快捷键预设
  useEffect(() => {
    if (!myCallsign || !panel?.slots) return;
    const presets = getCWKeyerShortcutPresetsForCallsign(myCallsign, panel.slots);
    setSlotShortcuts(presets);
  }, [myCallsign, panel?.slots]);

  // 跨组件快捷键变更同步
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<CWKeyerShortcutChangedDetail>).detail;
      if (!detail || detail.callsign !== myCallsign?.trim().toUpperCase()) return;
      setSlotShortcuts(prev => ({ ...prev, [detail.slotId]: detail.preset }));
    };
    window.addEventListener(CW_KEYER_SHORTCUT_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CW_KEYER_SHORTCUT_CHANGED_EVENT, handler);
  }, [myCallsign]);

  // 快捷键菜单关闭（外部点击/Escape）
  useEffect(() => {
    if (!shortcutMenuSlotId) return undefined;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-cw-keyer-shortcut-menu]')) return;
      setShortcutMenuSlotId(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutMenuSlotId(null);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [shortcutMenuSlotId]);

  // 全局键盘监听器（捕获 F 键快捷键）
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === 'Escape' && isActive) {
        event.preventDefault();
        stopMessage();
        return;
      }

      if (!isCWMode || !myCallsign) return;

      const slot = visibleSlots.find(candidate =>
        matchesCWKeyerShortcut(event.code, slotShortcuts[candidate.id] ?? CW_KEYER_SHORTCUT_NONE),
      );

      if (!slot || !slot.text || isActive) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      playMessage(myCallsign, slot.id, slot.repeatEnabled);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [isActive, isCWMode, myCallsign, playMessage, slotShortcuts, stopMessage, visibleSlots]);

  // 更新快捷键预设
  const updateSlotShortcut = useCallback((slot: CWMessageSlot, preset: CWKeyerShortcutPreset) => {
    if (!myCallsign) return;
    const nextShortcuts = { ...slotShortcuts };
    const changes: Array<{ slotId: string; preset: CWKeyerShortcutPreset }> = [];

    if (preset !== CW_KEYER_SHORTCUT_NONE) {
      for (const candidate of panel?.slots ?? []) {
        if (candidate.id !== slot.id && nextShortcuts[candidate.id] === preset) {
          nextShortcuts[candidate.id] = CW_KEYER_SHORTCUT_NONE;
          changes.push({ slotId: candidate.id, preset: CW_KEYER_SHORTCUT_NONE });
        }
      }
    }

    nextShortcuts[slot.id] = preset;
    changes.push({ slotId: slot.id, preset });

    setSlotShortcuts(nextShortcuts);
    for (const change of changes) {
      saveCWKeyerSlotShortcutPreset(myCallsign, change.slotId, change.preset);
    }
    setShortcutMenuSlotId(null);
  }, [myCallsign, panel?.slots, slotShortcuts]);

  const getShortcutLabel = (preset: CWKeyerShortcutPreset): string => {
    return preset === CW_KEYER_SHORTCUT_NONE ? (t('radio:cw.shortcutNone') || '-') : preset;
  };

  // 发送文本
  const handleSendText = () => {
    const trimmed = textInput.trim();
    if (!trimmed || (isActive && statusMode !== 'idle')) return;
    sendText(trimmed, myCallsign || undefined);
    setLastSentText(trimmed);
    setTextInput('');
    requestAnimationFrame(() => {
      const el = textInputRef.current;
      if (el) {
        const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
        (input as HTMLInputElement)?.focus();
      }
    });
  };

  // 处理回车键
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isActive && statusMode !== 'idle') return;
      handleSendText();
    }
  };

  // WPM 变更
  const handleWpmChange = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    setWpm(v);
  };

  const handleWpmChangeEnd = (value: number | number[]) => {
    const v = Array.isArray(value) ? value[0] : value;
    void api.updateCWKeyerConfig({ wpm: v }).then((resp) => setLoadedConfig(resp.config));
  };

  const handleBackendChange = (key: React.Key) => {
    const nextBackend: CWKeyerBackend = key === 'serial' ? 'serial' : 'cat';
    setLoadedConfig((prev) => ({
      backend: nextBackend,
      keyPort: prev?.keyPort ?? effectiveConfig?.keyPort ?? '',
      keyMethod: prev?.keyMethod ?? effectiveConfig?.keyMethod ?? 'dtr',
      wpm: prev?.wpm ?? effectiveConfig?.wpm ?? wpm,
    }));
    void api.updateCWKeyerConfig({ backend: nextBackend })
      .then((resp) => setLoadedConfig(resp.config))
      .catch((err) => {
        addToast({
          title: t('common:error'),
          description: String(err),
          color: 'danger',
        });
      });
  };

  // 调整 Slot 数量
  const handleSlotCountChange = async (delta: number) => {
    if (!myCallsign || !panel) return;
    const newCount = panel.slotCount + delta;
    try {
      const resp = await api.updateCWMessagePanel(myCallsign, { slotCount: newCount });
      setPanel(resp.panel);
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
    }
  };

  // 打开编辑对话框
  const openEditSlot = (slot: CWMessageSlot) => {
    setEditingSlot(slot);
    setEditLabel(slot.label);
    setEditText(slot.text);
    setEditRepeatEnabled(slot.repeatEnabled);
    setEditRepeatInterval(slot.repeatIntervalSec);
    onOpen();
  };

  // 保存报文
  const handleSaveSlot = async () => {
    if (!editingSlot || !myCallsign) return;
    try {
      const resp = await api.updateCWMessageSlot(myCallsign, editingSlot.id, {
        label: editLabel,
        text: editText,
        repeatEnabled: editRepeatEnabled,
        repeatIntervalSec: editRepeatInterval,
      });
      setPanel(resp.panel);
      onClose();
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
    }
  };

  // 删除报文文本
  const handleDeleteSlot = async (slot: CWMessageSlot) => {
    if (!myCallsign) return;
    try {
      const resp = await api.deleteCWMessageSlot(myCallsign, slot.id);
      setPanel(resp.panel);
    } catch (err) {
      addToast({
        title: t('common:error'),
        description: String(err),
        color: 'danger',
      });
    }
  };

  // 播放报文
  const handlePlay = (slot: CWMessageSlot, repeat: boolean) => {
    if (!myCallsign || !slot.text) return;
    playMessage(myCallsign, slot.id, repeat);
  };

  if (!isCWMode) return null;

  const panelContent = (
    <>
      <div className={`flex items-center justify-between gap-2 ${embedded ? 'px-1 pb-2' : 'px-3 py-3'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <FontAwesomeIcon icon={faTowerBroadcast} className="text-primary" />
          <span className="font-semibold">{t('radio:cw.title', 'CW')}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Tabs
            size="sm"
            variant="solid"
            selectedKey={backend}
            onSelectionChange={handleBackendChange}
            aria-label={t('radio:cw.backendTabs', 'CW backend')}
            classNames={{
              base: 'shrink-0',
              tabList: 'h-7 gap-0 p-0.5',
              tab: 'h-6 px-2 min-w-7',
              tabContent: 'text-xs',
            }}
          >
            <Tab
              key="cat"
              title={(
                <span className="flex items-center gap-1">
                  <FontAwesomeIcon icon={faTowerBroadcast} className="text-[10px]" />
                  <span className="hidden sm:inline">{t('radio:cw.backendCat', 'CAT message')}</span>
                </span>
              )}
            />
            <Tab
              key="serial"
              title={(
                <span className="flex items-center gap-1">
                  <FontAwesomeIcon icon={faPlug} className="text-[10px]" />
                  <span className="hidden sm:inline">{t('radio:cw.backendSerial', 'Serial keyer')}</span>
                </span>
              )}
            />
          </Tabs>
          {operators.length > 1 && (
            <Select
              size="sm"
              variant="flat"
              aria-label={t('radio:cw.operator', 'Operator')}
              selectedKeys={currentOperatorId ? [currentOperatorId] : []}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                if (selected) setCurrentOperatorId(selected);
              }}
              className="w-28"
              classNames={{ trigger: 'h-7 min-h-7 px-2', value: 'font-mono text-xs' }}
            >
              {operators.map((op) => (
                <SelectItem key={op.id} textValue={op.context?.myCall || op.id}>
                  {op.context?.myCall || op.id}
                </SelectItem>
              ))}
            </Select>
          )}
          {isActive && (
            <Chip size="sm" variant="flat" color="success">
              {statusMode === 'keying' ? 'KEYING' : statusMode === 'playing' ? 'TX' : statusMode}
            </Chip>
          )}
        </div>
      </div>

      <CWSidetone />

      <div className={`flex flex-col gap-3 ${embedded ? 'flex-1 min-h-0 overflow-hidden px-1 pb-1' : 'px-3 pb-3'}`}>
        {showSerialPortAlert && (
          <Alert
            color="warning"
            variant="flat"
            title={t('radio:cw.serialPortMissingTitle', 'CW serial port is not configured')}
            classNames={CW_ALERT_CLASS_NAMES}
          >
            <span className="text-xs leading-4">
              {t('radio:cw.serialPortMissingBody', 'Serial keying is selected, but no CW key port is configured. Set the CW key port in the radio profile before using the serial keyer.')}
            </span>
          </Alert>
        )}

        {showCatAlert && (
          <Alert
            color="warning"
            variant="flat"
            title={t('radio:cw.catUnavailableTitle', 'CAT CW is not available')}
            classNames={CW_ALERT_CLASS_NAMES}
          >
            <span className="text-xs leading-4">
              {catUnavailableReason || t('radio:cw.catUnavailableBody', 'Connect a Hamlib radio that supports CAT Morse sending before using this backend.')}
            </span>
          </Alert>
        )}

        {/* 文字输入区 */}
        <div className="flex gap-2">
          <Input
            ref={textInputRef}
            value={textInput}
            onValueChange={setTextInput}
            onKeyDown={handleKeyDown}
            placeholder={t('radio:cw.textInputPlaceholder', 'Enter CW text...')}
            className="flex-1"
            endContent={
              <Button
                isIconOnly
                size="sm"
                variant="light"
                onPress={handleSendText}
                isDisabled={!textInput.trim() || (isActive && statusMode !== 'idle')}
              >
                <FontAwesomeIcon icon={faPaperPlane} />
              </Button>
            }
          />
          {isActive && (
            <Button
              color="danger"
              variant="flat"
              isIconOnly
              onPress={stopMessage}
            >
              <FontAwesomeIcon icon={faStop} />
            </Button>
          )}
        </div>

        {/* 当前/上次发射文字指示 */}
        {lastSentText && (
          <div className={`flex items-center gap-2 p-2 rounded-lg border text-sm font-mono ${
            isManualTextPlaying
              ? 'border-success bg-success-50 dark:bg-success-100/10'
              : 'border-default-200 bg-default-50'
          }`}>
            <Chip size="sm" color={isManualTextPlaying ? 'success' : 'default'} variant="flat">
              {isManualTextPlaying ? 'TX' : t('radio:cw.lastSent', 'Last')}
            </Chip>
            <span className="truncate flex-1">{lastSentText}</span>
          </div>
        )}

        {/* 速度与侧音设置 */}
        <div className="flex flex-col gap-2 p-2 rounded-lg border border-default-200 bg-default-50">
          <div className="flex items-center gap-3">
            <span className="text-xs text-default-600 w-10 shrink-0">{t('radio:cw.wpm', 'WPM')}</span>
            <Slider
              size="sm"
              step={1}
              minValue={WPM_MIN}
              maxValue={WPM_MAX}
              value={wpm}
              onChange={handleWpmChange}
              onChangeEnd={handleWpmChangeEnd}
              className="flex-1"
              aria-label={t('radio:cw.wpm', 'WPM')}
            />
            <span className="text-xs text-default-800 w-10 text-right font-mono">{wpm}</span>
          </div>
        </div>

        {/* 预设报文区 */}
        <div className={embedded ? 'flex flex-1 min-h-0 flex-col' : undefined}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-default-600">
              {t('radio:cw.presetMessages', 'Presets')}
            </span>
            <div className="flex items-center gap-1">
              <span className="text-xs text-default-400 mr-1">{panel?.slotCount ?? 0}</span>
              <Tooltip content={t('radio:cw.decreaseSlots', 'Remove slot')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  onPress={() => handleSlotCountChange(-1)}
                  isDisabled={!canDecreaseSlots}
                >
                  <FontAwesomeIcon icon={faMinus} className="text-xs" />
                </Button>
              </Tooltip>
              <Tooltip content={t('radio:cw.increaseSlots', 'Add slot')}>
                <Button
                  isIconOnly
                  size="sm"
                  variant="light"
                  onPress={() => handleSlotCountChange(1)}
                  isDisabled={!canIncreaseSlots}
                >
                  <FontAwesomeIcon icon={faPlus} className="text-xs" />
                </Button>
              </Tooltip>
            </div>
          </div>

          {panelLoading ? (
            <div className="text-center text-default-400 text-sm py-4">
              {t('common:loading', 'Loading...')}
            </div>
          ) : (
            <div className={`flex flex-col gap-1.5 overflow-y-auto ${embedded ? 'flex-1 min-h-0 pr-1' : 'max-h-64'}`}>
              {visibleSlots.map((slot) => {
                  const isSlotPlaying = playingSlotId === slot.id;
                  const isRepeatWaiting = statusMode === 'repeat-waiting' && cwKeyerStatus?.messageId === slot.id;

                  return (
                <div
                  key={slot.id}
                  className={`flex items-center gap-2 p-2 rounded-lg border transition-colors ${
                    isSlotPlaying
                      ? 'border-success bg-success-50 dark:bg-success-100/10'
                      : isRepeatWaiting
                        ? 'border-warning bg-warning-50 dark:bg-warning-100/10'
                        : 'border-default-200 hover:border-primary-200'
                  }`}
                >
                  <span className="text-xs text-default-500 w-6 text-right shrink-0">
                    {slot.index}
                  </span>
                  <span className="text-xs font-mono text-default-400 w-8 shrink-0 text-center">
                    {getShortcutLabel(slotShortcuts[slot.id] ?? CW_KEYER_SHORTCUT_NONE)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{slot.label}</div>
                    <div className="text-xs text-default-400 truncate">
                      {slot.text || '\u2014'}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {slot.text && (
                      <>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="light"
                          onPress={() => handlePlay(slot, false)}
                          isDisabled={isActive}
                        >
                          <FontAwesomeIcon icon={faPlay} className="text-sm" />
                        </Button>
                        {slot.repeatEnabled && (
                          <Button
                            isIconOnly
                            size="sm"
                            variant="light"
                            color="secondary"
                            onPress={() => handlePlay(slot, true)}
                            isDisabled={isActive}
                          >
                            <FontAwesomeIcon icon={faRepeat} className="text-sm" />
                          </Button>
                        )}
                      </>
                    )}
                    <Button
                      isIconOnly
                      size="sm"
                      variant="light"
                      onPress={() => openEditSlot(slot)}
                      isDisabled={isActive}
                    >
                      <FontAwesomeIcon icon={faPen} className="text-xs" />
                    </Button>
                    {slot.text && (
                      <Button
                        isIconOnly
                        size="sm"
                        variant="light"
                        color="danger"
                        onPress={() => handleDeleteSlot(slot)}
                        isDisabled={isActive}
                      >
                        <FontAwesomeIcon icon={faTrash} className="text-xs" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
              {visibleSlots.length === 0 && (
                <div className="text-center text-default-400 text-sm py-4">
                  {t('radio:cw.noMessages', 'No messages configured')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 编辑对话框 */}
      <Modal isOpen={isOpen} onClose={onClose} size="md">
        <ModalContent>
          <ModalHeader>
            {t('radio:cw.editMessage', 'Edit Message')} — {editingSlot?.label}
          </ModalHeader>
          <ModalBody className="flex flex-col gap-3">
            <Input
              label={t('radio:cw.messageLabel', 'Label')}
              value={editLabel}
              onValueChange={setEditLabel}
              maxLength={32}
            />
            <Textarea
              label={t('radio:cw.messageText', 'Text')}
              value={editText}
              onValueChange={setEditText}
              maxLength={500}
              minRows={3}
              placeholder={t('radio:cw.messageTextPlaceholder', 'CQ CQ CQ DE {{callsign}}', { callsign: myCallsign })}
            />
            <div className="flex items-center gap-3">
              <Switch
                isSelected={editRepeatEnabled}
                onValueChange={setEditRepeatEnabled}
              >
                {t('radio:cw.repeat', 'Repeat')}
              </Switch>
              {editRepeatEnabled && (
                <Input
                  type="number"
                  label={t('radio:cw.repeatInterval', 'Interval (s)')}
                  value={String(editRepeatInterval)}
                  onValueChange={(v) => setEditRepeatInterval(Math.max(1, Math.min(300, Number(v) || 5)))}
                  className="w-28"
                  size="sm"
                />
              )}
            </div>
            <div className="flex items-center gap-2" data-cw-keyer-shortcut-menu>
              <span className="text-sm text-default-600">{t('radio:cw.shortcutSelectAria', { slot: editingSlot?.index ?? '' })}:</span>
              <div className="relative">
                <Button
                  size="sm"
                  variant="flat"
                  className="min-w-12 h-8 font-mono text-xs"
                  endContent={<FontAwesomeIcon icon={faChevronDown} className="text-xs" />}
                  onPress={() => {
                    if (!editingSlot) return;
                    setShortcutMenuSlotId(current => current === editingSlot.id ? null : editingSlot.id);
                  }}
                >
                  {getShortcutLabel(editingSlot ? (slotShortcuts[editingSlot.id] ?? CW_KEYER_SHORTCUT_NONE) : CW_KEYER_SHORTCUT_NONE)}
                </Button>
                {shortcutMenuSlotId === editingSlot?.id && (
                  <div className="absolute bottom-full left-0 z-50 mb-1 min-w-16 rounded-md border border-divider bg-content1 p-1 shadow-lg">
                    {CW_KEYER_SHORTCUT_PRESETS.map((preset) => {
                      const selected = preset === (editingSlot ? slotShortcuts[editingSlot.id] : CW_KEYER_SHORTCUT_NONE);
                      return (
                        <button
                          key={preset}
                          type="button"
                          className={`flex items-center justify-between w-full rounded-md px-2 py-1 text-xs hover:bg-default-100 ${selected ? 'font-semibold text-primary' : ''}`}
                          onClick={() => {
                            if (!editingSlot) return;
                            updateSlotShortcut(editingSlot, preset);
                          }}
                        >
                          <span>{getShortcutLabel(preset)}</span>
                          {selected && <span className="ml-2 text-primary">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={onClose}>
              {t('common:cancel', 'Cancel')}
            </Button>
            <Button color="primary" onPress={handleSaveSlot}>
              {t('common:save', 'Save')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );

  if (embedded) {
    return (
      <div className="h-full min-h-0 w-full overflow-hidden rounded-lg border border-default-200 bg-default-50 px-2 py-2 pt-1.5 transition-colors dark:border-default-100 dark:bg-default-100/50">
        <div className="flex h-full min-h-0 flex-col">
          {panelContent}
        </div>
      </div>
    );
  }

  return (
    <Card className="w-full">
      {panelContent}
    </Card>
  );
}
