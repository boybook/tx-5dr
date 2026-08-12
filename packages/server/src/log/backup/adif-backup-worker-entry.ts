import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';

import { scanLogbookFileInline } from '../persistence/LogbookScanCore.js';
import { WorkerIpcSender } from '../persistence/WorkerIpcSender.js';
import type {
  AdifBackupSummary,
  AdifBackupWorkerMessage,
  AdifBackupWorkerRequest,
} from './AdifBackupWorker.js';

const CHUNK_BYTES = 64 * 1024;
const PROGRESS_BYTES = 1024 * 1024;
const ipc = new WorkerIpcSender<AdifBackupWorkerMessage>();
let busy = false;

async function copyAndScan(
  request: Extract<AdifBackupWorkerRequest, { type: 'copy-and-scan' }>,
): Promise<AdifBackupSummary> {
  const source = await fs.open(request.sourcePath, constants.O_RDONLY);
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile()) throw new Error('ADIF backup source is not a regular file');
    const fixedSize = sourceStat.size;
    ipc.post({ type: 'source-opened', id: request.id });
    target = await fs.open(
      request.targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await target.chmod(0o600);
    ipc.post({
      type: 'progress',
      id: request.id,
      progress: { bytesCopied: 0, totalBytes: fixedSize },
    });

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = 0;
    let nextProgress = PROGRESS_BYTES;
    while (position < fixedSize) {
      const requested = Math.min(buffer.length, fixedSize - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead <= 0) throw new Error('ADIF backup source ended before its fixed EOF');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten <= 0) throw new Error('ADIF backup write made no forward progress');
        written += result.bytesWritten;
      }
      position += bytesRead;
      if (position >= nextProgress || position === fixedSize) {
        ipc.post({
          type: 'progress',
          id: request.id,
          progress: { bytesCopied: position, totalBytes: fixedSize },
        });
        while (nextProgress <= position) nextProgress += PROGRESS_BYTES;
      }
    }
    if (fixedSize === 0) {
      ipc.post({ type: 'progress', id: request.id, progress: { bytesCopied: 0, totalBytes: 0 } });
    }
    await target.sync();
    await target.close();
    target = undefined;

    const scan = await scanLogbookFileInline(request.targetPath);
    const sha256 = hash.digest('hex');
    if (scan.generation.contentHash !== sha256 || scan.generation.size !== fixedSize) {
      throw new Error('ADIF backup verification did not match the fixed source snapshot');
    }
    return {
      size: fixedSize,
      sha256,
      recordCount: scan.scan.records.length,
      opaqueRecordCount: scan.recordProjections.filter(record => !record.qso).length,
      incompleteTail: Boolean(scan.scan.incompleteTailRange)
        || scan.scan.safeEnd !== scan.scan.byteLength,
      issueCount: scan.scan.issues.length,
    };
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function scanSummary(
  request: Extract<AdifBackupWorkerRequest, { type: 'scan' }>,
): Promise<AdifBackupSummary> {
  const scan = await scanLogbookFileInline(request.sourcePath, progress => {
    if (progress.phase !== 'read') return;
    ipc.post({
      type: 'progress',
      id: request.id,
      progress: { bytesCopied: progress.bytesRead, totalBytes: progress.totalBytes },
    });
  }, () => ipc.post({ type: 'source-opened', id: request.id }));
  return {
    size: scan.generation.size,
    sha256: scan.generation.contentHash,
    recordCount: scan.scan.records.length,
    opaqueRecordCount: scan.recordProjections.filter(record => !record.qso).length,
    incompleteTail: Boolean(scan.scan.incompleteTailRange)
      || scan.scan.safeEnd !== scan.scan.byteLength,
    issueCount: scan.scan.issues.length,
  };
}

function serializeError(error: unknown): Extract<AdifBackupWorkerMessage, { type: 'error' }>['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: (error as Error & { code?: string }).code,
    };
  }
  return { name: 'Error', message: String(error) };
}

process.on('message', async (message: AdifBackupWorkerRequest) => {
  if (!message || (message.type !== 'copy-and-scan' && message.type !== 'scan') || busy) return;
  busy = true;
  try {
    const summary = message.type === 'copy-and-scan'
      ? await copyAndScan(message)
      : await scanSummary(message);
    await ipc.finish({ type: 'result', id: message.id, summary });
  } catch (error) {
    await ipc.finish({ type: 'error', id: message.id, error: serializeError(error) });
  }
});

ipc.post({ type: 'ready' });
