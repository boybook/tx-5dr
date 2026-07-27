import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import {
  Chip,
  ScrollShadow
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSortAmountDown } from '@fortawesome/free-solid-svg-icons';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useDisplayNotificationSettings } from '../../../hooks/useDisplayNotificationSettings';
import { type FrameTableCycleBackgrounds, getHighlightTypeLabels, HighlightType } from '../../../utils/displayNotificationSettings';
import { useTranslation } from 'react-i18next';
import { formatFrequencyMHz } from '../../../utils/frequencyMHz';
import { getBadgeColors, hexToRgba } from '../../../utils/colorUtils';
import { FlagDisplay } from '../../common/FlagDisplay';
import { ScrollToBottomButton } from '../../common/ScrollToBottomButton';
import { CallsignInfoPopover } from './CallsignInfoPopover';
import { BOTTOM_TOLERANCE_PX, TOP_TOLERANCE_PX, getBottomGroupSignature, shouldShowScrollToBottomButton } from './framesTableAutoScroll';
import { calculateGridDistance, extractBaseCallsign, FT8MessageParser, type GridLocation } from '@tx5dr/core';
import { FT8MessageType, type StrategyMessagePresentationProjection } from '@tx5dr/contracts';
import { resolvePluginLabel } from '../../../utils/pluginLocales';
import { resolveFrameCallsign } from './frameCallsign';
import {
  resolveFrameRowPresentation,
  resolveStrategyPresentationClass,
  type FrameRowMessageFacts,
} from './frameRowPresentation';

export interface FrameDisplayMessage {
  utc: string;
  db: number | 'TX';
  dt: number | '-';
  freq: number;
  message: string;
  operatorId?: string;
  streamId?: string;
  emphasisCallsigns?: string[];
  country?: string;
  countryZh?: string;
  countryEn?: string;
  countryCode?: string;
  flag?: string;
  locationCallsign?: string;
  /** Grid decoded from this exact frame, never the callsign tracker fallback. */
  locationGrid?: string;
  gridLocation?: GridLocation;
  state?: string;
  stateConfidence?: 'high' | 'low';
  logbookAnalysis?: {
    isNewCallsign?: boolean;
    isNewDxccEntity?: boolean;
    isNewBandDxccEntity?: boolean;
    isConfirmedDxcc?: boolean;
    isNewPrefix?: boolean;
    isNewGrid?: boolean;
    callsign?: string;
    grid?: string;
    prefix?: string;
    state?: string;
    stateConfidence?: 'high' | 'low';
    dxccEntity?: string;
    dxccId?: number;
    dxccStatus?: 'current' | 'deleted' | 'unknown' | 'none';
  };
}

export interface FrameGroup {
  time: string;       // HHMMSS，仅用于显示
  startMs: number;    // 对齐后的时隙起始时间戳（ms），用于排序
  messages: FrameDisplayMessage[];
  type: 'receive' | 'transmit';
  cycle: 'even' | 'odd'; // 偶数或奇数周期
  headerContextKey?: string;
  frequencyContext?: {
    frequency?: number;
    band?: string;
    mode?: string;
    radioMode?: string;
    description?: string;
  };
}

interface FramesTableProps {
  groups: FrameGroup[];
  className?: string;
  onRowDoubleClick?: (message: FrameDisplayMessage, group: FrameGroup) => void;
  myCallsigns?: string[]; // 自己的呼号列表
  targetCallsigns?: string[]; // 当前选中操作员的全部活动目标呼号
  /** Compatibility input for older callers. */
  targetCallsign?: string;
  onMessageHover?: (freq: number | null) => void; // 消息hover回调
  showLogbookAnalysisVisuals?: boolean; // 是否显示日志本分析的视觉效果（划线、标签等）
  enableCallsignPopover?: boolean; // 是否启用呼号信息浮层（hover国旗区域弹出）
  scrollToBottomTrigger?: number; // 外部触发滚动到底部（递增时触发）
  showGroupHeader?: boolean; // 是否在周期组前显示轻量上下文标题
  shouldShowGroupHeader?: (group: FrameGroup, index: number, groups: FrameGroup[]) => boolean;
  groupHeaderBand?: string | null; // 当前波段，用于截图上下文
  groupHeaderMode?: string | null; // 当前模式名，如 "FT8"
  queueCallsignOrder?: Readonly<Record<string, number>>; // 服务端队列投影中的呼号顺序
  strategyName?: string;
  strategyMessagePresentation?: StrategyMessagePresentationProjection;
  enableSorting?: boolean;
  distanceOriginGrid?: string;
}

