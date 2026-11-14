import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import type { QSORecord } from '@tx5dr/contracts';
import { openLogbookWindow } from '../../utils/windowManager';
import type { QsoDraftStore } from '../../store/qsoDraftStore';

const logger = createLogger('ModeQSOLogCard');

interface QSOFormData {
  callsign: string;
  rstSent: string;
  rstReceived: string;
  qth: string;
  grid: string;
  comment: string;
}

function createInitialFormData(defaultReport: string): QSOFormData {
  return {
    callsign: '',
    rstSent: defaultReport,
    rstReceived: defaultReport,
    qth: '',
    grid: '',
    comment: '',
  };
}

export interface ModeQSOLogCardProps {
  /** ADIF mode written to new/edited QSOs and shown for new ones, e.g. `CW`. */
  mode: string;
  /** Initial/fallback sent and received report, e.g. `599`. */
  defaultReport: string;
  /** RST inputs are truncated to this length and upper-cased. */
  rstMaxLength: number;
  /** Transmitter activity: the first rise sets the start time, each fall the end time. */
  txActive: boolean;
  /** Draft shared with the mode's keyer placeholders and decoder. */
  draftStore: QsoDraftStore;
  /** i18n key prefix for the card texts, e.g. `radio:cw.qso`. */
  i18nPrefix: string;
  /**
   * Maps the live dial frequency to the frequency logged for a new QSO, e.g.
   * the RTTY mark RF frequency. Edited QSOs keep their stored frequency.
   */
  qsoFrequencyFromDial?: (dialFrequencyHz: number) => number;
  /**
   * Also follow sent/received report changes made elsewhere in the draft
   * (e.g. clicking a report in the RTTY terminal). Off for CW, whose draft
   * defaults differ from the card defaults.
   */
  syncReportsFromDraft?: boolean;
  /**
   * Start time is when a callsign is first entered for this QSO (not the
   * first transmission), and transmissions only update the end time while the
   * form holds a callsign: a cleared or just-logged form stays empty.
   */
  startTimeFromCallsign?: boolean;
  /** Rendered under the callsign input (e.g. a worked-before/dupe hint). */
  callsignAdornment?: React.ReactNode;
  /** Key handler for the callsign input (e.g. Enter-sends-message). */
  onCallsignKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Receives the card's log action (resolves to whether a QSO was logged/saved). */
  logActionRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  /** Called with the callsign right before a QSO is created or saved. */
  onBeforeLog?: (callsign: string) => void;
  /** Tooltip (title) of the log button, e.g. its keyboard shortcut. */
  logButtonTitle?: string;
  /** Rendered after the action buttons (e.g. keyboard shortcut hints). */
  footer?: React.ReactNode;
  editingQSO?: QSORecord | null;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  onEditComplete?: (updated: QSORecord) => void;
  onDeleteComplete?: (deletedId: string) => void;
  onCancelEdit?: () => void;
}

/**
 * QSO log card for keyboard modes (CW, RTTY).
 *
 * Integrates with the operator system - operator selector in top-right,
 * auto-fills myCallsign/myGrid from the selected operator.
 * Supports both new QSO creation and editing existing QSOs.
 * Tracks start/end time from the mode's transmitter activity.
 */
