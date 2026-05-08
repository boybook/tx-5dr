import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Textarea,
  Switch,
  Slider,
  Select,
  SelectItem,
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
  faPlus,
  faMinus,
} from '@fortawesome/free-solid-svg-icons';
import { api } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import { useOperators, useCurrentOperatorId } from '../../store/radioStore';
import { CWSidetone } from './CWSidetone';
import type { CWMessagePanel, CWMessageSlot } from '@tx5dr/contracts';

const WPM_MIN = 5;
const WPM_MAX = 60;

export function CWKeyerPanel() {
  const { t } = useTranslation();
  const { cwKeyerStatus, cwConfig, isCWMode, sendText, playMessage, stopMessage } = useCWKeyer();
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

  // WPM 本地状态，跟随 cwConfig 变化
  const [wpm, setWpm] = useState(cwConfig?.wpm ?? 20);

  useEffect(() => {
    if (cwConfig) {
      setWpm(cwConfig.wpm);
    }
  }, [cwConfig]);

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
    void api.updateCWKeyerConfig({ wpm: v });
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

  const visibleSlots = panel?.slots.slice(0, panel.slotCount) ?? [];
  const canIncreaseSlots = (panel?.slotCount ?? 0) < (panel?.maxSlotCount ?? 12);
  const canDecreaseSlots = (panel?.slotCount ?? 3) > 3;

  return (
    <Card className="w-full">
      <CardHeader className="flex gap-2 items-center">
        <FontAwesomeIcon icon={faTowerBroadcast} className="text-primary" />
        <span className="font-semibold">{t('radio:cw.title', 'CW')}</span>
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
      </CardHeader>

      <CWSidetone />

      <CardBody className="flex flex-col gap-3">
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
        <div>
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
            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
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
      </CardBody>

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
    </Card>
  );
}