const EMPTY_QUEUE_CALLSIGN_ORDER: Readonly<Record<string, number>> = {};

export type FrameSortKey = 'db' | 'distance';
export type FrameSortState = FrameSortKey | null;

export const toggleFrameSort = (current: FrameSortState, key: FrameSortKey): FrameSortState => (
  current === key ? null : key
);

export const getFrameSortValue = (
  message: FrameDisplayMessage,
  key: FrameSortKey,
  distanceOriginGrid?: string,
): number | null => {
  if (key === 'db') {
    return typeof message.db === 'number' && Number.isFinite(message.db) ? message.db : null;
  }

  if (!distanceOriginGrid) return null;
  const grid = message.locationGrid ?? message.logbookAnalysis?.grid;
  if (!grid) return null;
  const distance = calculateGridDistance(distanceOriginGrid, grid);
  return distance !== null && Number.isFinite(distance) ? distance : null;
};

export const sortFrameGroups = (
  groups: FrameGroup[],
  sortKey: FrameSortState,
  distanceOriginGrid?: string,
): FrameGroup[] => {
  if (!sortKey) return groups;

  return groups.map((group) => {
    const rankedMessages = group.messages.map((message, index) => ({
      message,
      index,
      value: getFrameSortValue(message, sortKey, distanceOriginGrid),
    }));

    rankedMessages.sort((left, right) => {
      if (left.value === null && right.value === null) return left.index - right.index;
      if (left.value === null) return 1;
      if (right.value === null) return -1;
      return right.value - left.value || left.index - right.index;
    });

    return {
      ...group,
      messages: rankedMessages.map(({ message }) => message),
    };
  });
};

// ─── 纯函数工具（提取到组件外避免重复创建）────────

const cleanCallsignForMatching = (word: string): string => {
  if (word.startsWith('<') && word.endsWith('>')) {
    return word.slice(1, -1);
  }
  return word;
};

const isSpecialMessageType = (message: string): boolean => {
  try {
    const type = FT8MessageParser.parseMessage(message).type;
    return type === FT8MessageType.CQ
      || type === FT8MessageType.RRR
      || type === FT8MessageType.SEVENTY_THREE
      || type === FT8MessageType.FOX_RR73;
  } catch {
    return false;
  }
};

const containsMyCallsign = (message: string, myCallsigns: string[]): boolean => {
  if (!myCallsigns || myCallsigns.length === 0) return false;
  const upperMessage = message.toUpperCase();
  return myCallsigns.some(callsign => {
    const upperCallsign = callsign.toUpperCase().trim();
    if (!upperCallsign) return false;
    const words = upperMessage.split(/\s+/);
    return words.some(word => cleanCallsignForMatching(word) === upperCallsign);
  });
};

export const isTargetRelated = (messageObj: FrameDisplayMessage, targetCallsigns: string[]): boolean => {
  const normalizedTargets = new Set(targetCallsigns.map((callsign) => callsign.trim().toUpperCase()).filter(Boolean));
  if (normalizedTargets.size === 0) return false;
  if (messageObj.db === 'TX') {
    const upperMessage = messageObj.message.toUpperCase();
    const words = upperMessage.split(/\s+/);
    return words.some(word => normalizedTargets.has(cleanCallsignForMatching(word)));
  }
  if (messageObj.logbookAnalysis?.callsign) {
    return normalizedTargets.has(messageObj.logbookAnalysis.callsign.toUpperCase().trim());
  }
  return false;
};

export function resolveQueuedFrameOrder(
  message: FrameDisplayMessage,
  queueCallsignOrder: Readonly<Record<string, number>>,
): number | undefined {
  if (Object.keys(queueCallsignOrder).length === 0) return undefined;
  const callsign = extractBaseCallsign(resolveFrameCallsign(message) ?? '');
  return callsign ? queueCallsignOrder[callsign] : undefined;
}

