import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Card } from '@heroui/react';

interface SplitLayoutProps {
  leftContent: React.ReactNode;
  rightContent: React.ReactNode;
  defaultLeftWidth?: number; // 百分比，默认50
  minLeftWidth?: number; // 最小宽度百分比，默认20
  maxLeftWidth?: number; // 最大宽度百分比，默认80
  className?: string;
}

export const SplitLayout: React.FC<SplitLayoutProps> = ({
  leftContent,
  rightContent,
  defaultLeftWidth = 50,
  minLeftWidth = 20,
  maxLeftWidth = 80,
  className = ''
}) => {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef<number>(0);
  const dragStartWidth = useRef<number>(0);

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