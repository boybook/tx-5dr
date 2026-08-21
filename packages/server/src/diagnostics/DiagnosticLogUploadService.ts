import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, rm, stat, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { gzip as gzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CreateDiagnosticUploadRequest,
  DiagnosticLogSource,
  DiagnosticLogSourceId,
  DiagnosticLogSourcesResponse,
  DiagnosticUploadReceipt,
} from '@tx5dr/contracts';
import { tx5drPaths } from '../utils/app-paths.js';
import { redactSensitiveText } from '../utils/sensitive-log.js';
import { TelemetryService, type DiagnosticGatewayContext } from '../observability/TelemetryService.js';

const gzip = promisify(gzipCallback);
export const DIAGNOSTIC_MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
export const DIAGNOSTIC_MAX_COMPRESSED_BYTES = 20 * 1024 * 1024;
export const DIAGNOSTIC_FEEDBACK_MAX_CHARACTERS = 2000;
const TIMESTAMP_SAMPLE_BYTES = 256 * 1024;

interface SourceDefinition {
  id: DiagnosticLogSourceId;
  fileName: string;
  matches: (name: string) => boolean;
}

const SOURCE_DEFINITIONS: SourceDefinition[] = [
  {
    id: 'server',
    fileName: 'tx5dr-server.log',
    matches: (name) => /^tx5dr-server(?:_\d{8}T\d{6})?\.log$/.test(name),
  },
  {
    id: 'electron-main',
    fileName: 'electron-main.log',
    matches: (name) => /^electron-main(?:\.old)?\.log$/.test(name),
  },
  {
    id: 'client-tools',
    fileName: 'client-tools.log',
    matches: (name) => /^client-tools(?:\.old)?\.log$/.test(name),
  },
];

interface LogFileDescriptor {
  path: string;
  name: string;
  size: number;
  availableFromMs: number | null;
  availableToMs: number | null;
}

interface SelectedBlock {
  timestampMs: number;
  fileOrder: number;
  blockOrder: number;
  lines: string[];
  bytes: number;
}

interface SelectedLog {
  content: string;
  lineCount: number;
  includedFromMs: number;
  includedToMs: number;
}

interface DiagnosticServiceOptions {
  getLogsDir: () => Promise<string>;
  getGatewayContext: () => Promise<DiagnosticGatewayContext>;
  fetch: typeof fetch;
  temporaryRoot: string;
  maxUncompressedBytes: number;
  maxCompressedBytes: number;
}

export type DiagnosticUploadErrorCode =
  | 'DIAGNOSTIC_NO_LOGS'
  | 'DIAGNOSTIC_RANGE_TOO_LARGE'
  | 'DIAGNOSTIC_SERVICE_UNAVAILABLE'
  | 'DIAGNOSTIC_UPLOAD_FAILED';

export class DiagnosticUploadError extends Error {
  public readonly cause?: unknown;

  constructor(
    public readonly code: DiagnosticUploadErrorCode,
    message: string,
    public readonly statusCode: number,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'DiagnosticUploadError';
    this.cause = options?.cause;
  }
}

function parseLogTimestamp(line: string): number | null {
  const isoMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})/);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[0]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const localMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/);
  if (localMatch) {
    const parsed = Date.parse(`${localMatch[1]}T${localMatch[2]}`);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function timestampsInText(value: string): number[] {
  return value
    .split(/\r?\n/)
    .map(parseLogTimestamp)
    .filter((item): item is number => item !== null);
}

async function inspectLogFile(path: string, name: string): Promise<LogFileDescriptor> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error('not a regular file');
  if (details.size === 0) {
    return { path, name, size: 0, availableFromMs: null, availableToMs: null };
  }

  const handle = await open(path, 'r');
  try {
    const firstLength = Math.min(details.size, TIMESTAMP_SAMPLE_BYTES);
    const lastOffset = Math.max(0, details.size - TIMESTAMP_SAMPLE_BYTES);
    const first = Buffer.alloc(firstLength);
    const last = Buffer.alloc(details.size - lastOffset);
    await handle.read(first, 0, first.length, 0);
    await handle.read(last, 0, last.length, lastOffset);
    const firstTimes = timestampsInText(first.toString('utf8'));
    const lastTimes = timestampsInText(last.toString('utf8'));
    return {
      path,
      name,
      size: details.size,
      availableFromMs: firstTimes[0] ?? lastTimes[0] ?? null,
      availableToMs: lastTimes.at(-1) ?? firstTimes.at(-1) ?? null,
    };
  } finally {
    await handle.close();
  }
}