export const resolveFrameLocationDisplay = (
  message: FrameDisplayMessage,
  isZh: boolean,
  isNarrow: boolean,
): { callsign: string; displayName: string; text: string; conflictGrid?: string } | null => {
  const callsign = message.locationCallsign?.trim();
  const displayName = isZh
    ? (message.countryZh || message.countryEn || message.country)
    : (message.countryEn || message.country);
  if (!callsign || !displayName) return null;
  const gridLocation = message.gridLocation;
  const isConflict = gridLocation?.status === 'conflict';
  return {
    callsign,
    displayName,
    text: isNarrow ? (displayName.split('·')[1] || displayName) : displayName,
    conflictGrid: isConflict ? message.locationGrid : undefined,
  };
};

export function resolveStrategyMessagePresentationClass(
  message: FrameDisplayMessage,
  group: FrameGroup,
  projection?: StrategyMessagePresentationProjection,
): ReturnType<typeof resolveStrategyPresentationClass> {
  return resolveStrategyPresentationClass(buildMessageFacts(message, group, projection), projection);
}

function buildMessageFacts(
  message: FrameDisplayMessage,
  group: FrameGroup,
  projection?: StrategyMessagePresentationProjection,
): FrameRowMessageFacts {
  const partition = projection?.partitionBy === 'mode'
    ? group.frequencyContext?.mode
    : projection?.partitionBy === 'none'
      ? undefined
      : group.frequencyContext?.band;
  return {
    isTx: message.db === 'TX',
    rawText: message.message,
    callsign: resolveFrameCallsign(message),
    grid: message.locationGrid ?? message.logbookAnalysis?.grid,
    partition,
  };
}

const formatGroupHeaderTime = (startMs: number): string => {
  const date = new Date(startMs);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
};

const formatGroupHeaderLabel = (
  group: FrameGroup,
  t: (key: string, options?: Record<string, string>) => string,
  band?: string | null,
  mode?: string | null,
): string => {
  const timeLabel = formatGroupHeaderTime(group.startMs);
  const context = group.frequencyContext;
  if (context) {
    const frequencyLabel = typeof context.frequency === 'number' && Number.isFinite(context.frequency)
      ? `${formatFrequencyMHz(context.frequency)} MHz`
      : context.description;
    const parts = [frequencyLabel, context.band, context.mode, timeLabel].filter(Boolean);
    return parts.length > 0
      ? t('common:framesTable.startedAt', { context: parts.join(' · ') })
      : timeLabel;
  }

  const parts = [timeLabel, band, mode].filter(Boolean);
  return parts.join(' · ');
};

// ─── Memo 化的消息行组件 ─────────────────────

