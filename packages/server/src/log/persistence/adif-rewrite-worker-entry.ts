import { promises as fs } from 'node:fs';

interface RewriteWorkerChunk {
  kind: 'source' | 'bytes';
  range?: { start: number; end: number };
  bytes?: Uint8Array;
}

interface RewriteWorkerRequest {
  type: 'rewrite';
  id: number;
  sourcePath: string;
  tempPath: string;
  mode: number;
  chunks: RewriteWorkerChunk[];
}

function serializeError(error: unknown): { message: string; stack?: string } {
  return error instanceof Error
    ? { message: error.message, stack: error.stack }
    : { message: String(error) };
}

async function writeAll(handle: fs.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('ADIF rewrite worker made no write progress');
    offset += bytesWritten;
  }
}

async function copyRange(
  source: fs.FileHandle,
  target: fs.FileHandle,
  start: number,
  end: number,
): Promise<void> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`Invalid ADIF source range ${start}:${end}`);
  }
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = start;
  while (position < end) {
    const requested = Math.min(buffer.byteLength, end - position);
    const { bytesRead } = await source.read(buffer, 0, requested, position);
    if (bytesRead <= 0) throw new Error(`ADIF rewrite worker made no read progress at byte ${position}`);
    await writeAll(target, buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

process.on('message', async (message: RewriteWorkerRequest) => {
  if (!message || message.type !== 'rewrite') return;
  let source: fs.FileHandle | undefined;
  let target: fs.FileHandle | undefined;
  try {
    target = await fs.open(message.tempPath, 'w', message.mode || 0o600);
    await fs.chmod(message.tempPath, message.mode || 0o600);
    for (const chunk of message.chunks) {
      if (chunk.kind === 'source') {
        const range = chunk.range!;
        source ??= await fs.open(message.sourcePath, 'r');
        const stat = await source.stat();
        if (range.end > stat.size) throw new RangeError(`ADIF source range ${range.start}:${range.end} exceeds ${stat.size}`);
        await copyRange(source, target, range.start, range.end);
      } else if (chunk.bytes && chunk.bytes.byteLength > 0) {
        await writeAll(target, chunk.bytes);
      }
    }
    await target.sync();
    await target.close();
    target = undefined;
    await source?.close();
    source = undefined;
    process.send?.({ type: 'result', id: message.id });
  } catch (error) {
    await target?.close().catch(() => undefined);
    await source?.close().catch(() => undefined);
    const serialized = serializeError(error);
    process.send?.({ type: 'error', id: message.id, ...serialized });
  }
});

process.send?.({ type: 'ready' });
