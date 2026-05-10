import React, { useCallback, useEffect, useState } from 'react';

/**
 * Shared ref for tracking which digit is currently active (hovered).
 * Global keydown listener dispatches keyboard events to the active digit.
 */
interface ActiveDigitActions {
  onIncrement: () => void;
  onDecrement: () => void;
  onSetDigit: (value: number) => void;
}

const activeDigitRef: { current: ActiveDigitActions | null } = { current: null };
let globalKeyListenerInstalled = false;

function installGlobalKeyListener() {
  if (globalKeyListenerInstalled) return;
  globalKeyListenerInstalled = true;

  window.addEventListener('keydown', (e: KeyboardEvent) => {
    const actions = activeDigitRef.current;
    if (!actions) return;

    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      actions.onIncrement();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      actions.onDecrement();
    } else if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      actions.onSetDigit(parseInt(e.key, 10));
    }
  });
}

/**
 * Single interactive frequency digit (SDR++-style dual-zone overlay).
 * - Hover top half: red overlay, click -> +1
 * - Hover bottom half: blue overlay, click -> -1
 * - Hover anywhere: ArrowUp/Down increment/decrement, 0-9 sets value directly
 */
export const FrequencyDigit: React.FC<{
  digit: string;
  placeValue?: number;
  disabled: boolean;
  isLeadingZero?: boolean;
  digitClassName?: string;
  arrowClassName?: string;
  onIncrement: () => void;
  onDecrement: () => void;
  onSetDigit: (value: number) => void;
}> = React.memo(({ digit, disabled, isLeadingZero, digitClassName, arrowClassName, onIncrement, onDecrement, onSetDigit }) => {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    installGlobalKeyListener();
  }, []);

  useEffect(() => {
    if (hovered && !disabled) {
      activeDigitRef.current = { onIncrement, onDecrement, onSetDigit };
    }
  }, [hovered, disabled, onIncrement, onDecrement, onSetDigit]);

  const handleMouseEnter = useCallback(() => {
    if (disabled) return;
    setHovered(true);
    activeDigitRef.current = { onIncrement, onDecrement, onSetDigit };
  }, [disabled, onIncrement, onDecrement, onSetDigit]);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    activeDigitRef.current = null;
  }, []);

  const showActive = hovered && !disabled;
  const digitClasses = digitClassName ?? 'text-3xl';
  const arrowClasses = arrowClassName ?? 'h-4 text-xs';

  return (
    <div
      data-freq-digit
      className="relative flex flex-col items-center select-none"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className={`${arrowClasses} leading-none transition-opacity duration-150 pointer-events-none ${
          showActive ? 'opacity-100' : 'opacity-0'
        } flex items-center justify-center text-danger`}
      >
        ▲
      </div>
      <span className={`block ${digitClasses} leading-none pointer-events-none ${
        isLeadingZero ? 'text-default-300 dark:text-default-500' : 'text-foreground'
      }`}>
        {digit}
      </span>
      <div
        className={`${arrowClasses} leading-none transition-opacity duration-150 pointer-events-none ${
          showActive ? 'opacity-100' : 'opacity-0'
        } flex items-center justify-center text-primary`}
      >
        ▼
      </div>

      {!disabled && (
        <>
          <div
            className="absolute inset-x-0 top-0 h-1/2 cursor-pointer rounded-sm transition-colors duration-150 hover:bg-danger/25"
            onClick={onIncrement}
          />
          <div
            className="absolute inset-x-0 bottom-0 h-1/2 cursor-pointer rounded-sm transition-colors duration-150 hover:bg-primary/25"
            onClick={onDecrement}
          />
        </>
      )}
    </div>
  );
});
FrequencyDigit.displayName = 'FrequencyDigit';
