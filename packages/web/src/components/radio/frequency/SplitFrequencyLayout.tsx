import React from 'react';

export const SPLIT_FREQUENCY_ROW_CLASS = 'flex shrink-0 items-center justify-center font-mono font-bold text-foreground';

export const SplitFrequencyLayout: React.FC<React.PropsWithChildren> = ({ children }) => (
  <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-0">
    {children}
  </div>
);
