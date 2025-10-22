import React, { useState, useRef, useCallback, useEffect, createContext, useContext } from 'react';
import { Tabs, Tab } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faListUl, faMicrophone } from '@fortawesome/free-solid-svg-icons';

// 创建 Context 用于子组件切换 tab
interface SplitLayoutContextType {
  switchToRight: () => void;
}

const SplitLayoutContext = createContext<SplitLayoutContextType | null>(null);

// 导出 hook 供子组件使用
export const useSplitLayoutActions = () => {
  return useContext(SplitLayoutContext);
};

interface SplitLayoutProps {
  leftContent: React.ReactNode;
  rightContent: React.ReactNode;
  defaultLeftWidth?: number; // 百分比，默认50
  minLeftWidth?: number; // 最小宽度百分比，默认20
  maxLeftWidth?: number; // 最大宽度百分比，默认80
  leftLabel?: string; // 左侧标签名称，默认「解码」
  rightLabel?: string; // 右侧标签名称，默认「呼叫」
  className?: string;
}

export const SplitLayout: React.FC<SplitLayoutProps> = ({
  leftContent,
  rightContent,
  defaultLeftWidth = 50,
  minLeftWidth = 20,
  maxLeftWidth = 80,
  leftLabel = '解码',
  rightLabel = '呼叫',
  className = ''
}) => {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedTab, setSelectedTab] = useState<string>('left');
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number>(0);
  const dragStartWidth = useRef<number>(0);

  // 切换到右侧 tab 的函数
  const switchToRight = useCallback(() => {
    if (isMobile) {
      setSelectedTab('right');
    }
  }, [isMobile]);

  // 处理拖拽开始
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = leftWidth;
  }, [leftWidth]);

  // 处理拖拽移动
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const deltaX = e.clientX - dragStartX.current;
    const deltaPercent = (deltaX / containerRect.width) * 100;
    const newWidth = Math.max(
      minLeftWidth,
      Math.min(maxLeftWidth, dragStartWidth.current + deltaPercent)
    );

    setLeftWidth(newWidth);
  }, [isDragging, minLeftWidth, maxLeftWidth]);

  // 处理拖拽结束
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // 添加全局鼠标事件监听
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // 监听屏幕宽度变化，判断是否为移动端
  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');

    // 初始化
    setIsMobile(mediaQuery.matches);

    // 监听变化
    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  // 移动端布局
  if (isMobile) {
    return (
      <SplitLayoutContext.Provider value={{ switchToRight }}>
        <div
          ref={containerRef}
          className={`flex flex-col h-screen w-full ${className}`}
        >
          {/* 内容区域 */}
          <div className="flex-1 overflow-hidden relative">
            {/* 左侧面板 - 始终渲染，通过 hidden 控制显示 */}
            <div
              className={`absolute inset-0 overflow-hidden ${selectedTab !== 'left' ? 'hidden' : ''}`}
            >
              <div className="h-full overflow-auto bg-content2 dark:bg-content1">
                {leftContent}
              </div>
            </div>

            {/* 右侧面板 - 始终渲染，通过 hidden 控制显示 */}
            <div
              className={`absolute inset-0 overflow-hidden ${selectedTab !== 'right' ? 'hidden' : ''}`}
            >
              <div className="h-full overflow-auto bg-background">
                {rightContent}
              </div>
            </div>
          </div>

        {/* 底部 Tabs 导航 */}
        <div className="flex-shrink-0 border-t border-divider bg-content2">
          <Tabs
            aria-label="页面切换"
            selectedKey={selectedTab}
            onSelectionChange={(key) => setSelectedTab(key as string)}
            variant="light"
            size="lg"
            fullWidth
            classNames={{
              tabList: "w-full",
            }}
          >
            <Tab
              key="left"
              title={
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faListUl} className="text-sm" />
                  <span>{leftLabel}</span>
                </div>
              }
            />
            <Tab
              key="right"
              title={
                <div className="flex items-center gap-2">
                  <FontAwesomeIcon icon={faMicrophone} className="text-sm" />
                  <span>{rightLabel}</span>
                </div>
              }
            />
          </Tabs>
        </div>
        </div>
      </SplitLayoutContext.Provider>
    );
  }

  // 桌面端布局（保持原有拖拽功能）
  return (
    <div
      ref={containerRef}
      className={`flex h-screen w-full ${className}`}
    >
      {/* 左侧面板 */}
      <div
        className="flex-shrink-0 overflow-hidden"
        style={{ width: `${leftWidth}%` }}
      >

        <div className="h-full overflow-auto bg-content2 dark:bg-content1">
            {leftContent}
        </div>
      </div>

      {/* 拖拽分割线 */}
      <div
        className={`
          w-1 cursor-col-resize flex-shrink-0 group
          transition-all duration-200
          ${isDragging ? 'bg-primary-400' : 'bg-transparent hover:bg-primary-200'}
        `}
        onMouseDown={handleMouseDown}
      >
        {/* 拖拽手柄 - 只在hover或拖拽时显示 */}
        <div className="h-full w-full relative">
          <div className={`
            absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2
            transition-opacity duration-200
            ${isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
          `}>
            <div className="flex flex-col space-y-1">
              <div className="w-0.5 h-4 bg-default-600 rounded-full"></div>
              <div className="w-0.5 h-4 bg-default-600 rounded-full"></div>
              <div className="w-0.5 h-4 bg-default-600 rounded-full"></div>
            </div>
          </div>
        </div>
      </div>

      {/* 右侧面板 */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-auto bg-background">
            {rightContent}
        </div>
      </div>
    </div>
  );
};