import React from 'react';

export interface HorizontalPaneDividerProps {
  isDragging: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
  resetHint: string;
  heightPx?: number;
}

export const HorizontalPaneDivider: React.FC<HorizontalPaneDividerProps> = ({
  isDragging,
  onPointerDown,
  onDoubleClick,
  resetHint,
  heightPx = 8,
}) => {
  return (
    <div
      className={[
        'group touch-none flex-shrink-0 cursor-row-resize transition-all duration-200',
        isDragging ? 'bg-primary-400' : 'bg-transparent hover:bg-primary-200',
      ].join(' ')}
      style={{ height: `${heightPx}px` }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      title={resetHint}
    >
      <div className="relative h-full w-full">
        <div
          className={[
            'absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 transform gap-1 transition-opacity duration-200',
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          ].join(' ')}
        >
          <div className="h-0.5 w-6 rounded-full bg-default-600"></div>
          <div className="h-0.5 w-6 rounded-full bg-default-600"></div>
          <div className="h-0.5 w-6 rounded-full bg-default-600"></div>
        </div>
      </div>
    </div>
  );
};
