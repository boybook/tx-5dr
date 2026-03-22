import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  CardBody,
  CardHeader,
  Input,
  Button,
  Textarea,
  Select,
  SelectItem,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { addToast } from '@heroui/toast';
import { useRadioState, useConnection, useOperators, useCurrentOperatorId } from '../../store/radioStore';
import { useTranslation } from 'react-i18next';
import { createLogger } from '../../utils/logger';
import { getApiBaseUrl } from '../../utils/config';
import { useWSEvent } from '../../hooks/useWSEvent';

const logger = createLogger('VoiceQSOLogCard');

interface QSOFormData {
  callsign: string;
  rstSent: string;
  rstReceived: string;
  qth: string;
  grid: string;
  notes: string;
}

const initialFormData: QSOFormData = {
  callsign: '',
  rstSent: '59',
  rstReceived: '59',
  qth: '',
  grid: '',
  notes: '',
};

/**
 * Voice QSO Log Card
 *
 * Integrates with the operator system - operator selector in top-right,
 * auto-fills myCallsign/myGrid from the selected operator.
 */
export const VoiceQSOLogCard: React.FC = () => {
  const { t } = useTranslation('voice');
  const radio = useRadioState();
  const connection = useConnection();
  const { operators } = useOperators();
  const { currentOperatorId, setCurrentOperatorId } = useCurrentOperatorId();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [formData, setFormData] = useState<QSOFormData>(initialFormData);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [currentFrequency, setCurrentFrequency] = useState(14270000);
  const prevTransmitting = useRef(false);

  // Current operator info
  const currentOperator = operators.find(op => op.id === currentOperatorId);
  const myCallsign = currentOperator?.context?.myCall || '';
  const myGrid = currentOperator?.context?.myGrid || '';
  const hasOperator = !!currentOperator && !!myCallsign;

  // Track current frequency from WS events
  useWSEvent(
    connection.state.radioService,
    'frequencyChanged',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((data: any) => {
      if (data.frequency) setCurrentFrequency(data.frequency);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any
  );

  // Auto-fill start/end time from PTT events
  useEffect(() => {
    const isTransmitting = radio.state.pttStatus.isTransmitting;

    if (isTransmitting && !prevTransmitting.current) {
      if (!startTime) {
        setStartTime(Date.now());
      }
    } else if (!isTransmitting && prevTransmitting.current) {
      setEndTime(Date.now());
    }

    prevTransmitting.current = isTransmitting;
  }, [radio.state.pttStatus.isTransmitting, startTime]);

  const updateField = (field: keyof QSOFormData, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleLogQSO = async () => {
    if (!formData.callsign.trim() || !hasOperator) return;

    setIsSubmitting(true);
    try {
      const body = {
        id: crypto.randomUUID(),
        callsign: formData.callsign.toUpperCase().trim(),
        frequency: currentFrequency,
        radioMode: radio.state.currentRadioMode || 'USB',
        startTime: startTime || Date.now(),
        endTime: endTime || Date.now(),
        rstSent: formData.rstSent || '59',
        rstReceived: formData.rstReceived || '59',
        qth: formData.qth || undefined,
        grid: formData.grid || undefined,
        notes: formData.notes || undefined,
        myCallsign: myCallsign,
        myGrid: myGrid || undefined,
        logBookId: currentOperator?.context?.myCall || 'default',
      };

      const response = await fetch(`${getApiBaseUrl()}/voice/qso-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        addToast({
          title: t('qso.logSuccess'),
          color: 'success',
          timeout: 3000,
        });
        handleClear();
      } else {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Failed to log QSO:', errorData);
        addToast({
          title: t('qso.logFailed'),
          description: errorData.message || '',
          color: 'danger',
          timeout: 5000,
        });
      }
    } catch (error) {
      logger.error('Failed to log voice QSO:', error);
      addToast({
        title: t('qso.logFailed'),
        color: 'danger',
        timeout: 5000,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClear = () => {
    setFormData(initialFormData);
    setStartTime(null);
    setEndTime(null);
  };

  const formatTime = (timestamp: number | null): string => {
    if (!timestamp) return '--:--:--';
    return new Date(timestamp).toISOString().slice(11, 19);
  };

  return (
    <Card className="w-full" shadow="sm">
      <CardHeader
        className="flex justify-between items-center cursor-pointer select-none pb-3"
        onClick={() => setIsCollapsed(prev => !prev)}
      >
        <div className="flex items-center gap-2">
          <FontAwesomeIcon
            icon={faChevronRight}
            className={`text-default-400 text-xs transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
          />
          <span className="text-sm font-semibold">{t('qso.title')}</span>
        </div>

        {/* Operator selector - stop click propagation to prevent collapse toggle */}
        {operators.length > 0 && (
          <div onClick={(e) => e.stopPropagation()}>
            <Select
              size="sm"
              variant="flat"
              aria-label={t('qso.operator')}
              selectedKeys={currentOperatorId ? [currentOperatorId] : []}
              onSelectionChange={(keys) => {
                const selected = Array.from(keys)[0] as string;
                if (selected) setCurrentOperatorId(selected);
              }}
              className="w-40"
              classNames={{ trigger: 'h-7 min-h-7', value: 'font-mono text-xs' }}
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
            {t('qso.noOperator')}
          </div>
        )}

        {/* Operator info (read-only) */}
        {hasOperator && (
          <div className="flex gap-4 text-xs text-default-500 bg-default-100 rounded-md px-2 py-1.5">
            <span>{t('qso.myCallsign')}: <span className="font-mono font-semibold">{myCallsign}</span></span>
            {myGrid && <span>{t('qso.myGrid')}: <span className="font-mono">{myGrid}</span></span>}
          </div>
        )}

        {/* Callsign - large input */}
        <Input
          label={t('qso.callsign')}
          placeholder={t('qso.callsignPlaceholder')}
          value={formData.callsign}
          onValueChange={(v) => updateField('callsign', v.toUpperCase())}
          variant="flat"
          size="lg"
          classNames={{ input: 'font-mono font-bold text-xl uppercase' }}
        />

        {/* RST row */}
        <div className="flex gap-2">
          <Input
            label={t('qso.rstSent')}
            value={formData.rstSent}
            onValueChange={(v) => updateField('rstSent', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
            classNames={{ input: 'font-mono' }}
          />
          <Input
            label={t('qso.rstReceived')}
            value={formData.rstReceived}
            onValueChange={(v) => updateField('rstReceived', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
            classNames={{ input: 'font-mono' }}
          />
        </div>

        {/* QTH + Grid on same row */}
        <div className="flex gap-2">
          <Input
            label={t('qso.qth')}
            placeholder={t('qso.qthPlaceholder')}
            value={formData.qth}
            onValueChange={(v) => updateField('qth', v)}
            variant="flat"
            size="sm"
            className="w-1/2"
          />
          <Input
            label={t('qso.grid')}
            placeholder={t('qso.gridPlaceholder')}
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
          label={t('qso.notes')}
          placeholder={t('qso.notesPlaceholder')}
          value={formData.notes}
          onValueChange={(v) => updateField('notes', v)}
          variant="flat"
          size="sm"
          minRows={1}
          maxRows={3}
        />

        {/* Time display */}
        <div className="flex gap-4 text-xs text-default-400">
          <span>{t('qso.startTime')}: <span className="font-mono">{formatTime(startTime)}</span></span>
          <span>{t('qso.endTime')}: <span className="font-mono">{formatTime(endTime)}</span></span>
        </div>

        {/* Auto-filled info */}
        <div className="flex gap-4 text-xs text-default-400">
          <span>{t('qso.frequency')}: <span className="font-mono">{((currentFrequency || 0) / 1000000).toFixed(3)} MHz</span></span>
          <span>{t('qso.mode')}: <span className="font-mono">{radio.state.currentRadioMode || 'USB'}</span></span>
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
            {t('qso.logQSO')}
          </Button>
          <Button
            variant="flat"
            onPress={handleClear}
            isDisabled={isSubmitting}
            size="sm"
          >
            {t('qso.clear')}
          </Button>
        </div>
      </CardBody>
        </div>
      </div>
    </Card>
  );
};
