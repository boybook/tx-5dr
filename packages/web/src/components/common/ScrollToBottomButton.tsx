import React from 'react';
import { Button } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowDown } from '@fortawesome/free-solid-svg-icons';

export function ScrollToBottomButton({
  label,
  onPress,
  iconOnly = false,
  className = '',
}: {
  label: string;
  onPress: () => void;
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <Button
      isIconOnly={iconOnly}
      size="sm"
      variant="light"
      radius="full"
      aria-label={label}
      title={iconOnly ? label : undefined}
      className={`pointer-events-auto h-7 min-w-0 bg-background/75 text-xs text-default-500 shadow-sm ring-1 ring-default-200/70 backdrop-blur supports-[backdrop-filter]:bg-background/60 ${iconOnly ? 'w-7 px-0' : 'px-3'} ${className}`}
      onPress={onPress}
      startContent={iconOnly ? undefined : <FontAwesomeIcon icon={faArrowDown} className="text-[10px]" />}
    >
      {iconOnly ? <FontAwesomeIcon icon={faArrowDown} className="text-[10px]" /> : label}
    </Button>
  );
}
