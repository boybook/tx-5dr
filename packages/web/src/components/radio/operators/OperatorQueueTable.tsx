import * as React from 'react';
import { Reorder } from 'framer-motion';
import type { AssistedQueueRow, AssistedQueueSnapshot } from '@tx5dr/contracts';
import { calculateGridDistance, getCallsignInfo } from '@tx5dr/core';
import { useTranslation } from 'react-i18next';
import { useConnection, useOperators } from '../../../store/radioStore';
import { Button, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { FlagDisplay } from '../../common/FlagDisplay';
import { CallsignInfoPopover } from '../digital/CallsignInfoPopover';
import {
  faCircle,
  faCircleCheck,
  faClock,
  faGripVertical,
  faPause,
  faRadio,
  faRotateRight,
  faSpinner,
  faTrash,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import {
  getNewQueueEntryIds,
  getQueueBeforeEntryId,
  QUEUE_BODY_HEIGHT_PX,
} from './operatorQueuePresentation';
import { OperatorStrategyActions } from './OperatorStrategyActions';
import { resolvePluginLabel } from '../../../utils/pluginLocales';

interface OperatorQueueTableProps {
  operatorId: string;
  queue: AssistedQueueSnapshot;
}

function CycleDot({
  cycle,
  incompatible = false,
  label,
}: {
  cycle?: 0 | 1;
  incompatible?: boolean;
  label: string;
}) {
  const color = cycle === 0 ? 'var(--ft8-cycle-even)'
    : cycle === 1 ? 'var(--ft8-cycle-odd)' : undefined;
  return (
    <Tooltip content={label} placement="top" offset={4}>
      <span
        role="img"
        aria-label={label}
        data-cycle={cycle ?? 'unknown'}
        data-cycle-compatibility={cycle === undefined ? 'unknown' : incompatible ? 'incompatible' : 'compatible'}
        className="relative flex h-3 w-3 shrink-0 items-center justify-center"
      >
        <span
          className={`h-2 w-2 rounded-full ${cycle === undefined ? 'border border-default-400 bg-transparent' : ''}`}
          style={color ? { backgroundColor: color } : undefined}
        />
        {incompatible && (
          <span
            aria-hidden="true"
            className="absolute h-px w-3 rotate-45 bg-default-500 shadow-[0_0_0_1px_var(--heroui-background)]"
          />
        )}
      </span>
    </Tooltip>
  );
}

const TONE_CLASS: Record<AssistedQueueRow['tone'], string> = {
  neutral: 'text-default-500',
  active: 'text-primary-600 dark:text-primary-400',
  success: 'text-success-600 dark:text-success-400',
  warning: 'text-warning-600 dark:text-warning-400',
  danger: 'text-danger-600 dark:text-danger-400',
};

const ICONS: Record<AssistedQueueRow['icon'], typeof faCircle> = {
  circle: faCircle,
  radio: faRadio,
  'check-circle': faCircleCheck,
  'loader-circle': faSpinner,
  clock: faClock,
  pause: faPause,
  'triangle-alert': faTriangleExclamation,
};

function QueueRow({
  row,
  onRemove,
  myGrid,
  onDragEnd,
  onRetry,
  isNew = false,
  onEntryAnimationEnd,
  strategyName,
  currentTransmitCycle,
  active,
  onAction,
}: {
  row: AssistedQueueRow;
  onRemove: () => void;
  myGrid?: string;
  onDragEnd?: () => void;
  onRetry?: () => void;
  isNew?: boolean;
  onEntryAnimationEnd?: () => void;
  strategyName: string;
  currentTransmitCycle?: 0 | 1;
  active: boolean;
  onAction: (action: NonNullable<AssistedQueueRow['actions']>[number], payload?: unknown) => void;
}) {
  const { t, i18n } = useTranslation('radio');
  const callsignInfo = React.useMemo(() => getCallsignInfo(row.callsign), [row.callsign]);
  const countryName = i18n.language === 'zh'
    ? (callsignInfo?.countryZh || callsignInfo?.countryEn || callsignInfo?.country)
    : (callsignInfo?.countryEn || callsignInfo?.country);
  const distanceKm = React.useMemo(() => {
    if (!myGrid || !row.targetGrid) return undefined;
    const distance = calculateGridDistance(myGrid, row.targetGrid);
    return distance === null ? undefined : Math.round(distance);
  }, [myGrid, row.targetGrid]);
  const metadata = React.useMemo(() => [
    row.audioFrequencyHz === undefined ? null : `${Math.round(row.audioFrequencyHz)} Hz`,
    distanceKm === undefined ? null : `${distanceKm.toLocaleString(i18n.language)} km`,
    row.lastSnr === undefined ? null : `${row.lastSnr > 0 ? '+' : ''}${row.lastSnr} dB`,
    row.lastHeardCyclesAgo === undefined
      ? null
      : t('operator.queueMeta.cyclesAgo', { count: row.lastHeardCyclesAgo }),
  ].filter((value): value is string => Boolean(value)), [
    distanceKm,
    i18n.language,
    row.audioFrequencyHz,
    row.lastHeardCyclesAgo,
    row.lastSnr,
    t,
  ]);
  const stateLabel = row.displayState === 'paused'
    ? row.pauseReason === 'target-busy'
      ? t('operator.queuePauseReason.targetBusy')
      : row.pauseReason === 'stale'
        ? t('operator.queuePauseReason.stale')
        : t('operator.queueStatus.paused')
    : row.displayState === 'no-response' && row.noResponseCycles
      ? t('operator.queueStatus.noResponseCycles', { count: row.noResponseCycles })
      : row.displayState.startsWith('TX')
        ? row.displayState
        : t(`operator.queueStatus.${row.displayState}`);
  const removeLabel = row.draggable
    ? t('operator.queue.remove')
    : t('operator.queue.interruptAndRemove');
  const retryLabel = t('operator.queue.retry');
  const cycleLabel = row.lastHeardCycle === 0
    ? t('operator.evenCycle')
    : row.lastHeardCycle === 1 ? t('operator.oddCycle') : undefined;
  const incompatible = row.lastHeardCycle !== undefined
    && currentTransmitCycle !== undefined
    && row.lastHeardCycle === currentTransmitCycle;
  const cycleTooltip = cycleLabel
    ? t(incompatible ? 'operator.queueMeta.currentCycleUnavailable' : 'operator.queueMeta.lastHeardCycle', {
      cycle: cycleLabel,
    })
    : t('operator.queueMeta.unknownCycle');

  const rowContent = (
    <div
      role="listitem"
      className={`relative flex h-7 items-center bg-transparent pl-1.5 pr-2 text-xs transition-[background-color,opacity] hover:bg-default-200/60 sm:pl-2 sm:pr-3 ${
        isNew ? 'operator-queue-row-new' : ''
      } ${incompatible && !active ? 'opacity-60' : ''}`}
      onAnimationEnd={(event) => {
        if (event.currentTarget === event.target) onEntryAnimationEnd?.();
      }}
    >
      <div className="flex min-w-0 items-center gap-1 font-mono font-medium">
        <span
          aria-hidden="true"
          className={`flex w-3 shrink-0 items-center justify-center text-default-400 ${
            row.draggable ? 'cursor-grab' : 'cursor-not-allowed opacity-30'
          }`}
        >
          <FontAwesomeIcon icon={faGripVertical} className="text-[9px]" />
        </span>
        <CycleDot cycle={row.lastHeardCycle} incompatible={incompatible} label={cycleTooltip} />
        <CallsignInfoPopover
          callsign={row.callsign}
          logbookAnalysis={{ grid: row.targetGrid, dxccEntity: callsignInfo?.country }}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="shrink-0">{row.callsign}</span>
            {(callsignInfo?.flag || callsignInfo?.countryCode) && (
              <FlagDisplay flag={callsignInfo.flag} countryCode={callsignInfo.countryCode} />
            )}
            {countryName && (
              <span className="min-w-0 truncate font-sans text-[10px] font-normal text-default-400" title={countryName}>
                {countryName}
              </span>
            )}
          </span>
        </CallsignInfoPopover>
      </div>
      {metadata.length > 0 && (
        <span className="ml-2 min-w-0 flex-1 truncate text-[10px] text-default-400" title={metadata.join(' · ')}>
          {metadata.join(' · ')}
        </span>
      )}
      <span className={`ml-auto flex min-w-0 items-center justify-end gap-1 truncate pl-2 text-right font-mono ${TONE_CLASS[row.tone]}`}>
        <FontAwesomeIcon
          aria-hidden="true"
          icon={ICONS[row.icon]}
          className={`w-2.5 text-[9px] ${row.icon === 'loader-circle' ? 'animate-spin' : ''}`}
        />
        {stateLabel}
      </span>
      <span
        className="ml-1 flex shrink-0 items-center gap-0.5"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {(row.actions?.length ?? 0) > 0 ? (
          <OperatorStrategyActions
            compact
            actions={row.actions!}
            resolveLabel={(value) => resolvePluginLabel(value, strategyName)}
            onInvoke={onAction}
          />
        ) : <>
        {onRetry && (
          <Tooltip content={retryLabel} placement="top" offset={4}>
            <Button
              isIconOnly
              size="sm"
              variant="light"
              color="default"
              className="h-5 w-5 min-w-5 text-default-400"
              aria-label={retryLabel}
              onPress={onRetry}
            >
              <FontAwesomeIcon icon={faRotateRight} className="text-[9px]" />
            </Button>
          </Tooltip>
        )}
        <Tooltip content={removeLabel} placement="top" offset={4}>
          <Button
            isIconOnly
            size="sm"
            variant="light"
            color="default"
            className="h-5 w-5 min-w-5 text-default-400"
            aria-label={removeLabel}
            onPress={onRemove}
          >
            <FontAwesomeIcon icon={faTrash} className="text-[9px]" />
          </Button>
        </Tooltip>
        </>}
      </span>
    </div>
  );

  if (!row.draggable) return rowContent;
  return (
    <Reorder.Item value={row} as="div" dragListener onDragEnd={onDragEnd} className="cursor-grab active:cursor-grabbing">
      {rowContent}
    </Reorder.Item>
  );
}

export function OperatorQueueTable({ operatorId, queue }: OperatorQueueTableProps) {
  const { t } = useTranslation('radio');
  const connection = useConnection();
  const { operators } = useOperators();
  const myGrid = operators
    .find((operator) => operator.id === operatorId)?.context.myGrid;
  const strategyName = operators.find((operator) => operator.id === operatorId)?.strategy?.name ?? '';
  const selectedTransmitCycles = operators.find((operator) => operator.id === operatorId)?.transmitCycles ?? [];
  const currentTransmitCycle = selectedTransmitCycles.length === 1
    && (selectedTransmitCycles[0] === 0 || selectedTransmitCycles[0] === 1)
    ? selectedTransmitCycles[0] as 0 | 1
    : undefined;
  const currentCycleLabel = currentTransmitCycle === 0
    ? t('operator.evenCycle')
    : currentTransmitCycle === 1 ? t('operator.oddCycle') : undefined;
  const activeEntryIds = React.useMemo(() => new Set(
    queue.activeEntryIds ?? (queue.activeEntryId ? [queue.activeEntryId] : []),
  ), [queue.activeEntryId, queue.activeEntryIds]);
  const active = React.useMemo(
    () => queue.rows.filter((row) => activeEntryIds.has(row.entryId)),
    [activeEntryIds, queue.rows],
  );
  const serverWaiting = React.useMemo(
    () => queue.rows.filter((row) => !activeEntryIds.has(row.entryId)),
    [activeEntryIds, queue.rows],
  );
  const [waiting, setWaiting] = React.useState(serverWaiting);
  const waitingRef = React.useRef(waiting);
  const knownEntryIdsRef = React.useRef(new Set(queue.rows.map((row) => row.entryId)));
  const [newEntryIds, setNewEntryIds] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    setWaiting(serverWaiting);
    waitingRef.current = serverWaiting;
  }, [queue.version, serverWaiting]);

  React.useEffect(() => {
    const nextKnownEntryIds = new Set(queue.rows.map((row) => row.entryId));
    const addedEntryIds = getNewQueueEntryIds(knownEntryIdsRef.current, queue.rows);
    knownEntryIdsRef.current = nextKnownEntryIds;
    setNewEntryIds((current) => {
      const next = new Set([...current].filter((entryId) => nextKnownEntryIds.has(entryId)));
      for (const entryId of addedEntryIds) next.add(entryId);
      return next;
    });
  }, [queue.rows]);

  const finishEntryAnimation = React.useCallback((entryId: string) => {
    setNewEntryIds((current) => {
      if (!current.has(entryId)) return current;
      const next = new Set(current);
      next.delete(entryId);
      return next;
    });
  }, []);

  const remove = React.useCallback((entryId: string) => {
    connection.state.radioService?.removeQueueTarget(operatorId, entryId, queue.version);
  }, [connection.state.radioService, operatorId, queue.version]);

  const retry = React.useCallback((entryId: string) => {
    connection.state.radioService?.retryQueueTarget(operatorId, entryId, queue.version);
  }, [connection.state.radioService, operatorId, queue.version]);

  const clear = React.useCallback(() => {
    connection.state.radioService?.clearQueue(operatorId, queue.version);
  }, [connection.state.radioService, operatorId, queue.version]);

  const commitOrder = React.useCallback((entryId: string) => {
    const rows = waitingRef.current;
    const beforeEntryId = getQueueBeforeEntryId(rows, entryId);
    if (beforeEntryId === undefined) return;
    connection.state.radioService?.reorderQueueTarget(operatorId, entryId, beforeEntryId, queue.version);
  }, [connection.state.radioService, operatorId, queue.version]);

  return (
    <div role="group" aria-label={t('operator.queue.title')} className="overflow-hidden rounded-md bg-default-100 text-foreground">
      <div className="flex h-6 items-center justify-between bg-default-200/70 pl-2 pr-1 text-[10px] font-medium text-default-500 sm:pl-3 sm:pr-2">
        <span className="flex items-center gap-1">
          {t('operator.queue.title')}
          {currentCycleLabel && (
            <CycleDot
              cycle={currentTransmitCycle}
              label={t('operator.queueMeta.currentTransmitCycle', { cycle: currentCycleLabel })}
            />
          )}
        </span>
        <Tooltip content={t('operator.queue.clear')} placement="top" offset={4}>
          <Button
            isIconOnly
            isDisabled={queue.rows.length === 0}
            size="sm"
            variant="light"
            color="default"
            className="h-5 w-5 min-w-5 text-default-400"
            aria-label={t('operator.queue.clear')}
            onPress={clear}
          >
            <FontAwesomeIcon icon={faTrash} className="text-[9px]" />
          </Button>
        </Tooltip>
      </div>
      <div role="list" className="overflow-y-auto overscroll-contain" style={{ height: QUEUE_BODY_HEIGHT_PX }}>
        {queue.rows.length === 0 && (
          <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-default-400">
            <span>{t('operator.queue.emptyHint')}</span>
          </div>
        )}
        {active.map((row) => (
          <QueueRow
            key={row.entryId}
            row={row}
            onRemove={() => remove(row.entryId)}
            onRetry={row.displayState === 'no-response' && row.noResponseCycles !== undefined
              ? () => retry(row.entryId)
              : undefined}
            myGrid={myGrid}
            isNew={newEntryIds.has(row.entryId)}
            onEntryAnimationEnd={() => finishEntryAnimation(row.entryId)}
            strategyName={strategyName}
            currentTransmitCycle={currentTransmitCycle}
            active
            onAction={(action, payload) => connection.state.radioService?.invokeOperatorStrategyAction(
              operatorId,
              { kind: 'queue-entry', entryId: row.entryId, queueVersion: queue.version },
              action.id,
              payload,
            )}
          />
        ))}
        <Reorder.Group
          axis="y"
          role="presentation"
          values={waiting}
          onReorder={(rows) => {
            waitingRef.current = rows;
            setWaiting(rows);
          }}
          as="div"
        >
          {waiting.map((row) => (
            <QueueRow
              key={row.entryId}
              row={row}
              onRemove={() => remove(row.entryId)}
              onRetry={row.displayState === 'no-response' && row.noResponseCycles !== undefined
                ? () => retry(row.entryId)
                : undefined}
              myGrid={myGrid}
              onDragEnd={() => commitOrder(row.entryId)}
              isNew={newEntryIds.has(row.entryId)}
              onEntryAnimationEnd={() => finishEntryAnimation(row.entryId)}
              strategyName={strategyName}
              currentTransmitCycle={currentTransmitCycle}
              active={false}
              onAction={(action, payload) => connection.state.radioService?.invokeOperatorStrategyAction(
                operatorId,
                { kind: 'queue-entry', entryId: row.entryId, queueVersion: queue.version },
                action.id,
                payload,
              )}
            />
          ))}
        </Reorder.Group>
      </div>
    </div>
  );
}