interface MessageRowProps {
  message: FrameDisplayMessage;
  group: FrameGroup;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  gridCols: string;
  isNarrow: boolean;
  myCallsigns: string[];
  targetCallsigns: string[];
  showLogbookAnalysisVisuals: boolean;
  enableCallsignPopover: boolean;
  queueCallsignOrder: Readonly<Record<string, number>>;
  strategyName?: string;
  strategyMessagePresentation?: StrategyMessagePresentationProjection;
  cycleBackgrounds: FrameTableCycleBackgrounds['light'];
  isZh: boolean;
  highlightTypeLabels: Record<string, string>;
  getHighestPriorityHighlight: (analysis: NonNullable<FrameDisplayMessage['logbookAnalysis']>) => HighlightType | null;
  getHighlightColor: (type: HighlightType) => string;
  onDoubleClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const MessageRow = React.memo<MessageRowProps>(({
  message, group, isFirstInGroup, isLastInGroup, gridCols, isNarrow, myCallsigns, targetCallsigns,
  showLogbookAnalysisVisuals, enableCallsignPopover, queueCallsignOrder, strategyName, strategyMessagePresentation,
  cycleBackgrounds, isZh, highlightTypeLabels,
  getHighestPriorityHighlight, getHighlightColor,
  onDoubleClick, onMouseEnter, onMouseLeave,
}) => {
  const emphasisCallsigns = useMemo(
    () => Array.from(new Set([...(myCallsigns ?? []), ...(message.emphasisCallsigns ?? [])])),
    [message.emphasisCallsigns, myCallsigns],
  );
  const hasMyCallsign = containsMyCallsign(message.message, emphasisCallsigns);
  const presentation = useMemo(() => {
    const highlightType = message.db !== 'TX' && message.logbookAnalysis
      ? getHighestPriorityHighlight(message.logbookAnalysis)
      : null;
    return resolveFrameRowPresentation({
      facts: buildMessageFacts(message, group, strategyMessagePresentation),
      strategy: strategyMessagePresentation,
      logbook: {
        enabled: showLogbookAnalysisVisuals,
        worked: message.db !== 'TX' && message.logbookAnalysis?.isNewCallsign === false,
        isSpecialMessage: isSpecialMessageType(message.message),
        highlight: highlightType ? {
          label: highlightTypeLabels[highlightType],
          color: getHighlightColor(highlightType),
        } : undefined,
      },
    });
  }, [
    getHighlightColor,
    getHighestPriorityHighlight,
    group,
    highlightTypeLabels,
    message,
    showLogbookAnalysisVisuals,
    strategyMessagePresentation,
  ]);
  const isWorkedCallsign = presentation.textDecoration === 'line-through';
  const isTarget = isTargetRelated(message, targetCallsigns);
  const queuedOrder = useMemo(
    () => resolveQueuedFrameOrder(message, queueCallsignOrder),
    [message, queueCallsignOrder],
  );

  // Hover style
  const hoverStyle = useMemo(() => {
    if (message.db === 'TX') return {};
    if (presentation.highlightedHover && presentation.color) {
      const opacity = group.cycle === 'even' ? 0.3 : 0.35;
      return { '--hover-bg': hexToRgba(presentation.color, opacity) } as React.CSSProperties;
    }
    return {
      '--hover-bg': group.cycle === 'even' ? cycleBackgrounds.even : cycleBackgrounds.odd
    } as React.CSSProperties;
  }, [message.db, presentation.highlightedHover, presentation.color, group.cycle, cycleBackgrounds.even, cycleBackgrounds.odd]);

  const presentationStyle = useMemo(() => {
    if (!presentation.background || !presentation.color || message.db === 'TX') {
      return {};
    }
    const opacity = group.cycle === 'even' ? 0.15 : 0.2;
    return { backgroundColor: hexToRgba(presentation.color, opacity) } as React.CSSProperties;
  }, [presentation.background, presentation.color, group.cycle, message.db]);

  const rightBorderColor = message.db !== 'TX' && presentation.accent ? presentation.color : undefined;

  const formattedUtc = isNarrow ? message.utc.replace(/:/g, '') : message.utc;

  const locationNode = useMemo(() => {
    const location = resolveFrameLocationDisplay(message, isZh, isNarrow);
    if (!location) return null;
    const inner = (
      <div className={`flex min-w-0 items-center justify-end gap-1 ${isNarrow ? 'max-w-[80px]' : 'max-w-[140px]'}`}>
        {location.conflictGrid && (
          <span className="shrink-0 whitespace-nowrap text-xs">* {location.conflictGrid}</span>
        )}
        <span className="min-w-0 truncate whitespace-nowrap text-xs" title={location.displayName}>
          {location.text}
        </span>
        <FlagDisplay flag={message.flag} countryCode={message.countryCode} />
      </div>
    );
    if (enableCallsignPopover) {
      return (
        <CallsignInfoPopover
          callsign={location.callsign}
          logbookAnalysis={message.logbookAnalysis}
          country={message.country}
          countryZh={message.countryZh}
          countryEn={message.countryEn}
          countryCode={message.countryCode}
          flag={message.flag}
          directGrid={message.locationGrid}
          directGridLocation={message.gridLocation}
          state={message.state}
          stateConfidence={message.stateConfidence}
        >
          {inner}
        </CallsignInfoPopover>
      );
    }
    return inner;
  }, [isZh, isNarrow, message, enableCallsignPopover]);

  const badgeNodes = useMemo(() => presentation.badges.map((badge, index) => {
    const label = badge.strategyLabel && strategyName
      ? resolvePluginLabel(badge.label, strategyName)
      : badge.label;
    if (badge.color) {
      const badgeColors = getBadgeColors(badge.color, true);
      return (
        <Chip
          key={`${badge.label}:${index}`}
          size="sm"
          variant="flat"
          className="h-4 font-medium"
          style={{
            backgroundColor: badgeColors.backgroundColor,
            color: badgeColors.textColor,
            borderColor: badgeColors.borderColor,
            borderWidth: '1px',
            borderStyle: 'solid',
          }}
        >
          {label}
        </Chip>
      );
    }
    const color = badge.tone === 'neutral' ? 'default' : badge.tone;
    return (
      <Chip key={`${badge.label}:${index}`} size="sm" variant="flat" color={color} className="h-4 font-medium">
        {label}
      </Chip>
    );
  }), [presentation.badges, strategyName]);

  return (
    <div
      data-presentation-source={presentation.source}
      data-presentation-badges={presentation.badges.map((badge) => badge.label).join(',')}
      className={`
        ft8-row
        transition-colors duration-150
        grid ${gridCols} gap-0 ${isNarrow ? 'px-2' : 'px-3'} py-0.5 ml-1 relative
        ${message.db !== 'TX' ? 'hover:[background-color:var(--hover-bg)]' : ''}
      `}
      style={{
        ...(message.db === 'TX' ? { backgroundColor: 'var(--ft8-tx-row-bg)' } : {}),
        ...hoverStyle,
        ...presentationStyle,
      }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {queuedOrder !== undefined && (
        <div
          aria-hidden="true"
          data-queue-order={queuedOrder}
          className={`pointer-events-none absolute -left-1 z-[1] flex w-3 items-center justify-center bg-primary pl-1 text-[7px] font-semibold leading-none tabular-nums text-primary-foreground ${
            isFirstInGroup ? '-top-1' : 'top-0'
          } ${isLastInGroup ? '-bottom-1' : 'bottom-0'}`}
        >
          {queuedOrder}
        </div>
      )}
      {/* Final row presentation owns the accent; the renderer does not inspect business state. */}
      {rightBorderColor && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1"
          style={{ backgroundColor: rightBorderColor }}
        />
      )}
      <div className="text-xs font-mono">{formattedUtc}</div>
      <div className="text-xs text-right font-mono">
        {message.db === 'TX' ? (
          <div className="flex justify-end">
            <Chip size="sm" color="danger" variant="flat" className="h-4">TX</Chip>
          </div>
        ) : (
          <span className="text-xs font-mono">{message.db}</span>
        )}
      </div>
      {!isNarrow && (
        <div className="text-xs text-right font-mono">
          {message.dt === '-' ? '-' : message.dt.toFixed(1)}
        </div>
      )}
      <div className="text-xs text-center font-mono">{message.freq}</div>
      <div className="min-w-0 text-xs font-mono">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
          {isTarget && (
            <span
              className="w-2 h-2 rounded-full bg-danger-500 flex-shrink-0 -ml-3"
              style={{
                animation: 'pulse-glow 2s ease-in-out infinite',
                boxShadow: '0 0 0 1.5px rgba(244, 63, 94, 0.1)'
              }}
            />
          )}
          <span
            className={`min-w-0 max-w-full whitespace-normal break-words ${hasMyCallsign ? 'font-semibold' : ''} ${message.db !== 'TX' && hasMyCallsign ? 'text-danger' : ''} ${isWorkedCallsign ? 'line-through' : ''} ${presentation.opacity === 'muted' || isWorkedCallsign ? 'opacity-70' : ''}`}
          >
            {message.message}
          </span>
          {badgeNodes}
        </span>
      </div>
      <div className={`pl-1 text-xs text-right ${isNarrow ? '' : 'pr-1'}`}>
        {locationNode}
      </div>
    </div>
  );
});
MessageRow.displayName = 'MessageRow';

// ─── 主组件 ─────────────────────────────────

export const FramesTable: React.FC<FramesTableProps> = ({ groups, className = '', onRowDoubleClick, myCallsigns = [], targetCallsigns = [], targetCallsign = '', onMessageHover, showLogbookAnalysisVisuals = true, enableCallsignPopover = false, scrollToBottomTrigger, showGroupHeader = false, shouldShowGroupHeader: shouldShowGroupHeaderPredicate, groupHeaderBand = null, groupHeaderMode = null, queueCallsignOrder = EMPTY_QUEUE_CALLSIGN_ORDER, strategyName, strategyMessagePresentation, enableSorting = false, distanceOriginGrid }) => {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language === 'zh';
  const highlightTypeLabels = useMemo(() => getHighlightTypeLabels(t), [t]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const previousBottomGroupSignatureRef = useRef('');
  const [scrollRequestVersion, setScrollRequestVersion] = useState(0);
  const [wasAtBottom, setWasAtBottom] = useState(true);
  const [isAtTop, setIsAtTop] = useState(true);
  const [isNarrow, setIsNarrow] = useState(false);
  const [sortKey, setSortKey] = useState<FrameSortState>(null);
  const activeTargetCallsigns = useMemo(
    () => Array.from(new Set([...targetCallsigns, targetCallsign].map((callsign) => callsign.trim()).filter(Boolean))),
    [targetCallsign, targetCallsigns],
  );
  const [activeTheme, setActiveTheme] = useState<'light' | 'dark'>(() => (
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  ));
  const { settings, getHighestPriorityHighlight, getHighlightColor, isHighlightEnabled: _isHighlightEnabled } = useDisplayNotificationSettings();
  const cycleBackgrounds = settings.frameTableCycleBackgrounds[activeTheme];
  const shouldShowGroupHeader = showGroupHeader && settings.frameTableGroupHeaderEnabled;
  const sortedGroups = useMemo(
    () => enableSorting ? sortFrameGroups(groups, sortKey, distanceOriginGrid) : groups,
    [distanceOriginGrid, enableSorting, groups, sortKey],
  );
  const bottomGroupSignature = useMemo(() => getBottomGroupSignature(sortedGroups), [sortedGroups]);

  const handleSortClick = useCallback((key: FrameSortKey) => {
    setSortKey((current) => enableSorting ? toggleFrameSort(current, key) : current);
  }, [enableSorting]);

  const getSortHeaderLabel = useCallback((key: FrameSortKey, label: string) => {
    if (sortKey === key) {
      return t('common:framesTable.sortReset', { field: label });
    }
    return t(key === 'db' ? 'common:framesTable.sortDbDescending' : 'common:framesTable.sortDistanceDescending');
  }, [sortKey, t]);

  const renderSortableHeader = useCallback((
    key: FrameSortKey,
    label: string,
    className: string,
  ) => {
    if (!enableSorting) {
      return <div className={className}>{label}</div>;
    }

    const isActive = sortKey === key;
    const sortLabel = getSortHeaderLabel(key, label);
    return (
      <button
        type="button"
        className={`${className} relative w-full cursor-pointer rounded-sm text-default-400 outline-none transition-colors hover:text-default-600 focus-visible:bg-default-100 focus-visible:text-default-700`}
        title={sortLabel}
        aria-label={sortLabel}
        aria-pressed={isActive}
        onClick={() => handleSortClick(key)}
      >
        <span>{label}</span>
        {isActive && (
          <FontAwesomeIcon
            icon={faSortAmountDown}
            aria-hidden="true"
            className="ml-1 text-[9px]"
          />
        )}
      </button>
    );
  }, [enableSorting, getSortHeaderLabel, handleSortClick, sortKey]);



  // ─── 组级别虚拟化 ────────────────────────
  const virtualizer = useVirtualizer({
    count: sortedGroups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      // 每组高度 ≈ py-1 (8px) + 每行约 24px + space-y-1 间距 (4px)
      const headerHeight = shouldShowGroupHeader ? 16 : 0;
      return sortedGroups[index].messages.length * 24 + headerHeight + 8 + 4;
    },
    overscan: 5,
  });

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [shouldShowGroupHeader, virtualizer]);

