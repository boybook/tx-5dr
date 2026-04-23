import React, { useState, useRef, useCallback, useEffect, createContext, useContext } from 'react';
import { Tabs, Tab } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faListUl, faMicrophone, faPuzzlePiece } from '@fortawesome/free-solid-svg-icons';
import { useTranslation } from 'react-i18next';

interface SplitLayoutContextType {
  switchToRight: () => void;
  selectedTab: string;
}

const SplitLayoutContext = createContext<SplitLayoutContextType | null>(null);

export const useSplitLayoutActions = () => {
  return useContext(SplitLayoutContext);
};

interface SplitLayoutProps {
  leftContent: React.ReactNode;
  rightContent: React.ReactNode;
  extraContent?: React.ReactNode;
  extraEnabled?: boolean;
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultExtraWidth?: number;
  minExtraWidth?: number;
  maxExtraWidth?: number;
  leftLabel?: string;
  rightLabel?: string;
  extraLabel?: string;
  className?: string;
}

type DragTarget = 'left' | 'extra' | null;

const MIN_CENTER_WIDTH = 18;

function Divider({ isDragging, onMouseDown }: { isDragging: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
  return (
    <div
      className={[
        'w-1 cursor-col-resize flex-shrink-0 group transition-all duration-200',
        isDragging ? 'bg-primary-400' : 'bg-transparent hover:bg-primary-200',
      ].join(' ')}
      onMouseDown={onMouseDown}
    >
      <div className="relative h-full w-full">
        <div
          className={[
            'absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transform transition-opacity duration-200',
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          ].join(' ')}
        >
          <div className="flex flex-col space-y-1">
            <div className="h-4 w-0.5 rounded-full bg-default-600"></div>
            <div className="h-4 w-0.5 rounded-full bg-default-600"></div>
            <div className="h-4 w-0.5 rounded-full bg-default-600"></div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const SplitLayout: React.FC<SplitLayoutProps> = ({
  leftContent,
  rightContent,
  extraContent,
  extraEnabled = false,
  defaultLeftWidth = 50,
  minLeftWidth = 20,
  maxLeftWidth = 80,
  defaultExtraWidth = 26,
  minExtraWidth = 18,
  maxExtraWidth = 38,
  leftLabel,
  rightLabel,
  extraLabel,
  className = '',
}) => {
  const { t } = useTranslation('common');
  const resolvedLeftLabel = leftLabel ?? t('splitLayout.decode');
  const resolvedRightLabel = rightLabel ?? t('splitLayout.call');
  const resolvedExtraLabel = extraLabel ?? t('splitLayout.plugin');
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [extraWidth, setExtraWidth] = useState(defaultExtraWidth);
  const prevDefaultLeftRef = useRef(defaultLeftWidth);
  const prevDefaultExtraRef = useRef(defaultExtraWidth);
  const [dragTarget, setDragTarget] = useState<DragTarget>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [selectedTab, setSelectedTab] = useState<string>('left');
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number>(0);
  const dragStartWidth = useRef<number>(0);

  const hasExtraPane = extraEnabled && extraContent !== undefined && extraContent !== null;

  const switchToRight = useCallback(() => {
    if (isMobile) {
      setSelectedTab('right');
    }
  }, [isMobile]);

  const handleMouseDown = useCallback((target: Exclude<DragTarget, null>) => (e: React.MouseEvent) => {
    e.preventDefault();
    setDragTarget(target);
    dragStartX.current = e.clientX;
    dragStartWidth.current = target === 'left' ? leftWidth : extraWidth;
  }, [extraWidth, leftWidth]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragTarget || !containerRef.current) return;

    const containerRect = containerRef.current.getBoundingClientRect();
    const deltaX = e.clientX - dragStartX.current;
    const deltaPercent = (deltaX / containerRect.width) * 100;

    if (dragTarget === 'left') {
      const maxLeftByCenter = hasExtraPane
        ? 100 - extraWidth - MIN_CENTER_WIDTH
        : 100 - MIN_CENTER_WIDTH;
      const nextLeft = Math.max(
        minLeftWidth,
        Math.min(Math.min(maxLeftWidth, maxLeftByCenter), dragStartWidth.current + deltaPercent),
      );
      setLeftWidth(nextLeft);
      return;
    }

    const maxExtraByCenter = 100 - leftWidth - MIN_CENTER_WIDTH;
    const nextExtra = Math.max(
      minExtraWidth,
      Math.min(Math.min(maxExtraWidth, maxExtraByCenter), dragStartWidth.current - deltaPercent),
    );
    setExtraWidth(nextExtra);
  }, [dragTarget, extraWidth, hasExtraPane, leftWidth, maxExtraWidth, maxLeftWidth, minExtraWidth, minLeftWidth]);

  const handleMouseUp = useCallback(() => {
    setDragTarget(null);
  }, []);

  useEffect(() => {
    if (dragTarget) {
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
  }, [dragTarget, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    if (defaultLeftWidth !== prevDefaultLeftRef.current) {
      prevDefaultLeftRef.current = defaultLeftWidth;
      setLeftWidth(defaultLeftWidth);
    }
  }, [defaultLeftWidth]);

  useEffect(() => {
    if (defaultExtraWidth !== prevDefaultExtraRef.current) {
      prevDefaultExtraRef.current = defaultExtraWidth;
      setExtraWidth(defaultExtraWidth);
    }
  }, [defaultExtraWidth]);

  useEffect(() => {
    if (!hasExtraPane && selectedTab === 'extra') {
      setSelectedTab('left');
    }
  }, [hasExtraPane, selectedTab]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    setIsMobile(mediaQuery.matches);
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  if (isMobile) {
    return (
      <SplitLayoutContext.Provider value={{ switchToRight, selectedTab }}>
        <div
          ref={containerRef}
          className={`app-viewport-height flex flex-col w-full ${className}`}
        >
          <div className="relative flex-1 overflow-hidden">
            <div className={`absolute inset-0 overflow-hidden ${selectedTab !== 'left' ? 'hidden' : ''}`}>
              <div className="h-full overflow-auto bg-content2 dark:bg-content1">
                {leftContent}
              </div>
            </div>
            <div className={`absolute inset-0 overflow-hidden ${selectedTab !== 'right' ? 'hidden' : ''}`}>
              <div className="h-full overflow-auto bg-background">
                {rightContent}
              </div>
            </div>
            {hasExtraPane && (
              <div className={`absolute inset-0 overflow-hidden ${selectedTab !== 'extra' ? 'hidden' : ''}`}>
                <div className="h-full overflow-auto bg-content1">
                  {extraContent}
                </div>
              </div>
            )}
          </div>

          <div className="app-safe-area-pb flex-shrink-0 border-t border-divider bg-content2">
            <Tabs
              aria-label={t('splitLayout.pageSwitch')}
              selectedKey={selectedTab}
              onSelectionChange={(key) => setSelectedTab(key as string)}
              variant="light"
              size="lg"
              fullWidth
              classNames={{
                tabList: 'w-full',
              }}
            >
              <Tab
                key="left"
                title={(
                  <div className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faListUl} className="text-sm" />
                    <span>{resolvedLeftLabel}</span>
                  </div>
                )}
              />
              <Tab
                key="right"
                title={(
                  <div className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faMicrophone} className="text-sm" />
                    <span>{resolvedRightLabel}</span>
                  </div>
                )}
              />
              {hasExtraPane && (
                <Tab
                  key="extra"
                  title={(
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faPuzzlePiece} className="text-sm" />
                      <span>{resolvedExtraLabel}</span>
                    </div>
                  )}
                />
              )}
            </Tabs>
          </div>
        </div>
      </SplitLayoutContext.Provider>
    );
  }

  if (!hasExtraPane) {
    return (
      <>
        {dragTarget && (
          <div className="fixed inset-0 z-[9999] cursor-col-resize bg-transparent" />
        )}
        <div
          ref={containerRef}
          className={`app-viewport-height flex w-full ${className}`}
        >
          <div
            className="flex-shrink-0 overflow-hidden"
            style={{ width: `${leftWidth}%` }}
          >
            <div className="h-full overflow-auto bg-content2 dark:bg-content1">
              {leftContent}
            </div>
          </div>

          <Divider isDragging={dragTarget === 'left'} onMouseDown={handleMouseDown('left')} />

          <div className="flex-1 overflow-hidden">
            <div className="h-full overflow-auto bg-background">
              {rightContent}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {dragTarget && (
        <div className="fixed inset-0 z-[9999] cursor-col-resize bg-transparent" />
      )}
      <div
        ref={containerRef}
        className={`app-viewport-height flex w-full ${className}`}
      >
        <div
          className="flex-shrink-0 overflow-hidden"
          style={{ width: `${leftWidth}%` }}
        >
          <div className="h-full overflow-auto bg-content2 dark:bg-content1">
            {leftContent}
          </div>
        </div>

        <Divider isDragging={dragTarget === 'left'} onMouseDown={handleMouseDown('left')} />

        <div
          className="min-w-0 flex-1 overflow-hidden"
          style={{ width: `${Math.max(100 - leftWidth - extraWidth, MIN_CENTER_WIDTH)}%` }}
        >
          <div className="h-full overflow-auto bg-background">
            {rightContent}
          </div>
        </div>

        <Divider isDragging={dragTarget === 'extra'} onMouseDown={handleMouseDown('extra')} />

        <div
          className="flex-shrink-0 overflow-hidden"
          style={{ width: `${extraWidth}%` }}
        >
          <div className="h-full overflow-auto bg-content1">
            {extraContent}
          </div>
        </div>
      </div>
    </>
  );
};
