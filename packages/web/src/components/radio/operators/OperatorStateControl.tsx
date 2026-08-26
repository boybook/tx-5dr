import * as React from 'react';
import { Button, Select, SelectItem, type Selection, Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircle, faCircleDot } from '@fortawesome/free-solid-svg-icons';

export interface OperatorStateChoice {
  id: string;
  label: string;
  content?: string;
}

interface OperatorStateSelectProps {
  choices: readonly OperatorStateChoice[];
  currentState: string;
  onSelect: (stateId: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  compact?: boolean;
}

export function OperatorStateSelect({
  choices,
  currentState,
  onSelect,
  disabled = false,
  ariaLabel,
  compact = false,
}: OperatorStateSelectProps) {
  const handleSelectionChange = (keys: Selection) => {
    const stateId = Array.from(keys)[0];
    if (typeof stateId === 'string') onSelect(stateId);
  };

  return (
    <Select
      selectedKeys={[currentState]}
      onSelectionChange={handleSelectionChange}
      size="sm"
      variant="bordered"
      className={compact ? 'min-w-0 flex-1' : 'w-auto min-w-[200px]'}
      classNames={{
        trigger: compact
          ? 'h-7 min-h-7 border-divider bg-default-100 px-2 shadow-none'
          : 'h-auto min-h-0 rounded-md border-none bg-transparent p-1 pl-2 shadow-none data-[hover=true]:bg-content2',
        value: compact ? 'p-0 text-xs font-mono text-foreground' : 'p-0 text-sm font-mono text-foreground',
        selectorIcon: 'text-default-400 text-xs',
        popoverContent: compact ? 'min-w-[240px]' : 'min-w-[280px]',
      }}
      isDisabled={disabled || choices.length === 0}
      aria-label={ariaLabel}
      renderValue={(items) => {
        const selected = choices.find((choice) => choice.id === String(items[0]?.key ?? currentState));
        if (!selected) return currentState;
        return selected.content ? `${selected.label}: ${selected.content}` : selected.label;
      }}
    >
      {choices.map((choice) => (
        <SelectItem key={choice.id} textValue={`${choice.label} ${choice.content ?? ''}`}>
          <div className="flex min-w-0 flex-col py-0.5">
            <span className="text-xs font-medium text-foreground">{choice.label}</span>
            {choice.content && (
              <span className="truncate font-mono text-[11px] text-default-500">{choice.content}</span>
            )}
          </div>
        </SelectItem>
      ))}
    </Select>
  );
}

interface OperatorStateListProps {
  choices: readonly OperatorStateChoice[];
  currentState: string;
  onSelect: (stateId: string) => void;
  disabled?: boolean;
  compact?: boolean;
  selectLabel: (choice: OperatorStateChoice) => string;
  renderContent?: (choice: OperatorStateChoice) => React.ReactNode;
}

export function OperatorStateList({
  choices,
  currentState,
  onSelect,
  disabled = false,
  compact = false,
  selectLabel,
  renderContent,
}: OperatorStateListProps) {
  if (choices.length === 0) return null;
  return (
    <div role="list" className="divide-y divide-divider">
      {choices.map((choice) => {
        const selected = choice.id === currentState;
        return (
          <div
            key={choice.id}
            role="listitem"
            className={`flex min-w-0 items-center gap-2 ${compact ? 'min-h-8 px-2 py-1' : 'min-h-9 px-3 py-1.5'} ${
              selected ? 'bg-primary-50/70 dark:bg-primary-500/10' : ''
            }`}
          >
            <span className={`${compact ? 'w-24 text-[11px]' : 'w-28 text-xs'} shrink-0 truncate font-medium text-default-600`}>
              {choice.label}
            </span>
            <div className={`min-w-0 flex-1 ${compact ? 'text-[11px]' : 'text-xs'}`}>
              {renderContent?.(choice) ?? (
                <span className="block truncate font-mono text-foreground" title={choice.content}>
                  {choice.content || '-'}
                </span>
              )}
            </div>
            <Tooltip content={selectLabel(choice)} placement="top" offset={4}>
              <Button
                isIconOnly
                size="sm"
                variant={selected ? 'flat' : 'light'}
                color={selected ? 'primary' : 'default'}
                className={compact ? 'h-6 w-6 min-w-6' : 'h-7 w-7 min-w-7'}
                isDisabled={disabled || selected}
                onPress={() => onSelect(choice.id)}
                aria-label={selectLabel(choice)}
              >
                <FontAwesomeIcon icon={selected ? faCircleDot : faCircle} className={compact ? 'text-[9px]' : 'text-[10px]'} />
              </Button>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}
