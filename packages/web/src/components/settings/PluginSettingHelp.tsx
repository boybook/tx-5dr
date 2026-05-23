import React from 'react';
import { Tooltip } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons';

interface PluginSettingHelpIconProps {
  description: string;
  label: string;
  className?: string;
  contentClassName?: string;
  stopPropagation?: boolean;
}

interface PluginSettingLabelWithHelpProps {
  label: React.ReactNode;
  description?: string;
  helpLabel?: string;
  className?: string;
  textClassName?: string;
  iconClassName?: string;
  contentClassName?: string;
  stopPropagation?: boolean;
}

function cx(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(' ');
}

export const PluginSettingHelpIcon: React.FC<PluginSettingHelpIconProps> = ({
  description,
  label,
  className,
  contentClassName,
  stopPropagation = false,
}) => {
  const stopIfNeeded = React.useCallback((event: React.SyntheticEvent) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  }, [stopPropagation]);

  return (
    <Tooltip
      content={(
        <div className={cx('max-w-[260px] whitespace-pre-line text-xs leading-5', contentClassName)}>
          {description}
        </div>
      )}
      placement="top"
      closeDelay={80}
    >
      <span
        className={cx(
          'pointer-events-auto inline-flex h-5 w-5 shrink-0 cursor-help items-center justify-center rounded-full text-default-400 transition-colors hover:text-default-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400',
          className,
        )}
        tabIndex={0}
        aria-label={label}
        onClick={stopIfNeeded}
        onMouseDown={stopIfNeeded}
        onPointerDown={stopIfNeeded}
      >
        <FontAwesomeIcon icon={faCircleInfo} className="text-[13px]" />
      </span>
    </Tooltip>
  );
};

export const PluginSettingLabelWithHelp: React.FC<PluginSettingLabelWithHelpProps> = ({
  label,
  description,
  helpLabel,
  className,
  textClassName,
  iconClassName,
  contentClassName,
  stopPropagation,
}) => (
  <span className={cx('inline-flex min-w-0 items-center gap-1.5', className)}>
    <span className={cx('min-w-0', textClassName)}>{label}</span>
    {description && (
      <PluginSettingHelpIcon
        description={description}
        label={helpLabel ?? (typeof label === 'string' ? `${label}: ${description}` : description)}
        className={iconClassName}
        contentClassName={contentClassName}
        stopPropagation={stopPropagation}
      />
    )}
  </span>
);
