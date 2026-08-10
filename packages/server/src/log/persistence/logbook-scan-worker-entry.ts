import { scanLogbookFileInline } from './LogbookScanCore.js';
import type {
  LogbookScanWorkerMessage,
  LogbookScanWorkerRequest,
  SerializedLogbookScanError,
} from './LogbookScanTypes.js';
import { WorkerIpcSender } from './WorkerIpcSender.js';

function serializeError(error: unknown): SerializedLogbookScanError {
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

const ipc = new WorkerIpcSender<LogbookScanWorkerMessage>();
let busy = false;
process.on('message', async (message: LogbookScanWorkerRequest) => {
  if (!message || message.type !== 'scan' || busy) return;
  busy = true;
  let response: LogbookScanWorkerMessage;
  try {
    const result = await scanLogbookFileInline(message.filePath, (progress) => {
      ipc.post({ type: 'progress', id: message.id, progress });
    });
    response = { type: 'result', id: message.id, result };
  } catch (error) {
    response = { type: 'error', id: message.id, error: serializeError(error) };
  }
  await ipc.finish(response);
});

ipc.post({ type: 'ready' });
