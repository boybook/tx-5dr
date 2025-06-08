import React, { useRef, useEffect, useState } from 'react';
import {
  Chip,
  ScrollShadow
} from '@heroui/react';
import { useDisplayNotificationSettings } from '../hooks/useDisplayNotificationSettings';
import { HIGHLIGHT_TYPE_LABELS } from '../utils/displayNotificationSettings';
import { getBadgeColors, hexToRgba } from '../utils/colorUtils';

export interface FrameDisplayMessage {
  utc: string;
  db: number | 'TX';
  dt: number | '-';
  freq: number;
  message: string;
  country?: string;
  countryZh?: string;
  flag?: string;
  logbookAnalysis?: {
    isNewCallsign?: boolean;
    isNewPrefix?: boolean;
    isNewGrid?: boolean;
    callsign?: string;
    grid?: string;
    prefix?: string;
  };
}

export interface FrameGroup {
  time: string;
  messages: FrameDisplayMessage[];
  type: 'receive' | 'transmit';
  cycle: 'even' | 'odd'; // 偶数或奇数周期
}

interface FramesTableProps {
  groups: FrameGroup[];
  className?: string;
  onRowDoubleClick?: (message: FrameDisplayMessage, group: FrameGroup) => void;
  myCallsigns?: string[]; // 自己的呼号列表
}

