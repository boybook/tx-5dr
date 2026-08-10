import type { AdifScanResult } from './AdifCodec.js';
import type { LogbookRecordProjection } from './LogbookDocument.js';

export interface GenerationToken {
  size: number;
  mtimeMs: number;
  dev?: number;
  ino?: number;
  contentHash: string;
  scanHash: string;
  token: string;
}

export type LogbookScanProgress =
  | { phase: 'read'; bytesRead: number; totalBytes: number }
  | { phase: 'records'; recordsScanned: number; totalRecords: number };

export interface LogbookFileScanResult {
  generation: GenerationToken;
  /** Parsed in the bounded worker so the server never needs raw field values. */
  recordProjections: readonly LogbookRecordProjection[];
  scan: AdifScanResult;
  warnings: readonly string[];
}

export interface LogbookScanner {
  scan(filePath: string, onProgress?: (progress: LogbookScanProgress) => void): Promise<LogbookFileScanResult>;
}

export interface SerializedLogbookScanError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

export type LogbookScanWorkerRequest = {
  type: 'scan';
  id: number;
  filePath: string;
};

export type LogbookScanWorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; id: number; progress: LogbookScanProgress }
  | { type: 'result'; id: number; result: LogbookFileScanResult }
  | { type: 'error'; id?: number; error: SerializedLogbookScanError };