async function selectLogRange(
  files: LogFileDescriptor[],
  fromMs: number,
  toMs: number,
  maxUncompressedBytes: number,
): Promise<SelectedLog> {
  const selected: SelectedBlock[] = [];
  let selectedBytes = 0;

  for (const [fileOrder, file] of files.entries()) {
    if (file.size === 0) continue;
    if (file.availableToMs !== null && file.availableToMs < fromMs) continue;
    if (file.availableFromMs !== null && file.availableFromMs > toMs) continue;

    const lines = createInterface({ input: createReadStream(file.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    let currentTimestamp: number | null = null;
    let currentLines: string[] = [];
    let blockOrder = 0;

    const finishBlock = () => {
      if (currentTimestamp === null || currentTimestamp < fromMs || currentTimestamp > toMs) return;
      const bytes = Buffer.byteLength(`${currentLines.join('\n')}\n`, 'utf8');
      selectedBytes += bytes;
      if (selectedBytes > maxUncompressedBytes) {
        throw new DiagnosticUploadError(
          'DIAGNOSTIC_RANGE_TOO_LARGE',
          'Selected logs exceed the uncompressed upload limit',
          413,
        );
      }
      selected.push({ timestampMs: currentTimestamp, fileOrder, blockOrder, lines: currentLines, bytes });
      blockOrder += 1;
    };

    try {
      for await (const line of lines) {
        const timestamp = parseLogTimestamp(line);
        if (timestamp !== null) {
          finishBlock();
          currentTimestamp = timestamp;
          currentLines = [line];
        } else if (currentTimestamp !== null) {
          currentLines.push(line);
        }
      }
      finishBlock();
    } finally {
      lines.close();
    }
  }

  if (selected.length === 0) {
    throw new DiagnosticUploadError('DIAGNOSTIC_NO_LOGS', 'No log entries were found in the selected range', 404);
  }

  selected.sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.fileOrder - right.fileOrder
    || left.blockOrder - right.blockOrder
  ));
  const rawContent = `${selected.map((block) => block.lines.join('\n')).join('\n')}\n`;
  return {
    content: redactSensitiveText(rawContent),
    lineCount: selected.reduce((sum, block) => sum + block.lines.length, 0),
    includedFromMs: selected[0].timestampMs,
    includedToMs: selected.at(-1)!.timestampMs,
  };
}

export class DiagnosticLogUploadService {
  private static instance: DiagnosticLogUploadService | null = null;
  private readonly options: DiagnosticServiceOptions;

  constructor(options: Partial<DiagnosticServiceOptions> = {}) {
    this.options = {
      getLogsDir: options.getLogsDir ?? (() => tx5drPaths.getLogsDir()),
      getGatewayContext: options.getGatewayContext
        ?? (() => TelemetryService.getInstance().getDiagnosticGatewayContext()),
      fetch: options.fetch ?? fetch,
      temporaryRoot: options.temporaryRoot ?? tmpdir(),
      maxUncompressedBytes: options.maxUncompressedBytes ?? DIAGNOSTIC_MAX_UNCOMPRESSED_BYTES,
      maxCompressedBytes: options.maxCompressedBytes ?? DIAGNOSTIC_MAX_COMPRESSED_BYTES,
    };
  }

  static getInstance(): DiagnosticLogUploadService {
    DiagnosticLogUploadService.instance ??= new DiagnosticLogUploadService();
    return DiagnosticLogUploadService.instance;
  }

  private async descriptorsFor(source: SourceDefinition): Promise<LogFileDescriptor[]> {
    const logsDir = await this.options.getLogsDir();
    let entries;
    try {
      entries = await readdir(logsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const descriptors = await Promise.all(entries
      .filter((entry) => entry.isFile() && source.matches(entry.name))
      .map((entry) => inspectLogFile(join(logsDir, entry.name), entry.name)));
    return descriptors.sort((left, right) => (
      (left.availableFromMs ?? Number.MAX_SAFE_INTEGER) - (right.availableFromMs ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name)
    ));
  }

  async listSources(): Promise<DiagnosticLogSourcesResponse> {
    const sources: DiagnosticLogSource[] = [];
    for (const definition of SOURCE_DEFINITIONS) {
      const files = await this.descriptorsFor(definition);
      if (files.length === 0) continue;
      const knownStarts = files.map((file) => file.availableFromMs).filter((value): value is number => value !== null);
      const knownEnds = files.map((file) => file.availableToMs).filter((value): value is number => value !== null);
      sources.push({
        id: definition.id,
        fileName: definition.fileName,
        fileCount: files.length,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        availableFromMs: knownStarts.length > 0 ? Math.min(...knownStarts) : null,
        availableToMs: knownEnds.length > 0 ? Math.max(...knownEnds) : null,
      });
    }
    return {
      sources,
      limits: {
        maxRangeMs: DIAGNOSTIC_MAX_RANGE_MS,
        maxUncompressedBytes: this.options.maxUncompressedBytes,
        maxCompressedBytes: this.options.maxCompressedBytes,
        feedbackMaxCharacters: DIAGNOSTIC_FEEDBACK_MAX_CHARACTERS,
      },
    };
  }

  async upload(request: CreateDiagnosticUploadRequest): Promise<DiagnosticUploadReceipt> {
    const definition = SOURCE_DEFINITIONS.find((source) => source.id === request.sourceId);
    if (!definition) throw new DiagnosticUploadError('DIAGNOSTIC_NO_LOGS', 'Unknown diagnostic source', 404);
    const files = await this.descriptorsFor(definition);
    if (files.length === 0) throw new DiagnosticUploadError('DIAGNOSTIC_NO_LOGS', 'The selected log source is unavailable', 404);

    const selected = await selectLogRange(files, request.fromMs, request.toMs, this.options.maxUncompressedBytes);
    const uncompressed = Buffer.from(selected.content, 'utf8');
    if (uncompressed.length > this.options.maxUncompressedBytes) {
      throw new DiagnosticUploadError('DIAGNOSTIC_RANGE_TOO_LARGE', 'Selected logs exceed the uncompressed upload limit', 413);
    }
    const compressed = await gzip(uncompressed);
    if (compressed.length > this.options.maxCompressedBytes) {
      throw new DiagnosticUploadError('DIAGNOSTIC_RANGE_TOO_LARGE', 'Selected logs exceed the compressed upload limit', 413);
    }

    const temporaryDir = await mkdtemp(join(this.options.temporaryRoot, 'tx5dr-diagnostic-'));
    const temporaryFile = join(temporaryDir, `${randomUUID()}.log.gz`);
    try {
      await writeFile(temporaryFile, compressed, { mode: 0o600 });
      const uploadBytes = await readFile(temporaryFile);
      return await this.sendToGateway(request, selected, uncompressed.length, uploadBytes);
    } finally {
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async sendToGateway(
    request: CreateDiagnosticUploadRequest,
    selected: SelectedLog,
    uncompressedBytes: number,
    compressed: Buffer,
  ): Promise<DiagnosticUploadReceipt> {
    const context = await this.options.getGatewayContext();
    const authorization = await this.postJson<{
      diagnostics_token: string;
    }>(context, '/v1/diagnostics/authorize', {
      schema_version: 1,
      authorization_event_id: randomUUID(),
      installation_id: context.installationId,
      app: context.app,
    });
    if (typeof authorization.diagnostics_token !== 'string') {
      throw new DiagnosticUploadError('DIAGNOSTIC_SERVICE_UNAVAILABLE', 'Diagnostic authorization response is invalid', 503);
    }

    const uploadId = randomUUID();
    const sha256 = createHash('sha256').update(compressed).digest('hex');
    const grant = await this.postJson<{
      upload_url: string;
      form_fields: Record<string, string>;
      upload_receipt: string;
    }>(context, '/v1/diagnostics/uploads', {
      schema_version: 1,
      upload_id: uploadId,
      app: context.app,
      source_id: request.sourceId,
      requested_from_ms: request.fromMs,
      requested_to_ms: request.toMs,
      included_from_ms: selected.includedFromMs,
      included_to_ms: selected.includedToMs,
      line_count: selected.lineCount,
      uncompressed_bytes: uncompressedBytes,
      compressed_bytes: compressed.length,
      sha256,
      is_test: false,
    }, authorization.diagnostics_token);
    if (!grant.upload_url || !grant.upload_receipt || !grant.form_fields) {
      throw new DiagnosticUploadError('DIAGNOSTIC_SERVICE_UNAVAILABLE', 'Diagnostic upload response is invalid', 503);
    }

    const form = new FormData();
    for (const [key, value] of Object.entries(grant.form_fields)) form.append(key, value);
    form.append('file', new Blob([new Uint8Array(compressed)], { type: 'application/gzip' }), basename('diagnostic.log.gz'));
    let uploadResponse: Response;
    try {
      uploadResponse = await this.options.fetch(grant.upload_url, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new DiagnosticUploadError('DIAGNOSTIC_UPLOAD_FAILED', 'Unable to upload the diagnostic log', 502, { cause: error });
    }
    if (uploadResponse.status !== 204) {
      throw new DiagnosticUploadError('DIAGNOSTIC_UPLOAD_FAILED', `OSS upload failed with status ${uploadResponse.status}`, 502);
    }

    const completeBody = {
      schema_version: 1,
      upload_receipt: grant.upload_receipt,
      ...(request.feedback?.trim() ? { feedback: request.feedback.trim() } : {}),
    };
    let complete: { accepted_at: string; retained_until: string };
    try {
      complete = await this.postJson(context, `/v1/diagnostics/uploads/${uploadId}/complete`, completeBody, authorization.diagnostics_token);
    } catch (error) {
      if (!(error instanceof DiagnosticUploadError) || error.code !== 'DIAGNOSTIC_SERVICE_UNAVAILABLE') throw error;
      await delay(250);
      complete = await this.postJson(context, `/v1/diagnostics/uploads/${uploadId}/complete`, completeBody, authorization.diagnostics_token);
    }

    return {
      uploadId,
      sourceId: request.sourceId,
      requestedFromMs: request.fromMs,
      requestedToMs: request.toMs,
      includedFromMs: selected.includedFromMs,
      includedToMs: selected.includedToMs,
      lineCount: selected.lineCount,
      uncompressedBytes,
      compressedBytes: compressed.length,
      acceptedAt: complete.accepted_at,
      retainedUntil: complete.retained_until,
    };
  }

  private async postJson<T>(
    context: DiagnosticGatewayContext,
    path: string,
    body: unknown,
    token?: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.options.fetch(`${context.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new DiagnosticUploadError('DIAGNOSTIC_SERVICE_UNAVAILABLE', 'Diagnostic service is unreachable', 503, { cause: error });
    }
    if (!response.ok) {
      throw new DiagnosticUploadError(
        response.status >= 500 || response.status === 429
          ? 'DIAGNOSTIC_SERVICE_UNAVAILABLE'
          : 'DIAGNOSTIC_UPLOAD_FAILED',
        `Diagnostic gateway rejected ${path} with status ${response.status}`,
        response.status >= 500 || response.status === 429 ? 503 : 502,
      );
    }
    try {
      return await response.json() as T;
    } catch (error) {
      throw new DiagnosticUploadError('DIAGNOSTIC_SERVICE_UNAVAILABLE', 'Diagnostic service returned invalid JSON', 503, { cause: error });
    }
  }
}