export const FramesTable: React.FC<FramesTableProps> = ({ groups, className = '', onRowDoubleClick, myCallsigns = [] }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [wasAtBottom, setWasAtBottom] = useState(true);
  const [prevGroupsLength, setPrevGroupsLength] = useState(0);
  const { getHighestPriorityHighlight, getHighlightColor, isHighlightEnabled } = useDisplayNotificationSettings();

  // 检查是否滚动到底部
  const checkIfAtBottom = () => {
    if (!scrollRef.current) return false;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    // 允许5px的误差
    return scrollTop + clientHeight >= scrollHeight - 5;
  };

  // 滚动到底部
  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  // 处理滚动事件
  const handleScroll = () => {
    setWasAtBottom(checkIfAtBottom());
  };

  // 当groups更新时，如果之前在底部且有新数据，则自动滚动到底部
  useEffect(() => {
    const totalMessages = groups.reduce((sum, group) => sum + group.messages.length, 0);
    const hasNewData = totalMessages > prevGroupsLength;
    
    if (hasNewData && wasAtBottom) {
      // 使用setTimeout确保DOM已更新
      setTimeout(() => {
        scrollToBottom();
      }, 0);
    }
    
    setPrevGroupsLength(totalMessages);
  }, [groups, wasAtBottom, prevGroupsLength]);

  // 初始化时滚动到底部
  useEffect(() => {
    if (groups.length > 0) {
      setTimeout(() => {
        scrollToBottom();
      }, 0);
    }
  }, []);

  const getGroupColor = (cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit') {
      return 'bg-danger-50';
    }
    // 使用CSS变量设置背景颜色
    return '';
  };

  const getGroupStyle = (cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit') {
      return {};
    }
    return {
      backgroundColor: cycle === 'even' ? 'var(--ft8-cycle-even-bg)' : 'var(--ft8-cycle-odd-bg)'
    };
  };

  const getBorderColor = (cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit') {
      return '#f31260'; // 使用danger红色
    }
    return cycle === 'even' ? 'var(--ft8-cycle-even)' : 'var(--ft8-cycle-odd)';
  };

  const getRowHoverStyle = (cycle: 'even' | 'odd', type: 'receive' | 'transmit', message?: FrameDisplayMessage) => {
    if (message?.db === 'TX') {
      return {};
    }
    // 检查是否为特殊消息且有日志本分析
    if (message && message.logbookAnalysis && isSpecialMessageType(message.message)) {
      const highlightType = getHighestPriorityHighlight(message.logbookAnalysis);
      if (highlightType) {
        const baseColor = getHighlightColor(highlightType);
        // 生成协调的hover颜色，基于高亮颜色和周期
        const opacity = cycle === 'even' ? 0.3 : 0.35;
        return {
          '--hover-bg': hexToRgba(baseColor, opacity)
        } as React.CSSProperties;
      }
    }

    // 使用CSS变量的默认hover颜色，支持暗黑模式
    const evenHoverColor = 'var(--ft8-cycle-even-bg)';
    const oddHoverColor = 'var(--ft8-cycle-odd-bg)';
    
    return {
      '--hover-bg': cycle === 'even' ? evenHoverColor : oddHoverColor
    } as React.CSSProperties;
  };

  // 判断是否为特殊消息类型（CQ、RR73、RRR、73）
  const isSpecialMessageType = (message: string): boolean => {
    const upperMessage = message.toUpperCase().trim();
    return upperMessage.startsWith('CQ') || 
           upperMessage.includes('RR73') || 
           upperMessage.includes('RRR') || 
           upperMessage.includes(' 73') ||
           upperMessage.endsWith(' 73') ||
           upperMessage === '73';
  };

  // 根据日志本分析获取背景色（仅特殊消息类型使用全行背景色）
  const getLogbookAnalysisStyle = (message: FrameDisplayMessage, cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit' || message.db === 'TX' || !message.logbookAnalysis || !isSpecialMessageType(message.message)) {
      return {};
    }

    const highlightType = getHighestPriorityHighlight(message.logbookAnalysis);
    if (!highlightType) return {};

    const color = getHighlightColor(highlightType);
    const opacity = cycle === 'even' ? 0.15 : 0.2; // 降低透明度，让背景更淡

    return {
      backgroundColor: hexToRgba(color, opacity)
    } as React.CSSProperties;
  };

  // 获取右侧颜色条的颜色（所有有高亮的消息都显示）
  const getRightBorderColor = (message: FrameDisplayMessage, type: 'receive' | 'transmit') => {
    if (type === 'transmit' || message.db === 'TX' || !message.logbookAnalysis) {
      return null;
    }

    const highlightType = getHighestPriorityHighlight(message.logbookAnalysis);
    if (!highlightType) return null;

    return getHighlightColor(highlightType);
  };

  // 检查消息是否包含自己的呼号
  const containsMyCallsign = (message: string): boolean => {
    if (!myCallsigns || myCallsigns.length === 0) return false;
    
    const upperMessage = message.toUpperCase();
    return myCallsigns.some(callsign => {
      const upperCallsign = callsign.toUpperCase().trim();
      if (!upperCallsign) return false;
      
      // 检查完整单词匹配，避免部分匹配
      const words = upperMessage.split(/\s+/);
      return words.some(word => {
        // 移除常见的后缀（如 /QRP, /P 等）
        const cleanWord = word.replace(/\/[A-Z0-9]+$/, '');
        return cleanWord === upperCallsign;
      });
    });
  };

  const formatMessage = (messageObj: FrameDisplayMessage) => {
    // 如果是TX消息，忽略所有logbookAnalysis相关逻辑
    if (messageObj.db === 'TX') {
      return <span>{messageObj.message}</span>;
    }

    // 检查是否包含自己的呼号
    const hasMyCallsign = containsMyCallsign(messageObj.message);
    
    // 基础消息文本
    const showChips = messageObj.logbookAnalysis && isSpecialMessageType(messageObj.message);
    
    const content = (
      <span className="flex items-center gap-1">
        <span className={hasMyCallsign ? 'text-danger font-semibold' : ''}>{messageObj.message}</span>
        {showChips && (() => {
          const highlightType = getHighestPriorityHighlight(messageObj.logbookAnalysis!);
          if (!highlightType) return null;
          
          const baseColor = getHighlightColor(highlightType);
          const label = HIGHLIGHT_TYPE_LABELS[highlightType];
          const badgeColors = getBadgeColors(baseColor, true); // 特殊消息类型
          
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
        })()}
      </span>
    );
    
    return content;
  };

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={`${className} flex flex-col rounded-lg overflow-hidden cursor-default`}>
      {/* 固定表头 */}
      <div className="flex-shrink-0 cursor-default select-none">
        <div className="grid grid-cols-[60px_48px_48px_80px_1fr_96px] gap-0 px-3 py-1">
          <div className="text-left text-xs font-medium text-default-400 pl-1">UTC</div>
          <div className="text-right text-xs font-medium text-default-400">dB</div>
          <div className="text-right text-xs font-medium text-default-400">DT</div>
          <div className="text-center text-xs font-medium text-default-400">频率</div>
          <div className="text-left text-xs font-medium text-default-400">信息</div>
          <div className="text-right text-xs font-medium text-default-400 pr-1">位置</div>
        </div>
      </div>

      {/* 滚动内容区域 */}
      <ScrollShadow 
        ref={scrollRef}
        className="flex-1"
        onScroll={handleScroll}
      >
        <div className="space-y-1 pt-1">
          {groups.map((group, groupIndex) => (
            <div
              key={`${group.time}-${groupIndex}`}
              className={`
                ${getGroupColor(group.cycle, group.type)}
                rounded-md overflow-hidden relative py-1
              `}
              style={getGroupStyle(group.cycle, group.type)}
            >
              {/* 左侧装饰条 */}
              <div 
                className="absolute left-0 top-1 bottom-1 w-1 rounded-sm"
                style={{
                  backgroundColor: getBorderColor(group.cycle, group.type)
                }}
              ></div>
              
              {group.messages.map((message, messageIndex) => (
                <div
                  key={`${message.utc}-${messageIndex}`}
                  className={`
                    ft8-row
                    ${message.db === 'TX' ? 'bg-danger-100/70' : ''}
                    transition-colors duration-150
                    grid grid-cols-[60px_48px_48px_80px_1fr_96px] gap-0 px-3 py-0.5 ml-1 relative
                    ${message.db !== 'TX' ? 'hover:[background-color:var(--hover-bg)]' : ''}
                  `}
                  style={{
                    ...getRowHoverStyle(group.cycle, group.type, message),
                    ...getLogbookAnalysisStyle(message, group.cycle, group.type)
                  }}
                  onDoubleClick={() => onRowDoubleClick?.(message, group)}
                >
                  {/* 右侧颜色条（非特殊消息类型时显示） */}
                  {getRightBorderColor(message, group.type) && (
                    <div 
                      className="absolute right-0 top-0 bottom-0 w-1"
                      style={{
                        backgroundColor: getRightBorderColor(message, group.type)!
                      }}
                    />
                  )}
                  <div className="text-xs font-mono">
                    {message.utc}
                  </div>
                  <div className="text-xs text-right font-mono">
                    {message.db === 'TX' ? (
                      <div className="flex justify-end">
                        <Chip size="sm" color="danger" variant="flat" className="h-4">TX</Chip>
                      </div>
                    ) : (
                      <span className="text-xs font-mono">
                        {message.db}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-right font-mono">
                    {message.dt === '-' ? '-' : message.dt.toFixed(1)}
                  </div>
                  <div className="text-xs text-center font-mono">
                    {message.freq}
                  </div>
                  <div className="text-xs font-mono">
                    {formatMessage(message)}
                  </div>
                  <div className="text-xs text-right pr-1">
                    {(message.country || message.countryZh) && (
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-xs">
                          {message.countryZh || message.country}
                        </span>
                        {message.flag && <span>{message.flag}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </ScrollShadow>
    </div>
  );
}; 