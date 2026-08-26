import type { OperatorStatus } from '@tx5dr/contracts';

type Transmission = NonNullable<OperatorStatus['currentTransmissions']>[number];

interface OperatorTransmissionStackProps {
  transmissions: readonly Transmission[];
  fallbackText: string;
  variant: 'header' | 'detail';
}

export function OperatorTransmissionStack({
  transmissions,
  fallbackText,
  variant,
}: OperatorTransmissionStackProps) {
  const rows = transmissions.filter((transmission) => Boolean(transmission.text));
  const title = rows.map((transmission) => transmission.text).join('\n') || fallbackText;
  if (rows.length <= 1) {
    return (
      <div
        className={variant === 'header'
          ? 'truncate font-mono text-lg font-bold text-danger'
          : `min-w-0 flex-1 truncate font-mono text-sm ${rows.length > 0 ? 'text-foreground' : 'text-default-400'}`}
        title={title}
      >
        {rows[0]?.text || fallbackText}
      </div>
    );
  }

  return (
    <div
      role="list"
      className={variant === 'header'
        ? 'flex min-w-0 flex-1 flex-col justify-center gap-px font-mono text-[11px] font-semibold leading-[13px] text-danger sm:text-xs sm:leading-[14px]'
        : 'flex min-w-0 flex-1 flex-col justify-center gap-px font-mono text-[11px] leading-[13px] text-foreground'}
      title={title}
    >
      {rows.map((transmission) => (
        <div key={transmission.streamId} role="listitem" className="min-w-0 truncate">
          {transmission.text}
        </div>
      ))}
    </div>
  );
}
