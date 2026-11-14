import React, { useCallback, useMemo } from 'react';
import { Chip, Tooltip } from '@heroui/react';
import { addToast } from '@heroui/toast';
import {
  MESSAGE_PLACEHOLDER_NAMES,
  resolveMessagePlaceholders,
  type MessagePlaceholderName,
  type MessagePlaceholderValues,
  type MessageSegment,
  type ResolvedMessage,
} from '../../utils/messagePlaceholders';
import { useModeText, type KeyboardModeI18n } from './modeText';

/** Built-in English fallbacks for the placeholder texts (`${prefix}.<key>`). */
export const MESSAGE_PLACEHOLDER_TEXT_DEFAULTS: Partial<Record<string, string>> = {
  placeholderMyCall: 'Current operator callsign',
  placeholderHisCall: 'QSO log station callsign',
  placeholderTrst: 'Sent signal report',
  placeholderRrst: 'Received signal report',
  placeholderMissingMyCall: 'Operator callsign',
  placeholderMissingHisCall: 'Station callsign',
  placeholderMissingTrst: 'Sent RST',
  placeholderMissingRrst: 'Received RST',
  placeholderMissingToast: 'Fill in {{placeholders}} before sending this message.',
  placeholderMissingTitle: 'Missing placeholder value',
  placeholderTooltip: '{{source}}: {{label}}',
  placeholderMissingTooltip: '{{source}} needs {{label}}',
  placeholderHint: 'Placeholders',
  placeholderHintSuffix: 'are replaced when sending.',
};

const PLACEHOLDER_LABEL_KEYS: Record<MessagePlaceholderName, string> = {
  MYCALL: 'placeholderMyCall',
  HISCALL: 'placeholderHisCall',
  TRST: 'placeholderTrst',
  RRST: 'placeholderRrst',
};

const PLACEHOLDER_MISSING_LABEL_KEYS: Record<MessagePlaceholderName, string> = {
  MYCALL: 'placeholderMissingMyCall',
  HISCALL: 'placeholderMissingHisCall',
  TRST: 'placeholderMissingTrst',
  RRST: 'placeholderMissingRrst',
};

const CHIP_BASE_CLASS = 'mx-0.5 inline-flex h-6 items-center rounded-md border px-1.5 font-mono text-xs font-bold leading-none align-middle';
const RESOLVED_CHIP_CLASS = 'border-emerald-300 bg-emerald-200 text-emerald-950 dark:border-emerald-300/70 dark:bg-emerald-300 dark:text-emerald-950';
const MISSING_CHIP_CLASS = 'border-amber-300 bg-amber-200 text-amber-950 dark:border-amber-300/70 dark:bg-amber-300 dark:text-amber-950';
const CONTROL_CHIP_CLASS = 'border-default-300 bg-default-200 text-default-700 dark:border-default-400/60 dark:bg-default-300 dark:text-default-900';

export interface UseMessagePlaceholdersOptions {
  /** Values for {MYCALL} {HISCALL} {TRST} {RRST}; keep the object memoized. */
  values: MessagePlaceholderValues;
  i18n: KeyboardModeI18n;
  /** Control tokens kept verbatim and rendered as neutral chips, e.g. `['RX']`. Keep stable. */
  controlTokens?: readonly string[];
  /** Tooltip text per control token, e.g. `{ RX: 'Return to receive' }`. */
  controlTokenLabels?: Partial<Record<string, string>>;
}

export interface UseMessagePlaceholdersResult {
  values: MessagePlaceholderValues;
  resolve(text: string): ResolvedMessage;
  /**
   * Resolve text for transmission. Shows a warning toast and returns null when
   * a placeholder has no value; returns null for empty text; otherwise the
   * trimmed resolved text (control tokens kept).
   */
  resolveForSend(text: string): string | null;
  renderSegments(segments: MessageSegment[]): React.ReactNode;
  /** The "Placeholders {MYCALL} ... are replaced when sending." hint row. */
  renderHint(): React.ReactNode;
}

