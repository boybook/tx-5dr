import React from 'react';
import { Chip, Switch, type ChipProps } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

export interface DecoderHeaderProps {
  icon: IconDefinition;
  title: string;
  /** Decoder state chip next to the title. */
  statusLabel: string;
  statusColor: ChipProps['color'];
  /** Second line under the title (backend, settings buttons, ...). */
  details?: React.ReactNode;
  /** Enable switch on the right. */
  enabled: boolean;
  switchDisabled: boolean;
  switchAriaLabel: string;
  onEnabledChange(enabled: boolean): void;
}

/** Title row of a decoder card: icon, title, state chip, details line and enable switch. */
export function DecoderHeader({
  icon,
  title,
  statusLabel,
  statusColor,
  details,
  enabled,
  switchDisabled,
  switchAriaLabel,
  onEnabledChange,
}: DecoderHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FontAwesomeIcon icon={icon} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{title}</span>
            <Chip size="sm" color={statusColor} variant="flat" className="h-5 text-[10px]">
              {statusLabel}
            </Chip>
          </div>
          {details !== undefined && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-default-500">
              {details}
            </div>
          )}
        </div>
      </div>
      <Switch
        size="sm"
        isSelected={enabled}
        isDisabled={switchDisabled}
        onValueChange={onEnabledChange}
        aria-label={switchAriaLabel}
      />
    </div>
  );
}
