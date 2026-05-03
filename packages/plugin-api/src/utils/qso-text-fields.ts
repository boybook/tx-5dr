import type { QSORecord } from '@tx5dr/contracts';

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeMessageHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

export function buildCommentFromMessageHistory(messageHistory?: readonly string[]): string | undefined {
  const normalized = normalizeMessageHistory(messageHistory ?? []);
  return normalized.length > 0 ? normalized.join(' | ') : undefined;
}

export function parseLegacyComment(comment?: string): { comment?: string; messageHistory: string[] } {
  const normalizedComment = normalizeOptionalString(comment);
  if (!normalizedComment) {
    return { comment: undefined, messageHistory: [] };
  }

  const messageHistory = normalizedComment
    .split(' | ')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return {
    comment: normalizedComment,
    messageHistory: messageHistory.length > 1 ? messageHistory : [],
  };
}

export function resolveQsoComment(qso: Pick<QSORecord, 'comment' | 'messageHistory'>): string | undefined {
  return normalizeOptionalString(qso.comment) ?? buildCommentFromMessageHistory(qso.messageHistory);
}

/**
 * 清理文本中的 ADIF 保留字符（尖括号）。
 * ADIF 字段值中不应包含 < >，否则会被解析器误认为字段标签。
 */
export function sanitizeAdifFieldValue(value: string): string {
  return value.replace(/[<>]/g, '');
}
