import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Input,
  Button,
  Textarea,
  Select,
  SelectItem,
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBook, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { useRadioModeState, useConnection, useOperators, useCurrentOperatorId } from '../../store/radioStore';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { api, getDisplayMode } from '@tx5dr/core';
import { useWSEvent } from '../../hooks/useWSEvent';
import { useCWKeyer } from '../../hooks/useCWKeyer';
import type { QSORecord } from '@tx5dr/contracts';
import { openLogbookWindow } from '../../utils/windowManager';
import { setCWQSOHisCallsign, useCWQSODraft } from '../../store/cwQsoDraftStore';

const logger = createLogger('CWQSOLogCard');

interface QSOFormData {
  callsign: string;
  rstSent: string;
  rstReceived: string;
  qth: string;
  grid: string;
  comment: string;
}

const initialFormData: QSOFormData = {
  callsign: '',
  rstSent: '599',
  rstReceived: '599',
  qth: '',
  grid: '',
  comment: '',
};

interface CWQSOLogCardProps {
  editingQSO?: QSORecord | null;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onEditComplete?: (updated: QSORecord) => void;
  onDeleteComplete?: (deletedId: string) => void;
  onCancelEdit?: () => void;
}

/**
 * CW QSO Log Card
 *
 * Integrates with the operator system - operator selector in top-right,
 * auto-fills myCallsign/myGrid from the selected operator.
 * Supports both new QSO creation and editing existing QSOs.
 * Tracks start/end time from CW keyer status.
 */