  // ─── 自动滚动到底部（与原始逻辑一致）─────
  const checkIfAtBottom = useCallback(() => {
    if (!scrollRef.current) return false;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    return scrollTop + clientHeight >= scrollHeight - BOTTOM_TOLERANCE_PX;
  }, []);

  const checkIfAtTop = useCallback(() => {
    if (!scrollRef.current) return true;
    return scrollRef.current.scrollTop <= TOP_TOLERANCE_PX;
  }, []);

  const syncScrollPositionState = useCallback(() => {
    const atBottom = checkIfAtBottom();
    const atTop = checkIfAtTop();
    followBottomRef.current = atBottom;
    setWasAtBottom(atBottom);
    setIsAtTop(atTop);
    return atBottom;
  }, [checkIfAtBottom, checkIfAtTop]);

  const requestScrollToBottom = useCallback((forceFollow = false) => {
    if (groups.length === 0) {
      return;
    }
    if (forceFollow) {
      followBottomRef.current = true;
    }
    setScrollRequestVersion(prev => prev + 1);
  }, [sortedGroups.length]);

  const handleScroll = useCallback(() => {
    syncScrollPositionState();
  }, [syncScrollPositionState]);

  const handleScrollToBottomClick = useCallback(() => {
    followBottomRef.current = true;
    setWasAtBottom(true);
    setIsAtTop(false);
    requestScrollToBottom(true);
  }, [requestScrollToBottom]);