export const ModeQSOLogCard: React.FC<ModeQSOLogCardProps> = ({
  mode,
  defaultReport,
  rstMaxLength,
  txActive,
  draftStore,
  i18nPrefix,
  qsoFrequencyFromDial,
  syncReportsFromDraft = false,
  startTimeFromCallsign = false,
  callsignAdornment,
  onCallsignKeyDown,
  logActionRef,
  onBeforeLog,
  logButtonTitle,
  footer,
  editingQSO,
  collapsed,
  onCollapsedChange,
  onEditComplete,
  onDeleteComplete,
  onCancelEdit,
}) => {
  const { t: translate } = useTranslation(['radio', 'voice']);
  const t = (key: string) => translate(`${i18nPrefix}.${key}`);
  const radioMode = useRadioModeState();
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();
  const { hisCallsign, trst: draftTrst, rrst: draftRrst } = draftStore.useDraft();
  const initialFormData = useMemo(() => createInitialFormData(defaultReport), [defaultReport]);

  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const [formData, setFormData] = useState<QSOFormData>(initialFormData);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletePopoverOpen, setDeletePopoverOpen] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [currentFrequency, setCurrentFrequency] = useState(14000000);
  const prevTransmitting = useRef(false);
  const previousEditingQSOIdRef = useRef<string | null | undefined>(undefined);
  const expandedEditingQSOIdRef = useRef<string | null>(null);
  const liveFrequency = radioMode.currentRadioFrequency && radioMode.currentRadioFrequency > 0
    ? radioMode.currentRadioFrequency
    : null;
  const liveFrequencyRef = useRef<number | null>(null);
  liveFrequencyRef.current = liveFrequency;

  const toLoggedFrequency = (dialFrequencyHz: number) => (
    qsoFrequencyFromDial && dialFrequencyHz > 0 ? qsoFrequencyFromDial(dialFrequencyHz) : dialFrequencyHz
  );

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

  // Auto-fill start/end time from transmitter activity (only in new mode)
  useEffect(() => {
    if (editingQSO || startTimeFromCallsign) return;
    const isTransmitting = txActive;

    if (isTransmitting && !prevTransmitting.current) {
      if (!startTime) {
        setStartTime(Date.now());
      }
    } else if (!isTransmitting && prevTransmitting.current) {
      setEndTime(Date.now());
    }

    prevTransmitting.current = isTransmitting;
  }, [txActive, startTime, editingQSO, startTimeFromCallsign]);

  // startTimeFromCallsign: the QSO starts when its callsign is entered; each
  // end of a transmission moves the end time while the form holds a callsign.
  const hasCallsign = formData.callsign.trim() !== '';
  useEffect(() => {
    if (!startTimeFromCallsign || editingQSO) return;
    if (hasCallsign) {
      setStartTime(previous => previous ?? Date.now());
    } else {
      setStartTime(null);
      setEndTime(null);
    }
  }, [editingQSO, hasCallsign, startTimeFromCallsign]);

  const prevCallsignTransmitting = useRef(txActive);
  useEffect(() => {
    if (!startTimeFromCallsign) return;
    const wasTransmitting = prevCallsignTransmitting.current;
    prevCallsignTransmitting.current = txActive;
    if (editingQSO || !hasCallsign) return;
    if (wasTransmitting && !txActive) setEndTime(Date.now());
  }, [editingQSO, hasCallsign, startTimeFromCallsign, txActive]);

  // Only synchronize form data when the selected QSO actually changes. Collapse
  // callbacks are presentation state and must not reset an in-progress draft.
  useEffect(() => {
    const nextEditingQSOId = editingQSO?.id ?? null;
    if (previousEditingQSOIdRef.current === nextEditingQSOId) {
      return;
    }
    previousEditingQSOIdRef.current = nextEditingQSOId;

    if (!editingQSO) {
      resetForm();
      if (liveFrequencyRef.current !== null) {
        setCurrentFrequency(liveFrequencyRef.current);
      }
      return;
    }
    setFormData({
      callsign: editingQSO.callsign,
      rstSent: editingQSO.reportSent ?? defaultReport,
      rstReceived: editingQSO.reportReceived ?? defaultReport,
      qth: editingQSO.qth ?? '',
      grid: editingQSO.grid ?? '',
      comment: editingQSO.comment ?? editingQSO.notes ?? '',
    });
    draftStore.setHisCallsign(editingQSO.callsign);
    setStartTime(editingQSO.startTime);
    setEndTime(editingQSO.endTime ?? null);
    setCurrentFrequency(editingQSO.frequency);
  }, [editingQSO]);

  useEffect(() => {
    if (!editingQSO) {
      expandedEditingQSOIdRef.current = null;
      return;
    }

    if (expandedEditingQSOIdRef.current === editingQSO.id) return;
    expandedEditingQSOIdRef.current = editingQSO.id;
    setCollapsed(false);
  }, [editingQSO, setCollapsed]);

  const updateField = (field: keyof QSOFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'callsign') {
      draftStore.setHisCallsign(value);
    } else if (field === 'rstSent') {
      draftStore.setTrst(value);
    } else if (field === 'rstReceived') {
      draftStore.setRrst(value);
    }
  };

  const resetForm = () => {
    setFormData(initialFormData);
    draftStore.setHisCallsign('');
    draftStore.setTrst(initialFormData.rstSent);
    draftStore.setRrst(initialFormData.rstReceived);
    setStartTime(null);
    setEndTime(null);
  };

  // Keep the QSO log callsign in sync with shared draft updates,
  // including the decoder "use callsign" action from the left panel.
  useEffect(() => {
    if (editingQSO) return;
    setFormData(prev => {
      if (prev.callsign.trim().toUpperCase() === hisCallsign) return prev;
      return { ...prev, callsign: hisCallsign };
    });
  }, [editingQSO, hisCallsign]);

  // Optionally follow report changes made outside the card; the first run is
  // skipped so the card starts from its own defaults.
  const reportSyncStartedRef = useRef(false);
  useEffect(() => {
    if (!syncReportsFromDraft) return;
    if (!reportSyncStartedRef.current) {
      reportSyncStartedRef.current = true;
      return;
    }
    if (editingQSO) return;
    const rstSent = draftTrst.slice(0, rstMaxLength).toUpperCase();
    const rstReceived = draftRrst.slice(0, rstMaxLength).toUpperCase();
    setFormData(prev => (prev.rstSent === rstSent && prev.rstReceived === rstReceived
      ? prev
      : { ...prev, rstSent, rstReceived }));
  }, [draftRrst, draftTrst, editingQSO, rstMaxLength, syncReportsFromDraft]);

  const handleLogQSO = async (): Promise<boolean> => {
    if (!formData.callsign.trim() || !hasOperator || isSubmitting) return false;

    setIsSubmitting(true);
    onBeforeLog?.(formData.callsign.toUpperCase().trim());
    try {
      const qsoFrequency = editingQSO ? currentFrequency : toLoggedFrequency(liveFrequency ?? currentFrequency);
      const qsoMode = mode;

      if (editingQSO) {
        // Edit mode: update existing QSO
        const logbookId = editingQSO.myCallsign || myCallsign;
        const result = await api.updateQSO(logbookId, editingQSO.id, {
          callsign: formData.callsign.toUpperCase().trim(),
          frequency: qsoFrequency,
          mode: qsoMode,
          startTime: startTime ?? editingQSO.startTime,
          endTime: endTime ?? editingQSO.endTime,
          reportSent: formData.rstSent || defaultReport,
          reportReceived: formData.rstReceived || defaultReport,
          qth: formData.qth || undefined,
          grid: formData.grid || undefined,
          comment: formData.comment || undefined,
        });
        addToast({
          title: t('logSuccess'),
          color: 'success',
          timeout: 3000,
        });
        if (result.data) onEditComplete?.(result.data as QSORecord);
        resetForm();
      } else {
        const now = Date.now();
        const qsoStart = startTime || now;
        // An ongoing transmission (e.g. TU) or no transmission yet ends the QSO now.
        const qsoEnd = startTimeFromCallsign
          ? Math.max(qsoStart, txActive || !endTime ? now : endTime)
          : endTime || now;
        // New mode: create QSO
        const body = {
          callsign: formData.callsign.toUpperCase().trim(),
          frequency: qsoFrequency,
          mode: qsoMode,
          startTime: qsoStart,
          endTime: qsoEnd,
          reportSent: formData.rstSent || defaultReport,
          reportReceived: formData.rstReceived || defaultReport,
          messageHistory: [],
          qth: formData.qth || undefined,
          grid: formData.grid || undefined,
          comment: formData.comment || undefined,
        };

        await api.createQSO(myCallsign, body);

        addToast({
          title: t('logSuccess'),
          color: 'success',
          timeout: 3000,
        });
        resetForm();
      }
      return true;
    } catch (error) {
      logger.error(`Failed to log ${mode} QSO:`, error);
      addToast({
        title: t('logFailed'),
        color: 'danger',
        timeout: 5000,
      });
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!logActionRef) return undefined;
    logActionRef.current = handleLogQSO;
    return () => {
      if (logActionRef.current === handleLogQSO) logActionRef.current = null;
    };
  });

  const handleDelete = async () => {
    if (!editingQSO) return;
    setIsDeleting(true);
    try {
      const logbookId = editingQSO.myCallsign || myCallsign;
      await api.deleteQSO(logbookId, editingQSO.id);
      addToast({
        title: t('deleteSuccess'),
        color: 'success',
        timeout: 3000,
      });
      onDeleteComplete?.(editingQSO.id);
      resetForm();
    } catch (error) {
      logger.error('Failed to delete QSO:', error);
      addToast({
        title: t('deleteFailed'),
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
  const displayedFrequency = isEditing ? currentFrequency : toLoggedFrequency(liveFrequency ?? currentFrequency);
  const displayedMode = isEditing
    ? (getDisplayMode(editingQSO) || radioMode.currentRadioMode || mode)
    : mode;

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
            {isEditing ? t('editTitle') : t('title')}
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
              title={translate('radio:operator.viewLog')}
              aria-label={translate('radio:operator.viewLog')}
              startContent={<FontAwesomeIcon icon={faBook} />}
            >
              <span className="hidden sm:inline">{translate('radio:operator.log')}</span>
            </Button>
            <Select
              size="sm"
              variant="flat"
              aria-label={t('operator')}
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
            {t('noOperator')}
          </div>
        )}

        {/* Operator info (read-only) */}
        {hasOperator && (
          <div className="flex gap-4 text-xs text-default-500 bg-default-100 rounded-md px-2 py-1.5">
            <span>{t('myCallsign')}: <span className="font-mono font-semibold">{myCallsign}</span></span>
            {myGrid && <span>{t('myGrid')}: <span className="font-mono">{myGrid}</span></span>}
          </div>
        )}

        {/* Callsign */}
        <Input
          label={t('callsign')}
          placeholder={t('callsignPlaceholder')}
          value={formData.callsign}
          onValueChange={(v) => updateField('callsign', v.toUpperCase())}
          onKeyDown={onCallsignKeyDown}
          data-qso-callsign-input=""
          variant="flat"
          size="lg"
          classNames={{ input: 'font-mono font-bold text-xl uppercase' }}
        />
        {callsignAdornment}

        {/* RST row */}
        <div className="flex gap-2">
          <Input
            label={t('rstSent')}
            value={formData.rstSent}
            onValueChange={(v) => updateField('rstSent', v.slice(0, rstMaxLength).toUpperCase())}
            variant="flat"
            size="sm"
            className="w-1/2"
            classNames={{ input: 'font-mono' }}
            maxLength={rstMaxLength}
          />
          <Input
            label={t('rstReceived')}
            value={formData.rstReceived}
            onValueChange={(v) => updateField('rstReceived', v.slice(0, rstMaxLength).toUpperCase())}
            variant="flat"
            size="sm"
            className="w-1/2"
            maxLength={rstMaxLength}
            classNames={{ input: 'font-mono' }}
          />
        </div>

        {/* QTH + Grid */}
        <div className="flex gap-2">
          <Input
            label={t('qth')}
            placeholder={t('qthPlaceholder')}
            value={formData.qth}
            onValueChange={(v) => updateField('qth', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
          />
          <Input
            label={t('grid')}
            placeholder={t('gridPlaceholder')}
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
          label={t('comment')}
          placeholder={t('commentPlaceholder')}
          value={formData.comment}
          onValueChange={(v) => updateField('comment', v)}
          variant="flat"
          size="sm"
          minRows={1}
          maxRows={3}
        />

        {/* Time display */}
        <div className="flex gap-4 text-xs text-default-400">
          <span>{t('startTime')}: <span className="font-mono">{formatTime(startTime)}</span></span>
          <span>{t('endTime')}: <span className="font-mono">{formatTime(endTime)}</span></span>
        </div>

        {/* Auto-filled info */}
        <div className="flex gap-4 text-xs text-default-400">
          <span>{t('frequency')}: <span className="font-mono">{((displayedFrequency || 0) / 1000000).toFixed(3)} MHz</span></span>
          <span>{t('mode')}: <span className="font-mono">{displayedMode}</span></span>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          <Button
            color="primary"
            onPress={() => { void handleLogQSO(); }}
            title={logButtonTitle}
            isLoading={isSubmitting}
            isDisabled={!formData.callsign.trim() || !hasOperator}
            className="flex-1"
            size="sm"
          >
            {isEditing ? t('save') : t('logQSO')}
          </Button>
          <Button
            variant="flat"
            onPress={handleClear}
            isDisabled={isSubmitting || isDeleting}
            size="sm"
          >
            {isEditing ? t('cancel') : t('clear')}
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
                  {t('delete')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-3 gap-2 w-56">
                <p className="text-sm font-medium">{t('deleteConfirm')}</p>
                <p className="text-xs text-default-500">{t('deleteConfirmDesc')}</p>
                <div className="flex gap-2 w-full pt-1">
                  <Button
                    size="sm"
                    color="danger"
                    isLoading={isDeleting}
                    onPress={handleDelete}
                    className="flex-1"
                  >
                    {t('delete')}
                  </Button>
                  <Button
                    size="sm"
                    variant="flat"
                    onPress={() => setDeletePopoverOpen(false)}
                    isDisabled={isDeleting}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
        {footer}
      </CardBody>
        </div>
      </div>
    </Card>
  );
};