export const CWQSOLogCard: React.FC<CWQSOLogCardProps> = ({
  editingQSO,
  collapsed,
  onCollapsedChange,
  onEditComplete,
  onDeleteComplete,
  onCancelEdit,
}) => {
  const { t } = useTranslation(['radio', 'voice']);
  const radioMode = useRadioModeState();
  const { cwKeyerStatus } = useCWKeyer();
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();
  const { hisCallsign } = useCWQSODraft();

  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [formData, setFormData] = useState<QSOFormData>(initialFormData);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletePopoverOpen, setDeletePopoverOpen] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [currentFrequency, setCurrentFrequency] = useState(14000000);
  const prevTransmitting = useRef(false);
  const liveFrequency = radioMode.currentRadioFrequency && radioMode.currentRadioFrequency > 0
    ? radioMode.currentRadioFrequency
    : null;
  const liveFrequencyRef = useRef<number | null>(null);
  liveFrequencyRef.current = liveFrequency;

  // Current operator info
  const currentOperator = operators.find(op => op.id === currentOperatorId);
  const myCallsign = currentOperator?.context?.myCall || '';
  const myGrid = currentOperator?.context?.myGrid || '';
  const hasOperator = !!currentOperator && !!myCallsign;
  const isCollapsed = collapsed ?? internalCollapsed;

  const setCollapsed = useCallback((next: boolean | ((current: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(isCollapsed) : next;
    if (collapsed === undefined) {
      setInternalCollapsed(resolved);
    }
    onCollapsedChange?.(resolved);
  }, [collapsed, isCollapsed, onCollapsedChange]);

  // Track current frequency from WS events
  useWSEvent(
    connection.state.radioService,
    'frequencyChanged',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((data: any) => {
      if (data.frequency && !editingQSO) setCurrentFrequency(data.frequency);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  );

  // Keep the new-QSO form aligned with the live radio state.
  useEffect(() => {
    if (!editingQSO && liveFrequency !== null) {
      setCurrentFrequency(liveFrequency);
    }
  }, [editingQSO, liveFrequency]);

  // Auto-fill start/end time from CW keyer status (only in new mode)
  useEffect(() => {
    if (editingQSO) return;
    const isTransmitting = cwKeyerStatus?.active ?? false;

    if (isTransmitting && !prevTransmitting.current) {
      if (!startTime) {
        setStartTime(Date.now());
      }
    } else if (!isTransmitting && prevTransmitting.current) {
      setEndTime(Date.now());
    }

    prevTransmitting.current = isTransmitting;
  }, [cwKeyerStatus?.active, startTime, editingQSO]);

  // When editingQSO changes, pre-fill form and force expand
  useEffect(() => {
    if (!editingQSO) {
      resetForm();
      if (liveFrequencyRef.current !== null) {
        setCurrentFrequency(liveFrequencyRef.current);
      }
      return;
    }
    setFormData({
      callsign: editingQSO.callsign,
      rstSent: editingQSO.reportSent ?? '599',
      rstReceived: editingQSO.reportReceived ?? '599',
      qth: editingQSO.qth ?? '',
      grid: editingQSO.grid ?? '',
      comment: editingQSO.comment ?? editingQSO.notes ?? '',
    });
    setCWQSOHisCallsign(editingQSO.callsign);
    setStartTime(editingQSO.startTime);
    setEndTime(editingQSO.endTime ?? null);
    setCurrentFrequency(editingQSO.frequency);
    setCollapsed(false);
  }, [editingQSO, setCollapsed]);

  const updateField = (field: keyof QSOFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'callsign') {
      setCWQSOHisCallsign(value);
    }
  };

  const resetForm = () => {
    setFormData(initialFormData);
    setCWQSOHisCallsign('');
    setStartTime(null);
    setEndTime(null);
  };

  // Keep the QSO log callsign in sync with shared CW draft updates,
  // including the decoder "use callsign" action from the left panel.
  useEffect(() => {
    if (editingQSO) return;
    setFormData(prev => {
      if (prev.callsign.trim().toUpperCase() === hisCallsign) return prev;
      return { ...prev, callsign: hisCallsign };
    });
  }, [editingQSO, hisCallsign]);

  const handleLogQSO = async () => {
    if (!formData.callsign.trim() || !hasOperator) return;

    setIsSubmitting(true);
    try {
      const qsoFrequency = editingQSO ? currentFrequency : (liveFrequency ?? currentFrequency);
      const qsoMode = 'CW';

      if (editingQSO) {
        // Edit mode: update existing QSO
        const logbookId = editingQSO.myCallsign || myCallsign;
        const result = await api.updateQSO(logbookId, editingQSO.id, {
          callsign: formData.callsign.toUpperCase().trim(),
          frequency: qsoFrequency,
          mode: qsoMode,
          startTime: startTime ?? editingQSO.startTime,
          endTime: endTime ?? editingQSO.endTime,
          reportSent: formData.rstSent || '599',
          reportReceived: formData.rstReceived || '599',
          qth: formData.qth || undefined,
          grid: formData.grid || undefined,
          comment: formData.comment || undefined,
        });
        addToast({
          title: t('radio:cw.qso.logSuccess'),
          color: 'success',
          timeout: 3000,
        });
        if (result.data) onEditComplete?.(result.data as QSORecord);
        resetForm();
      } else {
        // New mode: create QSO
        const body = {
          callsign: formData.callsign.toUpperCase().trim(),
          frequency: qsoFrequency,
          mode: qsoMode,
          startTime: startTime || Date.now(),
          endTime: endTime || Date.now(),
          reportSent: formData.rstSent || '599',
          reportReceived: formData.rstReceived || '599',
          messageHistory: [],
          qth: formData.qth || undefined,
          grid: formData.grid || undefined,
          comment: formData.comment || undefined,
        };

        await api.createQSO(myCallsign, body);

        addToast({
          title: t('radio:cw.qso.logSuccess'),
          color: 'success',
          timeout: 3000,
        });
        resetForm();
      }
    } catch (error) {
      logger.error('Failed to log CW QSO:', error);
      addToast({
        title: t('radio:cw.qso.logFailed'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!editingQSO) return;
    setIsDeleting(true);
    try {
      const logbookId = editingQSO.myCallsign || myCallsign;
      await api.deleteQSO(logbookId, editingQSO.id);
      addToast({
        title: t('radio:cw.qso.deleteSuccess'),
        color: 'success',
        timeout: 3000,
      });
      onDeleteComplete?.(editingQSO.id);
      resetForm();
    } catch (error) {
      logger.error('Failed to delete QSO:', error);
      addToast({
        title: t('radio:cw.qso.deleteFailed'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setIsDeleting(false);
      setDeletePopoverOpen(false);
    }
  };

  const handleClear = () => {
    if (editingQSO) {
      resetForm();
      onCancelEdit?.();
    } else {
      resetForm();
    }
  };

  const formatTime = (timestamp: number | null): string => {
    if (!timestamp) return '--:--:--';
    return new Date(timestamp).toISOString().slice(11, 19);
  };

  const isEditing = !!editingQSO;
  const displayedFrequency = isEditing ? currentFrequency : (liveFrequency ?? currentFrequency);
  const displayedMode = isEditing
    ? (getDisplayMode(editingQSO) || radioMode.currentRadioMode || 'CW')
    : 'CW';

  return (
    <Card className="w-full" shadow="sm">
      <CardHeader
        className="flex justify-between items-center cursor-pointer select-none pb-3"
        onClick={() => setCollapsed(prev => !prev)}
      >
        <div className="flex items-center gap-2">
          <FontAwesomeIcon
            icon={faChevronRight}
            className={`text-default-400 text-xs transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-sm font-semibold">
            {isEditing ? t('radio:cw.qso.editTitle') : t('radio:cw.qso.title')}
          </span>
        </div>

        {/* Header actions */}
        {operators.length > 0 && (
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant="flat"
              onPress={() => {
                if (!currentOperatorId || !myCallsign) return;
                openLogbookWindow({
                  operatorId: currentOperatorId,
                  logBookId: myCallsign,
                });
              }}
              isDisabled={!currentOperatorId || !myCallsign}
              className="h-7 min-h-7 min-w-0 w-8 px-0 sm:w-auto sm:px-2"
              title={t('radio:operator.viewLog')}
              aria-label={t('radio:operator.viewLog')}
              startContent={<FontAwesomeIcon icon={faBook} />}
            >
              <span className="hidden sm:inline">{t('radio:operator.log')}</span>
            </Button>
            <Select
              size="sm"
              variant="flat"
              aria-label={t('radio:cw.qso.operator')}
              selectedKeys={currentOperatorId ? [currentOperatorId] : []}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                if (selected) setCurrentOperatorId(selected);
              }}
              className="w-32"
              classNames={{ trigger: 'h-7 min-h-7 px-2', value: 'font-mono text-xs' }}
            >
              {operators.map((op) => (
                <SelectItem key={op.id} textValue={op.context.myCall || op.id}>
                  {op.context.myCall || op.id}
                </SelectItem>
              ))}
            </Select>
          </div>
        )}
      </CardHeader>
      <div
        className="grid transition-[grid-template-rows] duration-200 ease-in-out"
        style={{ gridTemplateRows: isCollapsed ? '0fr' : '1fr' }}
      >
        <div className="overflow-hidden">
      <CardBody className="pt-1 gap-2">
        {/* No operator warning */}
        {!hasOperator && (
          <div className="text-xs text-warning bg-warning-50 dark:bg-warning-50/10 rounded-md px-2 py-1.5">
            {t('radio:cw.qso.noOperator')}
          </div>
        )}

        {/* Operator info (read-only) */}
        {hasOperator && (
          <div className="flex gap-4 text-xs text-default-500 bg-default-100 rounded-md px-2 py-1.5">
            <span>{t('radio:cw.qso.myCallsign')}: <span className="font-mono font-semibold">{myCallsign}</span></span>
            {myGrid && <span>{t('radio:cw.qso.myGrid')}: <span className="font-mono">{myGrid}</span></span>}
          </div>
        )}

        {/* Callsign */}
        <Input
          label={t('radio:cw.qso.callsign')}
          placeholder={t('radio:cw.qso.callsignPlaceholder')}
          value={formData.callsign}
          onValueChange={(v) => updateField('callsign', v.toUpperCase())}
          variant="flat"
          size="lg"
          classNames={{ input: 'font-mono font-bold text-xl uppercase' }}
        />

        {/* RST row */}
        <div className="flex gap-2">
          <Input
            label={t('radio:cw.qso.rstSent')}
            value={formData.rstSent}
            onValueChange={(v) => updateField('rstSent', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
            classNames={{ input: 'font-mono' }}
          />
          <Input
            label={t('radio:cw.qso.rstReceived')}
            value={formData.rstReceived}
            onValueChange={(v) => updateField('rstReceived', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
            classNames={{ input: 'font-mono' }}
          />
        </div>

        {/* QTH + Grid */}
        <div className="flex gap-2">
          <Input
            label={t('radio:cw.qso.qth')}
            placeholder={t('radio:cw.qso.qthPlaceholder')}
            value={formData.qth}
            onValueChange={(v) => updateField('qth', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
          />
          <Input
            label={t('radio:cw.qso.grid')}
            placeholder={t('radio:cw.qso.gridPlaceholder')}
            value={formData.grid}
            onValueChange={(v) => updateField('grid', v.toUpperCase())}
            variant="flat"
            size="sm"
            className="w-1/2"
            classNames={{ input: 'font-mono uppercase' }}
          />
        </div>

        {/* Notes */}
        <Textarea
          label={t('radio:cw.qso.comment')}
          placeholder={t('radio:cw.qso.commentPlaceholder')}
          value={formData.comment}
          onValueChange={(v) => updateField('comment', v)}
          variant="flat"
          size="sm"
          minRows={1}
          maxRows={3}
        />

        {/* Time display */}
        <div className="flex gap-4 text-xs text-default-400">
          <span>{t('radio:cw.qso.startTime')}: <span className="font-mono">{formatTime(startTime)}</span></span>
          <span>{t('radio:cw.qso.endTime')}: <span className="font-mono">{formatTime(endTime)}</span></span>
        </div>

        {/* Auto-filled info */}
        <div className="flex gap-4 text-xs text-default-400">
          <span>{t('radio:cw.qso.frequency')}: <span className="font-mono">{((displayedFrequency || 0) / 1000000).toFixed(3)} MHz</span></span>
          <span>{t('radio:cw.qso.mode')}: <span className="font-mono">{displayedMode}</span></span>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          <Button
            color="primary"
            onPress={handleLogQSO}
            isLoading={isSubmitting}
            isDisabled={!formData.callsign.trim() || !hasOperator}
            className="flex-1"
            size="sm"
          >
            {isEditing ? t('radio:cw.qso.save') : t('radio:cw.qso.logQSO')}
          </Button>
          <Button
            variant="flat"
            onPress={handleClear}
            isDisabled={isSubmitting || isDeleting}
            size="sm"
          >
            {isEditing ? t('radio:cw.qso.cancel') : t('radio:cw.qso.clear')}
          </Button>
          {isEditing && (
            <Popover
              isOpen={deletePopoverOpen}
              onOpenChange={setDeletePopoverOpen}
              placement="top-end"
            >
              <PopoverTrigger>
                <Button
                  variant="flat"
                  color="danger"
                  isDisabled={isSubmitting || isDeleting}
                  size="sm"
                >
                  {t('radio:cw.qso.delete')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-3 gap-2 w-56">
                <p className="text-sm font-medium">{t('radio:cw.qso.deleteConfirm')}</p>
                <p className="text-xs text-default-500">{t('radio:cw.qso.deleteConfirmDesc')}</p>
                <div className="flex gap-2 w-full pt-1">
                  <Button
                    size="sm"
                    color="danger"
                    isLoading={isDeleting}
                    onPress={handleDelete}
                    className="flex-1"
                  >
                    {t('radio:cw.qso.delete')}
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => setDeletePopoverOpen(false)}
                    isDisabled={isDeleting}
                  >
                    {t('radio:cw.qso.cancel')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </CardBody>
        </div>
      </div>
    </Card>
  );
};
