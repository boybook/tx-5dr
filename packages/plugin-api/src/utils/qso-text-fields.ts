import type { QSORecord } from '@tx5dr/contracts';

const COMMENT_SEPARATOR = ' | ';
const SIGNAL_REPORT_COMMENT_PREFIX = /^\S+(?:(?:  Sent: \S+)(?:  Rcvd: \S+)?|(?:  Rcvd: \S+))(?= \| |$)/;

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
  return normalized.length > 0 ? normalized.join(COMMENT_SEPARATOR) : undefined;
}

export function parseMessageHistoryText(value?: string): string[] {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return [];
  }

  return normalizeMessageHistory(normalized.split(COMMENT_SEPARATOR));
}

function extractSignalReportCommentPrefix(comment: string): string | undefined {
  return comment.match(SIGNAL_REPORT_COMMENT_PREFIX)?.[0];
}

function stripSignalReportCommentPrefix(comment: string): string | undefined {
  const prefix = extractSignalReportCommentPrefix(comment);
  if (!prefix) {
    return comment;
  }

  const remainder = comment.slice(prefix.length);
  if (!remainder) {
    return undefined;
  }
  return remainder.startsWith(COMMENT_SEPARATOR)
    ? normalizeOptionalString(remainder.slice(COMMENT_SEPARATOR.length))
    : comment;
}

export function buildSignalReportComment(
  qso: Partial<Pick<QSORecord, 'mode' | 'reportSent' | 'reportReceived'>>,
): string | undefined {
  const mode = normalizeOptionalString(qso.mode);
  const reportSent = normalizeOptionalString(qso.reportSent);
  const reportReceived = normalizeOptionalString(qso.reportReceived);

  if (!mode || (!reportSent && !reportReceived)) {
    return undefined;
  }

  let comment = mode;
  if (reportSent) {
    comment += `  Sent: ${reportSent}`;
  }
  if (reportReceived) {
    comment += `  Rcvd: ${reportReceived}`;
  }
  return comment;
}

export function parseLegacyComment(comment?: string): { comment?: string; messageHistory: string[] } {
  const normalizedComment = normalizeOptionalString(comment);
  if (!normalizedComment) {
    return { comment: undefined, messageHistory: [] };
  }

  const messageHistory = extractSignalReportCommentPrefix(normalizedComment)
    ? []
    : parseMessageHistoryText(normalizedComment);

  return {
    comment: normalizedComment,
    messageHistory: messageHistory.length > 1 ? messageHistory : [],
  };
}

export function parseQsoTextFields(comment?: string, messageHistoryText?: string): { comment?: string; messageHistory: string[] } {
  const parsedMessageHistory = parseMessageHistoryText(messageHistoryText);
  if (parsedMessageHistory.length > 0) {
    return {
      comment: normalizeOptionalString(comment),
      messageHistory: parsedMessageHistory,
    };
  }

  return parseLegacyComment(comment);
}

export function resolveQsoComment(
  qso: Partial<Pick<QSORecord, 'comment' | 'messageHistory' | 'mode' | 'reportSent' | 'reportReceived'>>,
): string | undefined {
  const reportComment = buildSignalReportComment(qso);
  const legacyMessageComment = buildCommentFromMessageHistory(qso.messageHistory);
  let userComment = normalizeOptionalString(qso.comment);

  if (userComment && legacyMessageComment && userComment === legacyMessageComment) {
    userComment = undefined;
  }

  if (!reportComment) {
    return userComment;
  }

  if (userComment) {
    const existingReportPrefix = extractSignalReportCommentPrefix(userComment);
    if (existingReportPrefix === reportComment) {
      return userComment;
    }
    if (existingReportPrefix) {
      userComment = stripSignalReportCommentPrefix(userComment);
    }
  }

  return userComment ? `${reportComment}${COMMENT_SEPARATOR}${userComment}` : reportComment;
}

/**
 * 清理文本中的 ADIF 保留字符（尖括号）。
 * ADIF 字段值中不应包含 < >，否则会被解析器误认为字段标签。
 */
export function sanitizeAdifFieldValue(value: string): string {
  return value.replace(/[<>]/g, '');
}