  // Manually control ScrollShadow visibility to work correctly with virtual scrolling
  const scrollShadowVisibility = useMemo(() => {
    if (isAtTop && wasAtBottom) return 'none' as const;
    if (isAtTop) return 'bottom' as const;
    if (wasAtBottom) return 'top' as const;
    return 'both' as const;
  }, [isAtTop, wasAtBottom]);

  useEffect(() => {
    if (!bottomGroupSignature) {
      previousBottomGroupSignatureRef.current = '';
      followBottomRef.current = true;
      setWasAtBottom(true);
      setIsAtTop(true);
      return;
    }

    const previousSignature = previousBottomGroupSignatureRef.current;
    previousBottomGroupSignatureRef.current = bottomGroupSignature;

    if (!previousSignature) {
      requestScrollToBottom(true);
      return;
    }

    if (previousSignature !== bottomGroupSignature && followBottomRef.current) {
      requestScrollToBottom();
    }
  }, [bottomGroupSignature, requestScrollToBottom]);

  // 外部触发（如 tab 切回时）滚动到底部
  useEffect(() => {
    if (scrollToBottomTrigger && scrollToBottomTrigger > 0) {
      requestScrollToBottom(true);
    }
  }, [scrollToBottomTrigger, requestScrollToBottom]);

  useLayoutEffect(() => {
    if (scrollRequestVersion === 0 || sortedGroups.length === 0 || !followBottomRef.current) {
      return;
    }

    virtualizer.scrollToIndex(sortedGroups.length - 1, { align: 'end' });
  }, [scrollRequestVersion, sortedGroups.length, virtualizer]);

