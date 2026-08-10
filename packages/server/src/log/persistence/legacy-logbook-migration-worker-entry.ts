import { LegacyLogbookDocumentCodec } from './LegacyLogbookDocumentCodec.js';
import {
  NodeLegacyLogbookFileStore,
  type LegacyLogbookFileStore,
} from './LegacyLogbookFileStore.js';
import { LegacyLogbookMigrator } from './LegacyLogbookMigrator.js';
import {
  readLegacyFileWithProgress,
  type LegacyMigrationWorkerMessage,
  type LegacyMigrationWorkerRequest,
} from './LegacyLogbookMigrationWorker.js';
import { WorkerIpcSender } from './WorkerIpcSender.js';

function progressReportingFileStore(
  report: (stage: string) => void,
): LegacyLogbookFileStore {
  const delegate = new NodeLegacyLogbookFileStore();
  const completed = async <Result>(stage: string, operation: () => Promise<Result>): Promise<Result> => {
    const result = await operation();
    report(stage);
    return result;
  };

  return {
    listDirectory: dirPath => completed('fs:list-directory', () => delegate.listDirectory(dirPath)),
    stat: filePath => completed('fs:stat', () => delegate.stat(filePath)),
    exists: filePath => completed('fs:exists', () => delegate.exists(filePath)),
    readFile: filePath => readLegacyFileWithProgress(
      filePath,
      bytesRead => report(`fs:read-file:${bytesRead}`),
    ),
    makeDirectory: dirPath => completed('fs:make-directory', () => delegate.makeDirectory(dirPath)),
    writeFileDurable: (filePath, data, mode) => completed(
      'fs:write-file-durable',
      () => delegate.writeFileDurable(filePath, data, mode),
    ),
    copyFileDurable: (sourcePath, targetPath) => completed(
      'fs:copy-file-durable',
      () => delegate.copyFileDurable(sourcePath, targetPath),
    ),
    rename: (sourcePath, targetPath) => completed('fs:rename', () => delegate.rename(sourcePath, targetPath)),
    unlink: filePath => completed('fs:unlink', () => delegate.unlink(filePath)),
    removeDirectory: dirPath => completed('fs:remove-directory', () => delegate.removeDirectory(dirPath)),
    syncDirectory: dirPath => completed('fs:sync-directory', () => delegate.syncDirectory(dirPath)),
  };
}

const ipc = new WorkerIpcSender<LegacyMigrationWorkerMessage>();
let busy = false;
process.on('message', async (request: LegacyMigrationWorkerRequest) => {
  if (!request || busy || (request.type !== 'migrate' && request.type !== 'cleanup')) return;
  busy = true;
  let sequence = 0;
  const report = (stage: string) => {
    sequence += 1;
    ipc.post({ type: 'progress', id: request.id, sequence, stage });
  };
  // Progress is emitted only for real state transitions. The parent treats a
  // repeated sequence as liveness noise and also enforces an absolute deadline.
  report(`${request.type}:started`);

  let response: LegacyMigrationWorkerMessage;
  try {
    const migrator = new LegacyLogbookMigrator(
      new LegacyLogbookDocumentCodec(recordsScanned => report(`codec:records:${recordsScanned}`)),
      progressReportingFileStore(report),
    );
    if (request.type === 'migrate') {
      const result = await migrator.migrate(request.mainPath);
      response = { type: 'migration-result', id: request.id, result };
    } else {
      const result = await migrator.cleanupExpired(request.mainPath, request.proof);
      response = { type: 'retention-result', id: request.id, result };
    }
  } catch (error) {
    response = {
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException | undefined)?.code,
    };
  }
  await ipc.finish(response);
});

ipc.post({ type: 'ready' });
