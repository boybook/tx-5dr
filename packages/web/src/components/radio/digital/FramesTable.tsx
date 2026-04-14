import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from 'react';
import {
  Chip,
  ScrollShadow
} from '@heroui/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useDisplayNotificationSettings } from '../../../hooks/useDisplayNotificationSettings';
import { getHighlightTypeLabels, HighlightType } from '../../../utils/displayNotificationSettings';
import { useTranslation } from 'react-i18next';
import { getBadgeColors, hexToRgba } from '../../../utils/colorUtils';
import { FlagDisplay } from '../../common/FlagDisplay';
import { CallsignInfoPopover } from './CallsignInfoPopover';
import { BOTTOM_TOLERANCE_PX, getBottomGroupSignature } from './framesTableAutoScroll';

export interface FrameDisplayMessage {
  utc: string;
  db: number | 'TX';
  dt: number | '-';
  freq: number;
  message: string;
  country?: string;
  countryZh?: string;
  countryEn?: string;
  countryCode?: string;
  flag?: string;
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
}

interface FramesTableProps {
  groups: FrameGroup[];
  className?: string;
  onRowDoubleClick?: (message: FrameDisplayMessage, group: FrameGroup) => void;
  myCallsigns?: string[]; // 自己的呼号列表
  targetCallsign?: string; // 当前选中操作员的目标呼号
  onMessageHover?: (freq: number | null) => void; // 消息hover回调
  showLogbookAnalysisVisuals?: boolean; // 是否显示日志本分析的视觉效果（划线、标签等）
  enableCallsignPopover?: boolean; // 是否启用呼号信息浮层（hover国旗区域弹出）
  scrollToBottomTrigger?: number; // 外部触发滚动到底部（递增时触发）
}

// ─── 纯函数工具（提取到组件外避免重复创建）────────

const cleanCallsignForMatching = (word: string): string => {
  if (word.startsWith('<') && word.endsWith('>')) {
    return word.slice(1, -1);
  }
  return word;
};

