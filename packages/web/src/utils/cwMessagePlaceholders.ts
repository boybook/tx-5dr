import {
  resolveMessagePlaceholders,
  type MessagePlaceholderName,
  type MessagePlaceholderValues,
  type MessageSegment,
  type ResolvedMessage,
} from './messagePlaceholders';

/** CW message placeholders: the shared keyboard-mode set, without control tokens. */
export type CWPlaceholderName = MessagePlaceholderName;
export type CWPlaceholderValues = MessagePlaceholderValues;
export type CWMessageSegment = MessageSegment;
export type ResolvedCWMessage = ResolvedMessage;

export function resolveCWMessagePlaceholders(
  text: string,
  values: CWPlaceholderValues,
): ResolvedCWMessage {
  return resolveMessagePlaceholders(text, values);
}
