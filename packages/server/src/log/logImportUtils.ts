import type { LogBookImportFormat, QSORecord } from '@tx5dr/contracts';
import { parseLegacyComment } from './qsoTextFields.js';

export interface ParsedTx5drCsvImport {
  records: QSORecord[];
  totalRead: number;
  skipped: number;
}

const TX5DR_CSV_REQUIRED_HEADERS = [
  'Date',
  'Time',
  'Callsign',
  'Frequency (MHz)',
  'Mode',
] as const;

export function normalizeImportText(content: string): string {
  return content.replace(/^\uFEFF/, '').trim();
}

export function isLikelyAdifContent(content: string): boolean {
  return /<\s*(adif_ver|eoh|eor)\b/i.test(content);
}

export function isLikelyTx5drCsvContent(content: string): boolean {
  const normalized = normalizeImportText(content);
  if (!normalized || isLikelyAdifContent(normalized)) {
    return false;
  }

  const rows = parseCsvRows(normalized);
  if (rows.length === 0) {
    return false;
  }

  const headerSet = new Set(rows[0].map((header) => header.trim()));
  return TX5DR_CSV_REQUIRED_HEADERS.every((header) => headerSet.has(header));
}

export function detectLogImportFormat(
  content: string,
  fileName?: string
): LogBookImportFormat {
  const normalized = normalizeImportText(content);
  const lowerFileName = fileName?.toLowerCase();

  if (lowerFileName?.endsWith('.adi') || lowerFileName?.endsWith('.adif')) {
    return 'adif';
  }
  if (lowerFileName?.endsWith('.csv')) {
    return 'csv';
  }

  if (isLikelyAdifContent(normalized)) {
    return 'adif';
  }
  if (isLikelyTx5drCsvContent(normalized)) {
    return 'csv';
  }

  throw new Error('Unsupported log import format');
}

export function parseTx5drCsvContent(csvContent: string): ParsedTx5drCsvImport {
  const normalized = normalizeImportText(csvContent);
  if (!normalized) {
    return { records: [], totalRead: 0, skipped: 0 };
  }

  const rows = parseCsvRows(normalized);
  if (rows.length === 0) {
    return { records: [], totalRead: 0, skipped: 0 };
  }

  const headers = rows[0].map((header) => header.trim());
  const headerSet = new Set(headers);

  if (!TX5DR_CSV_REQUIRED_HEADERS.every((header) => headerSet.has(header))) {
    throw new Error('CSV header does not match TX-5DR export format');
  }

  const records: QSORecord[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    if (row.every((value) => value.trim().length === 0)) {
      continue;
    }

    const rowMap = Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
    try {
      records.push(parseTx5drCsvRow(rowMap));
    } catch {
      skipped += 1;
    }
  }

  return {
    records,
    totalRead: rows.slice(1).filter((row) => row.some((value) => value.trim().length > 0)).length,
    skipped,
  };
}

export function buildImportedQsoFingerprint(qso: Pick<QSORecord, 'callsign' | 'startTime' | 'mode' | 'frequency'>): string {
  const callsign = qso.callsign.trim().toUpperCase();
  const mode = (qso.mode || '').trim().toUpperCase();
  const startTime = Number.isFinite(qso.startTime) ? Math.floor(qso.startTime / 1000) : 0;
  const frequency = Number.isFinite(qso.frequency) ? Math.round(qso.frequency) : 0;
  return `${callsign}__${startTime}__${mode}__${frequency}`;
}

function parseTx5drCsvRow(row: Record<string, string>): QSORecord {
  const callsign = row['Callsign']?.trim();
  const date = row['Date']?.trim();
  const time = row['Time']?.trim();
  const frequencyMHz = Number.parseFloat(row['Frequency (MHz)']?.trim() || '');
  const mode = row['Mode']?.trim();

  if (!callsign || !date || !time || !Number.isFinite(frequencyMHz) || !mode) {
    throw new Error('CSV row is missing required fields');
  }

  const startTime = Date.parse(`${date}T${time}Z`);
  if (Number.isNaN(startTime)) {
    throw new Error(`Invalid CSV date/time: ${date} ${time}`);
  }

  const comments = row['Comments']?.trim() || '';
  const { comment, messageHistory } = parseLegacyComment(comments);
  return {
    id: `${callsign}_${startTime}_csv`,
    callsign,
    grid: cleanOptional(row['Grid']),
    frequency: Math.round(frequencyMHz * 1000000),
    mode,
    startTime,
    reportSent: cleanOptional(row['Report Sent']),
    reportReceived: cleanOptional(row['Report Received']),
    messageHistory,
    comment,
    myCallsign: cleanOptional(row['My Callsign']),
    myGrid: cleanOptional(row['My Grid']),
  };
}

function cleanOptional(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const nextChar = content[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i += 1;
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      continue;
    }

    currentCell += char;
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}