export function useMessagePlaceholders({
  values,
  i18n,
  controlTokens,
  controlTokenLabels,
}: UseMessagePlaceholdersOptions): UseMessagePlaceholdersResult {
  const tx = useModeText(i18n, MESSAGE_PLACEHOLDER_TEXT_DEFAULTS);
  const resolveOptions = useMemo(() => ({ controlTokens }), [controlTokens]);

  const getPlaceholderLabel = useCallback(
    (placeholder: MessagePlaceholderName) => tx(PLACEHOLDER_LABEL_KEYS[placeholder]),
    [tx],
  );

  const getPlaceholderMissingLabel = useCallback(
    (placeholder: MessagePlaceholderName) => tx(PLACEHOLDER_MISSING_LABEL_KEYS[placeholder]),
    [tx],
  );

  const resolve = useCallback(
    (text: string) => resolveMessagePlaceholders(text, values, resolveOptions),
    [resolveOptions, values],
  );

  const resolveForSend = useCallback((text: string): string | null => {
    const resolved = resolve(text);
    if (resolved.unresolved.length > 0) {
      const labels = resolved.unresolved.map(getPlaceholderLabel).join(', ');
      addToast({
        title: tx('placeholderMissingTitle'),
        description: tx('placeholderMissingToast', { placeholders: labels }),
        color: 'warning',
      });
      return null;
    }
    const trimmed = resolved.text.trim();
    return trimmed || null;
  }, [getPlaceholderLabel, resolve, tx]);

  const renderSegments = useCallback((segments: MessageSegment[]) => (
    segments.map((segment, index) => {
      if (segment.type === 'text') {
        return <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>;
      }

      if (segment.type === 'control') {
        const label = controlTokenLabels?.[segment.token];
        const chip = (
          <span className={`${CHIP_BASE_CLASS} ${CONTROL_CHIP_CLASS}`}>
            {segment.source.toUpperCase()}
          </span>
        );
        return label ? (
          <Tooltip key={`${segment.source}-${index}`} content={label} delay={250}>
            {chip}
          </Tooltip>
        ) : (
          <React.Fragment key={`${segment.source}-${index}`}>{chip}</React.Fragment>
        );
      }

      const content = segment.resolved
        ? segment.text
        : getPlaceholderMissingLabel(segment.placeholder);
      const tooltip = tx(segment.resolved ? 'placeholderTooltip' : 'placeholderMissingTooltip', {
        source: segment.source.toUpperCase(),
        label: getPlaceholderLabel(segment.placeholder),
      });

      return (
        <Tooltip key={`${segment.source}-${index}`} content={tooltip} delay={250}>
          <span className={`${CHIP_BASE_CLASS} ${segment.resolved ? RESOLVED_CHIP_CLASS : MISSING_CHIP_CLASS}`}>
            {content}
          </span>
        </Tooltip>
      );
    })
  ), [controlTokenLabels, getPlaceholderLabel, getPlaceholderMissingLabel, tx]);

  const renderHint = useCallback(() => (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-content2 px-2 py-1.5 text-[11px] text-default-500">
      <span>{tx('placeholderHint')}</span>
      {MESSAGE_PLACEHOLDER_NAMES.map((placeholder) => (
        <Tooltip
          key={placeholder}
          content={getPlaceholderLabel(placeholder)}
          delay={250}
        >
          <Chip
            size="sm"
            variant="flat"
            color={placeholder === 'MYCALL' ? 'primary' : placeholder === 'HISCALL' ? 'warning' : 'secondary'}
            className="h-5 px-1 font-mono text-[10px] font-semibold"
          >
            {`{${placeholder}}`}
          </Chip>
        </Tooltip>
      ))}
      {(controlTokens ?? []).map((token) => {
        const label = controlTokenLabels?.[token];
        const chip = (
          <Chip
            key={token}
            size="sm"
            variant="flat"
            color="default"
            className="h-5 px-1 font-mono text-[10px] font-semibold"
          >
            {`{${token}}`}
          </Chip>
        );
        return label ? (
          <Tooltip key={token} content={label} delay={250}>{chip}</Tooltip>
        ) : chip;
      })}
      <span>{tx('placeholderHintSuffix')}</span>
    </div>
  ), [controlTokenLabels, controlTokens, getPlaceholderLabel, tx]);

  return { values, resolve, resolveForSend, renderSegments, renderHint };
}