const isSpecialMessageType = (message: string): boolean => {
  const upperMessage = message.toUpperCase().trim();
  return upperMessage.startsWith('CQ') ||
    upperMessage.includes('RR73') ||
    upperMessage.includes('RRR') ||
    upperMessage.includes(' 73') ||
    upperMessage.endsWith(' 73') ||
    upperMessage === '73';
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

const isTargetRelated = (messageObj: FrameDisplayMessage, targetCallsign: string): boolean => {
  if (!targetCallsign || targetCallsign.trim() === '') return false;
  const upperTarget = targetCallsign.toUpperCase().trim();
  if (messageObj.db === 'TX') {
    const upperMessage = messageObj.message.toUpperCase();
    const words = upperMessage.split(/\s+/);
    return words.some(word => cleanCallsignForMatching(word) === upperTarget);
  }
  if (messageObj.logbookAnalysis?.callsign) {
    return messageObj.logbookAnalysis.callsign.toUpperCase().trim() === upperTarget;
  }
  return false;
};

// ─── Memo 化的消息行组件 ─────────────────────

interface MessageRowProps {
  message: FrameDisplayMessage;
  group: FrameGroup;
  gridCols: string;
  isNarrow: boolean;
  myCallsigns: string[];
  targetCallsign: string;
  showLogbookAnalysisVisuals: boolean;
  enableCallsignPopover: boolean;
  isZh: boolean;
  highlightTypeLabels: Record<string, string>;
  getHighestPriorityHighlight: (analysis: NonNullable<FrameDisplayMessage['logbookAnalysis']>) => HighlightType | null;
  getHighlightColor: (type: HighlightType) => string;
  onDoubleClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const MessageRow = React.memo<MessageRowProps>(({
  message, group, gridCols, isNarrow, myCallsigns, targetCallsign,
  showLogbookAnalysisVisuals, enableCallsignPopover, isZh, highlightTypeLabels,
  getHighestPriorityHighlight, getHighlightColor,
  onDoubleClick, onMouseEnter, onMouseLeave,
}) => {
  const hasMyCallsign = message.db !== 'TX' && containsMyCallsign(message.message, myCallsigns);
  const isWorkedCallsign = showLogbookAnalysisVisuals && message.logbookAnalysis?.isNewCallsign === false;
  const isTarget = isTargetRelated(message, targetCallsign);
  const showChips = showLogbookAnalysisVisuals && message.db !== 'TX' && message.logbookAnalysis && isSpecialMessageType(message.message);

  // Hover style
  const hoverStyle = useMemo(() => {
    if (message.db === 'TX') return {};
    if (showLogbookAnalysisVisuals && message.logbookAnalysis && isSpecialMessageType(message.message)) {
      const ht = getHighestPriorityHighlight(message.logbookAnalysis);
      if (ht) {
        const baseColor = getHighlightColor(ht);
        const opacity = group.cycle === 'even' ? 0.3 : 0.35;
        return { '--hover-bg': hexToRgba(baseColor, opacity) } as React.CSSProperties;
      }
    }
    return {
      '--hover-bg': group.cycle === 'even' ? 'var(--ft8-cycle-even-bg)' : 'var(--ft8-cycle-odd-bg)'
    } as React.CSSProperties;
  }, [message.db, message.logbookAnalysis, message.message, showLogbookAnalysisVisuals, group.cycle, getHighestPriorityHighlight, getHighlightColor]);

  // Logbook analysis background style
  const logbookStyle = useMemo(() => {
    if (!showLogbookAnalysisVisuals || group.type === 'transmit' || message.db === 'TX' || !message.logbookAnalysis || !isSpecialMessageType(message.message)) {
      return {};
    }
    const ht = getHighestPriorityHighlight(message.logbookAnalysis);
    if (!ht) return {};
    const color = getHighlightColor(ht);
    const opacity = group.cycle === 'even' ? 0.15 : 0.2;
    return { backgroundColor: hexToRgba(color, opacity) } as React.CSSProperties;
  }, [showLogbookAnalysisVisuals, group.type, group.cycle, message.db, message.logbookAnalysis, message.message, getHighestPriorityHighlight, getHighlightColor]);

  // Right border color
  const rightBorderColor = useMemo(() => {
    if (group.type === 'transmit' || message.db === 'TX' || !message.logbookAnalysis) return null;
    const ht = getHighestPriorityHighlight(message.logbookAnalysis);
    if (!ht) return null;
    return getHighlightColor(ht);
  }, [group.type, message.db, message.logbookAnalysis, getHighestPriorityHighlight, getHighlightColor]);

  const formattedUtc = isNarrow ? message.utc.replace(/:/g, '') : message.utc;

  // Format location
  const locationNode = useMemo(() => {
    const displayName = isZh
      ? (message.countryZh || message.countryEn || message.country)
      : (message.countryEn || message.country);
    if (!displayName) return null;
    const text = isNarrow ? (displayName.split('·')[1] || displayName) : displayName;
    const inner = (
      <div className="flex min-w-0 items-center justify-end gap-1">
        <span className="min-w-0 truncate whitespace-nowrap text-xs" title={displayName}>
          {text}
        </span>
        <FlagDisplay flag={message.flag} countryCode={message.countryCode} />
      </div>
    );
    if (enableCallsignPopover && message.logbookAnalysis?.callsign) {
      return (
        <CallsignInfoPopover
          callsign={message.logbookAnalysis.callsign}
          logbookAnalysis={message.logbookAnalysis}
          country={message.country}
          countryZh={message.countryZh}
          countryEn={message.countryEn}
          countryCode={message.countryCode}
          flag={message.flag}
          state={message.state}
          stateConfidence={message.stateConfidence}
        >
          {inner}
        </CallsignInfoPopover>
      );
    }
    return inner;
  }, [isZh, isNarrow, message.countryZh, message.countryEn, message.country, message.flag, message.countryCode, message.logbookAnalysis, message.state, message.stateConfidence, enableCallsignPopover]);

  // Chip for logbook analysis
  const chipNode = useMemo(() => {
    if (!showChips || !message.logbookAnalysis) return null;
    const ht = getHighestPriorityHighlight(message.logbookAnalysis);
    if (!ht) return null;
    const baseColor = getHighlightColor(ht);
    const label = highlightTypeLabels[ht];
    const badgeColors = getBadgeColors(baseColor, true);
    return (
      <Chip
        size="sm"
        variant="flat"
        className="h-4 font-medium"
        style={{
          backgroundColor: badgeColors.backgroundColor,
          color: badgeColors.textColor,
          borderColor: badgeColors.borderColor,
          borderWidth: '1px',
          borderStyle: 'solid'
        }}
      >
        {label}
      </Chip>
    );
  }, [showChips, message.logbookAnalysis, getHighestPriorityHighlight, getHighlightColor, highlightTypeLabels]);

  return (
    <div
      className={`
        ft8-row
        transition-colors duration-150
        grid ${gridCols} gap-0 ${isNarrow ? 'px-2' : 'px-3'} py-0.5 ml-1 relative
        ${message.db !== 'TX' ? 'hover:[background-color:var(--hover-bg)]' : ''}
      `}
      style={{
        ...(message.db === 'TX' ? { backgroundColor: 'var(--ft8-tx-row-bg)' } : {}),
        ...hoverStyle,
        ...logbookStyle,
      }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 右侧颜色条（非特殊消息类型时显示） */}
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
      <div className="text-xs font-mono">
        <span className="flex items-center gap-1">
          {isTarget && (
            <span
              className="w-2 h-2 rounded-full bg-danger-500 flex-shrink-0 -ml-3"
              style={{
                animation: 'pulse-glow 2s ease-in-out infinite',
                boxShadow: '0 0 0 1.5px rgba(244, 63, 94, 0.1)'
              }}
            />
          )}
          <span className={`${hasMyCallsign ? 'text-danger font-semibold' : ''} ${isWorkedCallsign ? 'line-through opacity-70' : ''}`}>
            {message.message}
          </span>
          {chipNode}
        </span>
      </div>
      <div className={`text-xs text-right ${isNarrow ? '' : 'pr-1'}`}>
        {locationNode}
      </div>
    </div>
  );
});
MessageRow.displayName = 'MessageRow';

// ─── 主组件 ─────────────────────────────────

export const FramesTable: React.FC<FramesTableProps> = ({ groups, className = '', onRowDoubleClick, myCallsigns = [], targetCallsign = '', onMessageHover, showLogbookAnalysisVisuals = true, enableCallsignPopover = false, scrollToBottomTrigger }) => {
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
  const { getHighestPriorityHighlight, getHighlightColor, isHighlightEnabled: _isHighlightEnabled } = useDisplayNotificationSettings();
  const bottomGroupSignature = useMemo(() => getBottomGroupSignature(groups), [groups]);



  // ─── 组级别虚拟化 ────────────────────────
  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      // 每组高度 ≈ py-1 (8px) + 每行约 24px + space-y-1 间距 (4px)
      return groups[index].messages.length * 24 + 8 + 4;
    },
    overscan: 5,
  });

  // ─── 自动滚动到底部（与原始逻辑一致）─────
  const checkIfAtBottom = useCallback(() => {
    if (!scrollRef.current) return false;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    return scrollTop + clientHeight >= scrollHeight - BOTTOM_TOLERANCE_PX;
  }, []);

  const checkIfAtTop = useCallback(() => {
    if (!scrollRef.current) return true;
    return scrollRef.current.scrollTop <= 5;
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
  }, [groups.length]);

  const handleScroll = useCallback(() => {
    syncScrollPositionState();
  }, [syncScrollPositionState]);

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
    if (scrollRequestVersion === 0 || groups.length === 0 || !followBottomRef.current) {
      return;
    }

    virtualizer.scrollToIndex(groups.length - 1, { align: 'end' });
  }, [groups.length, scrollRequestVersion, virtualizer]);

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
      backgroundColor: cycle === 'even' ? 'var(--ft8-cycle-even-bg)' : 'var(--ft8-cycle-odd-bg)'
    };
  };

  const getBorderColor = (cycle: 'even' | 'odd', _type: 'receive' | 'transmit') => {
    return cycle === 'even' ? 'var(--ft8-cycle-even)' : 'var(--ft8-cycle-odd)';
  };

  // ─── 列宽 ──────────────────────────────
  const gridCols = isNarrow
    ? 'grid-cols-[42px_36px_52px_1fr_80px]'
    : 'grid-cols-[56px_40px_40px_64px_1fr_140px]';

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
      <div ref={containerRef} className={`${className} flex flex-col rounded-lg overflow-hidden cursor-default`}>
      {/* 固定表头 */}
      <div className="flex-shrink-0 cursor-default select-none">
        <div className={`grid ${gridCols} gap-0 ${isNarrow ? 'px-2' : 'px-3'} py-1`}>
          <div className={`text-left text-xs font-medium text-default-400 ${isNarrow ? '' : 'pl-1'}`}>UTC</div>
          <div className="text-right text-xs font-medium text-default-400">dB</div>
          {!isNarrow && <div className="text-right text-xs font-medium text-default-400">DT</div>}
          <div className="text-center text-xs font-medium text-default-400">{t('common:framesTable.freq')}</div>
          <div className="text-left text-xs font-medium text-default-400">{t('common:framesTable.message')}</div>
          <div className={`text-right text-xs font-medium text-default-400 ${isNarrow ? '' : 'pr-1'}`}>{t('common:framesTable.location')}</div>
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
            const group = groups[vItem.index];

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
                      className="absolute left-0 top-1 bottom-1 w-1 rounded-sm"
                      style={{
                        backgroundColor: getBorderColor(group.cycle, group.type)
                      }}
                    ></div>

                    {group.messages.map((message, messageIndex) => (
                      <MessageRow
                        key={`${message.utc}-${messageIndex}`}
                        message={message}
                        group={group}
                        gridCols={gridCols}
                        isNarrow={isNarrow}
                        myCallsigns={myCallsigns}
                        targetCallsign={targetCallsign}
                        showLogbookAnalysisVisuals={showLogbookAnalysisVisuals}
                        enableCallsignPopover={enableCallsignPopover}
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
    </div>
    </>
  );
};
