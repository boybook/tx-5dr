import React, { useRef, useEffect, useState } from 'react';
import {
  Chip,
  ScrollShadow
} from '@heroui/react';

export interface FT8Message {
  utc: string;
  db: number | 'TX';
  dt: number | '-';
  freq: number;
  message: string;
  country?: string;
  countryZh?: string;
  flag?: string;
}

export interface FT8Group {
  time: string;
  messages: FT8Message[];
  type: 'receive' | 'transmit';
  cycle: 'even' | 'odd'; // 偶数或奇数周期
}

interface FT8TableProps {
  groups: FT8Group[];
  className?: string;
}

export const FT8Table: React.FC<FT8TableProps> = ({ groups, className = '' }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [wasAtBottom, setWasAtBottom] = useState(true);
  const [prevGroupsLength, setPrevGroupsLength] = useState(0);

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
      return 'bg-warning-50';
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
      return 'var(--ft8-tx)';
    }
    return cycle === 'even' ? 'var(--ft8-cycle-even)' : 'var(--ft8-cycle-odd)';
  };

  const getRowHoverColor = (cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit') {
      return 'hover:bg-warning-100';
    }
    // 使用CSS变量设置hover颜色，稍微加深一些
    return '';
  };

  const getRowHoverStyle = (cycle: 'even' | 'odd', type: 'receive' | 'transmit') => {
    if (type === 'transmit') {
      return {};
    }
    return {
      '--hover-bg': cycle === 'even' ? 'rgba(153, 255, 145, 0.35)' : 'rgba(255, 205, 148, 0.35)'
    } as React.CSSProperties;
  };

  const formatMessage = (message: string) => {
    // 直接返回消息文本，不添加任何样式
    return message;
  };

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className={`${className} flex flex-col rounded-lg overflow-hidden cursor-default`}>
      {/* 固定表头 */}
      <div className="flex-shrink-0">
        <div className="grid grid-cols-[80px_48px_48px_80px_1fr_96px] gap-0 px-3 py-1">
          <div className="text-left text-xs font-medium text-default-400 pl-1">UTC</div>
          <div className="text-left text-xs font-medium text-default-400">dB</div>
          <div className="text-left text-xs font-medium text-default-400">DT</div>
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
        <div className="space-y-1">
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
                    ${getRowHoverColor(group.cycle, group.type)}
                    ${message.db === 'TX' ? 'bg-warning-100/70' : ''}
                    transition-colors duration-150
                    grid grid-cols-[80px_48px_48px_80px_1fr_96px] gap-0 px-3 py-0.5 ml-1
                  `}
                  style={getRowHoverStyle(group.cycle, group.type)}
                >
                  <div className="text-xs font-mono">
                    {message.utc}
                  </div>
                  <div className="text-xs text-left font-mono">
                    {message.db === 'TX' ? (
                      <Chip size="sm" color="warning" variant="flat">TX</Chip>
                    ) : (
                      <span className="text-xs font-mono">
                        {message.db}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-left font-mono">
                    {message.dt === '-' ? '-' : message.dt.toFixed(1)}
                  </div>
                  <div className="text-xs text-center font-mono">
                    {message.freq}
                  </div>
                  <div className="text-xs font-mono">
                    {formatMessage(message.message)}
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