  // ─── 监听容器宽度变化 ─────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsNarrow(entry.contentRect.width < 550);
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const syncTheme = () => {
      setActiveTheme(root.classList.contains('dark') ? 'dark' : 'light');
    };
    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // ─── Hover 回调 ─────────────────────────
  const handleMessageEnter = useCallback((freq: number) => {
    onMessageHover?.(freq);
  }, [onMessageHover]);

  const handleMessageLeave = useCallback(() => {
    onMessageHover?.(null);
  }, [onMessageHover]);

  const getGroupColor = (_cycle: 'even' | 'odd', _type: 'receive' | 'transmit') => {
    return '';
  };

  const getGroupStyle = (cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit') {
      return { backgroundColor: 'var(--ft8-tx-group-bg)' };
    }
    return {
      backgroundColor: cycle === 'even' ? cycleBackgrounds.even : cycleBackgrounds.odd
    };
  };

  const getBorderColor = (cycle: 'even' | 'odd', _type: 'receive' | 'transmit') => {
    return cycle === 'even' ? 'var(--ft8-cycle-even)' : 'var(--ft8-cycle-odd)';
  };

  // ─── 列宽 ──────────────────────────────
  const gridCols = isNarrow
    ? 'grid-cols-[42px_36px_52px_minmax(0,1fr)_auto]'
    : 'grid-cols-[56px_40px_40px_64px_minmax(0,1fr)_auto]';
  const showScrollToBottomButton = shouldShowScrollToBottomButton(sortedGroups, wasAtBottom);

  if (groups.length === 0) {
    return null;
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <>
      {/* 添加呼吸发光动画 */}
      <style>{`
        @keyframes pulse-glow {
          0%, 100% {
            box-shadow: 0 0 0 1.5px rgba(244, 63, 94, 0.1);
          }
          50% {
            box-shadow: 0 0 0 3px rgba(244, 63, 94, 0.3);
          }
        }
      `}</style>
      <div
        ref={containerRef}
        data-strategy-presentation={strategyMessagePresentation ? 'active' : 'none'}
        className={`${className} relative flex flex-col rounded-lg overflow-hidden cursor-default`}
      >
        {/* 固定表头 */}
        <div className="flex-shrink-0 cursor-default select-none">
          <div className={`grid ${gridCols} gap-0 ${isNarrow ? 'px-2' : 'px-3'} py-1`}>
            <div className={`text-left text-xs font-medium text-default-400 ${isNarrow ? '' : 'pl-1'}`}>UTC</div>
            {renderSortableHeader('db', 'dB', 'text-right text-xs font-medium text-default-400')}
            {!isNarrow && <div className="text-right text-xs font-medium text-default-400">DT</div>}
            <div className="text-center text-xs font-medium text-default-400">{t('common:framesTable.freq')}</div>
            <div className="text-left text-xs font-medium text-default-400">{t('common:framesTable.message')}</div>
            {renderSortableHeader(
              'distance',
              t('common:framesTable.location'),
              `text-right text-xs font-medium text-default-400 ${isNarrow ? '' : 'pr-1'}`,
            )}
          </div>
        </div>

        {/* 滚动内容区域 */}
        <ScrollShadow
          ref={scrollRef}
          className="flex-1"
          onScroll={handleScroll}
          visibility={scrollShadowVisibility}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {/* 与原始结构一致的 space-y-1 pt-1 通过 absolute 定位实现 */}
            {virtualItems.map((vItem) => {
              const group = sortedGroups[vItem.index];

              return (
                <div
                  key={vItem.key}
                  data-index={vItem.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  {/* 组间距（对应原始的 space-y-1 pt-1） */}
                  <div className="pt-1">
                    {shouldShowGroupHeader && (!shouldShowGroupHeaderPredicate || shouldShowGroupHeaderPredicate(group, vItem.index, sortedGroups)) && (
                      <div className={`ml-1 truncate ${isNarrow ? 'px-2' : 'px-3'} pb-0.5 text-[10px] font-mono leading-4 tracking-[0.08em] text-default-400/80`}>
                        {formatGroupHeaderLabel(group, t, groupHeaderBand, groupHeaderMode)}
                      </div>
                    )}

                    {/* 组容器：与原始结构完全一致 */}
                    <div
                      className={`
                        ${getGroupColor(group.cycle, group.type)}
                        rounded-md overflow-hidden relative py-1
                      `}
                      style={getGroupStyle(group.cycle, group.type)}
                    >
                      {/* 左侧装饰条：与原始完全一致 */}
                      <div
                        className="absolute left-0 top-1 bottom-1 z-[2] w-1 rounded-sm"
                        style={{
                          backgroundColor: getBorderColor(group.cycle, group.type)
                        }}
                      ></div>

                      {group.messages.map((message, messageIndex) => (
                        <MessageRow
                          key={`${message.utc}-${messageIndex}`}
                          message={message}
                          group={group}
                          isFirstInGroup={messageIndex === 0}
                          isLastInGroup={messageIndex === group.messages.length - 1}
                          gridCols={gridCols}
                          isNarrow={isNarrow}
                          myCallsigns={myCallsigns}
                          targetCallsigns={activeTargetCallsigns}
                          showLogbookAnalysisVisuals={showLogbookAnalysisVisuals}
                          enableCallsignPopover={enableCallsignPopover}
                          queueCallsignOrder={queueCallsignOrder}
                          strategyName={strategyName}
                          strategyMessagePresentation={strategyMessagePresentation}
                          cycleBackgrounds={cycleBackgrounds}
                          isZh={isZh}
                          highlightTypeLabels={highlightTypeLabels}
                          getHighestPriorityHighlight={getHighestPriorityHighlight}
                          getHighlightColor={getHighlightColor}
                          onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(message, group) : undefined}
                          onMouseEnter={message.db !== 'TX' ? () => handleMessageEnter(message.freq) : undefined}
                          onMouseLeave={message.db !== 'TX' ? handleMessageLeave : undefined}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollShadow>

        {showScrollToBottomButton && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center px-3 transition-all duration-150 ease-out">
            <ScrollToBottomButton label={t('common:framesTable.scrollToBottom')} onPress={handleScrollToBottomClick} />
          </div>
        )}
      </div>
    </>
  );
};
