import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  ImageFamily,
  ImageFaxCalibration,
  ImageFaxCalibrationPoint,
  ImagePaperBoundary,
  ImagePaperSource,
  ImagePixelFormat,
  ImageSessionSummary,
} from '@tx5dr/contracts';
import { PNG } from 'pngjs';

const CHUNK_LINES = 256;
const DEFAULT_QUOTA_BYTES = 256 * 1024 * 1024;

interface ChunkDescriptor {
  startLine: number;
  endLine: number;
  filePath: string;
  bytes: number;
}

interface PaperSegment {
  boundary: ImagePaperBoundary;
  chunks: ChunkDescriptor[];
  activeChunkStart: number;
  activeRows: Map<number, { revision: number; pixels: Uint8Array }>;
  calibration?: ImageFaxCalibration;
  basis?: 'calibrated' | 'nominalPaper';
}

export interface PaperRangeSnapshot {
  family: ImageFamily;
  codecMode: string;
  pixelFormat: ImagePixelFormat;
  width: number;
  height: number;
  pixels: Uint8Array;
  startLine: number;
  endLine: number;
  startedAt: number;
  endedAt: number;
  truncated: boolean;
  source: ImagePaperSource;
  basis?: 'calibrated' | 'nominalPaper';
  calibration?: ImageFaxCalibration;
}

export interface PaperManifest {
  session: ImageSessionSummary;
  boundaries: ImagePaperBoundary[];
  segments: Array<{ boundaryId: string; startLine: number; endLine: number; width: number; pixelFormat: ImagePixelFormat; snapshotUrl: string; calibration?: ImageFaxCalibration }>;
}

export class ImagePaperSpool {
  private session: ImageSessionSummary | null = null;
  private readonly segments: PaperSegment[] = [];
  private readonly markers: ImagePaperBoundary[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private diskBytes = 0;
  private initialized = false;

  constructor(
    private readonly cacheDir: string,
    private readonly quotaBytes = DEFAULT_QUOTA_BYTES,
    private readonly onTruncated?: (firstAvailableLine: number) => void,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.rm(this.cacheDir, { recursive: true, force: true });
    await fs.mkdir(this.cacheDir, { recursive: true });
    this.initialized = true;
  }

  async reset(): Promise<void> {
    await this.writeChain.catch(() => undefined);
    await fs.rm(this.cacheDir, { recursive: true, force: true });
    await fs.mkdir(this.cacheDir, { recursive: true });
    this.session = null;
    this.segments.length = 0;
    this.markers.length = 0;
    this.writeChain = Promise.resolve();
    this.diskBytes = 0;
  }

  start(family: ImageFamily, generation: number, boundary: ImagePaperBoundary): ImageSessionSummary {
    this.session = {
      sessionId: randomUUID(), family, generation, revision: 0,
      codecMode: boundary.codecMode, width: boundary.width,
      receivedLines: boundary.lineIndex, firstAvailableLine: boundary.lineIndex,
      startedAt: boundary.timestamp,
    };
    this.segments.length = 0;
    this.markers.length = 0;
    this.addBoundary(boundary);
    return { ...this.session };
  }

  addBoundary(boundary: ImagePaperBoundary): void {
    if (!this.session) return;
    this.flushActiveSegment();
    this.segments.push({
      boundary,
      chunks: [],
      activeChunkStart: boundary.lineIndex,
      activeRows: new Map(),
      calibration: this.session.family === 'fax' && (boundary.source ?? 'rx') === 'rx'
        ? defaultFaxCalibration(boundary.boundaryId)
        : undefined,
    });
    this.session.codecMode = boundary.codecMode;
    this.session.width = boundary.width;
    this.session.revision += 1;
  }

  addMarker(boundary: ImagePaperBoundary): void {
    if (!this.session) return;
    this.markers.push(boundary);
    this.session.revision += 1;
  }

  setGeneration(generation: number): void {
    if (this.session) this.session.generation = generation;
  }

  appendRow(input: { lineIndex: number; width: number; pixelFormat: ImagePixelFormat; revision: number; pixels: Uint8Array; basis?: 'calibrated' | 'nominalPaper' }): boolean {
    const session = this.session;
    const segment = this.segments.at(-1);
    if (!session || !segment || input.width !== segment.boundary.width || input.pixelFormat !== segment.boundary.pixelFormat) return false;
    const channels = input.pixelFormat === 'rgb8' ? 3 : 1;
    if (input.pixels.length !== input.width * channels || input.lineIndex < segment.boundary.lineIndex) return false;
    if (segment.basis && input.basis && segment.basis !== input.basis) return false;
    segment.basis ??= input.basis;
    const chunkStart = segment.boundary.lineIndex
      + Math.floor((input.lineIndex - segment.boundary.lineIndex) / CHUNK_LINES) * CHUNK_LINES;
    if (chunkStart !== segment.activeChunkStart) {
      this.flushActiveSegment();
      segment.activeChunkStart = chunkStart;
    }
    const previous = segment.activeRows.get(input.lineIndex);
    if (previous && previous.revision > input.revision) return true;
    segment.activeRows.set(input.lineIndex, { revision: input.revision, pixels: new Uint8Array(input.pixels) });
    session.receivedLines = Math.max(session.receivedLines, input.lineIndex + 1);
    session.revision += 1;
    return true;
  }

  getSession(): ImageSessionSummary | null {
    return this.session ? { ...this.session } : null;
  }

  getManifest(): PaperManifest | null {
    const session = this.session;
    if (!session) return null;
    return {
      session: { ...session },
      boundaries: [
        ...this.segments.map((segment) => ({ ...segment.boundary })),
        ...this.markers.map((boundary) => ({ ...boundary })),
      ].sort((left, right) => left.lineIndex - right.lineIndex || left.timestamp - right.timestamp),
      segments: this.segments.map((segment, index) => ({
        boundaryId: segment.boundary.boundaryId,
        startLine: segment.boundary.lineIndex,
        endLine: this.segments[index + 1]?.boundary.lineIndex ?? session.receivedLines,
        width: segment.boundary.width,
        pixelFormat: segment.boundary.pixelFormat,
        snapshotUrl: `/api/image-radio/paper/segments/${encodeURIComponent(segment.boundary.boundaryId)}/snapshot?calibrationRevision=${segment.calibration?.revision ?? 0}`,
        calibration: segment.calibration ? cloneCalibration(segment.calibration) : undefined,
      })),
    };
  }

  latestManualRange(): { startLine: number; endLine: number } | null {
    const session = this.session;
    if (!session || session.receivedLines <= session.firstAvailableLine) return null;
    for (let index = this.segments.length - 1; index >= 0; index -= 1) {
      const segment = this.segments[index];
      if ((segment.boundary.source ?? 'rx') !== 'rx') continue;
      const isAnchor = segment.boundary.trusted
        || segment.boundary.kind === 'protocolEnd'
        || segment.boundary.kind === 'manualMode'
        || segment.boundary.kind === 'initial'
        || segment.boundary.kind === 'truncated'
        || segment.boundary.kind === 'localTxEnd';
      if (!isAnchor) continue;
      const startLine = Math.max(session.firstAvailableLine, segment.boundary.lineIndex);
      const endLine = Math.min(session.receivedLines, this.segments[index + 1]?.boundary.lineIndex ?? session.receivedLines);
      if (endLine > startLine) return { startLine, endLine };
    }
    return null;
  }

  async snapshotRange(startLine: number, endLine: number): Promise<PaperRangeSnapshot> {
    const session = this.session;
    const segment = this.segmentForLine(startLine);
    if (!session || !segment || endLine <= startLine) throw new Error('IMAGE_PAPER_RANGE_INVALID');
    const nextBoundary = this.segments[this.segments.indexOf(segment) + 1]?.boundary.lineIndex ?? session.receivedLines;
    const boundedEnd = Math.min(endLine, nextBoundary);
    if (boundedEnd <= startLine) throw new Error('IMAGE_PAPER_RANGE_INVALID');
    await this.writeChain;
    const channels = segment.boundary.pixelFormat === 'rgb8' ? 3 : 1;
    const height = boundedEnd - startLine;
    const rowBytes = segment.boundary.width * channels;
    const pixels = new Uint8Array(rowBytes * height);
    for (const chunk of segment.chunks) {
      if (chunk.endLine <= startLine || chunk.startLine >= boundedEnd) continue;
      const data = await fs.readFile(chunk.filePath);
      const copyStart = Math.max(startLine, chunk.startLine);
      const copyEnd = Math.min(boundedEnd, chunk.endLine);
      const source = (copyStart - chunk.startLine) * rowBytes;
      const target = (copyStart - startLine) * rowBytes;
      pixels.set(data.subarray(source, source + (copyEnd - copyStart) * rowBytes), target);
    }
    for (const [line, row] of segment.activeRows) {
      if (line >= startLine && line < boundedEnd) pixels.set(row.pixels, (line - startLine) * rowBytes);
    }
    return {
      family: session.family,
      codecMode: segment.boundary.codecMode,
      pixelFormat: segment.boundary.pixelFormat,
      width: segment.boundary.width,
      height,
      pixels,
      startLine,
      endLine: boundedEnd,
      startedAt: segment.boundary.timestamp,
      endedAt: Date.now(),
      truncated: startLine < segment.boundary.lineIndex || startLine <= session.firstAvailableLine && session.firstAvailableLine > 0,
      source: segment.boundary.source ?? 'rx',
      basis: segment.basis,
      calibration: segment.calibration ? cloneCalibration(segment.calibration) : undefined,
    };
  }

  async renderSegment(
    boundaryId: string,
    transform?: (snapshot: PaperRangeSnapshot) => Promise<Uint8Array>,
  ): Promise<Buffer> {
    const session = this.session;
    const index = this.segments.findIndex((segment) => segment.boundary.boundaryId === boundaryId);
    if (!session || index < 0) throw new Error('IMAGE_PAPER_SEGMENT_NOT_FOUND');
    const segment = this.segments[index];
    const endLine = this.segments[index + 1]?.boundary.lineIndex ?? session.receivedLines;
    const snapshot = await this.snapshotRange(segment.boundary.lineIndex, Math.max(segment.boundary.lineIndex + 1, endLine));
    const sourcePixels = transform ? await transform(snapshot) : snapshot.pixels;
    const png = new PNG({ width: snapshot.width, height: snapshot.height });
    const channels = snapshot.pixelFormat === 'rgb8' ? 3 : 1;
    for (let pixel = 0, source = 0; pixel < snapshot.width * snapshot.height; pixel += 1) {
      const target = pixel * 4;
      if (channels === 3) {
        png.data[target] = sourcePixels[source++];
        png.data[target + 1] = sourcePixels[source++];
        png.data[target + 2] = sourcePixels[source++];
      } else {
        const gray = sourcePixels[source++];
        png.data[target] = gray; png.data[target + 1] = gray; png.data[target + 2] = gray;
      }
      png.data[target + 3] = 255;
    }
    return encodePng(png);
  }

  addFaxCalibrationPoint(boundaryId: string, point: ImageFaxCalibrationPoint): ImageFaxCalibration | null {
    const segment = this.segments.find((candidate) => candidate.boundary.boundaryId === boundaryId);
    if (!segment?.calibration || !this.session) return null;
    const points = segment.calibration.autoPoints.filter((candidate) => candidate.revision !== point.revision);
    points.push({ ...point });
    points.sort((left, right) => left.referenceLine - right.referenceLine || left.revision - right.revision);
    segment.calibration.autoPoints = points.slice(-256);
    segment.calibration.revision += 1;
    segment.calibration.updatedAt = Date.now();
    this.session.revision += 1;
    return cloneCalibration(segment.calibration);
  }

  setFaxCalibration(input: {
    boundaryId: string; autoEnabled: boolean; phasePixels: number; clockPpm: number;
  }): ImageFaxCalibration | null {
    const segment = this.segments.find((candidate) => candidate.boundary.boundaryId === input.boundaryId);
    if (!segment?.calibration || !this.session) return null;
    segment.calibration.autoEnabled = input.autoEnabled;
    segment.calibration.manualPhasePixels = input.phasePixels;
    segment.calibration.manualClockPpm = input.clockPpm;
    segment.calibration.revision += 1;
    segment.calibration.updatedAt = Date.now();
    this.session.revision += 1;
    return cloneCalibration(segment.calibration);
  }

  resetFaxCalibration(boundaryId: string): ImageFaxCalibration | null {
    const segment = this.segments.find((candidate) => candidate.boundary.boundaryId === boundaryId);
    if (!segment?.calibration || !this.session) return null;
    segment.calibration.autoEnabled = true;
    segment.calibration.manualPhasePixels = 0;
    segment.calibration.manualClockPpm = 0;
    segment.calibration.revision += 1;
    segment.calibration.updatedAt = Date.now();
    this.session.revision += 1;
    return cloneCalibration(segment.calibration);
  }

  getFaxCalibration(boundaryId: string): ImageFaxCalibration | null {
    const calibration = this.segments.find((candidate) => candidate.boundary.boundaryId === boundaryId)?.calibration;
    return calibration ? cloneCalibration(calibration) : null;
  }

  private segmentForLine(line: number): PaperSegment | null {
    return [...this.segments].reverse().find((segment) => segment.boundary.lineIndex <= line) ?? null;
  }

  private flushActiveSegment(): void {
    const segment = this.segments.at(-1);
    if (!segment || segment.activeRows.size === 0) return;
    const rows = segment.activeRows;
    segment.activeRows = new Map();
    const startLine = segment.activeChunkStart;
    const endLine = Math.max(...rows.keys()) + 1;
    const channels = segment.boundary.pixelFormat === 'rgb8' ? 3 : 1;
    const rowBytes = segment.boundary.width * channels;
    const data = Buffer.alloc((endLine - startLine) * rowBytes);
    for (const [line, row] of rows) data.set(row.pixels, (line - startLine) * rowBytes);
    const filePath = path.join(this.cacheDir, `${randomUUID()}.raw`);
    const descriptor = { startLine, endLine, filePath, bytes: data.length };
    segment.chunks.push(descriptor);
    this.diskBytes += data.length;
    this.writeChain = this.writeChain.then(() => fs.writeFile(filePath, data, { mode: 0o600 }));
    this.enforceQuota();
  }

  private enforceQuota(): void {
    const session = this.session;
    if (!session) return;
    while (this.diskBytes > this.quotaBytes) {
      const segment = this.segments.find((candidate) => candidate.chunks.length > 0);
      const chunk = segment?.chunks.shift();
      if (!chunk) break;
      this.diskBytes -= chunk.bytes;
      session.firstAvailableLine = Math.max(session.firstAvailableLine, chunk.endLine);
      const current = this.segments.at(-1)?.boundary;
      if (current) {
        this.markers.splice(0, this.markers.length, ...this.markers.filter((marker) => marker.kind !== 'truncated'));
        this.markers.push({
          ...current,
          boundaryId: `truncated:${session.firstAvailableLine}`,
          lineIndex: session.firstAvailableLine,
          kind: 'truncated',
          trusted: false,
          timestamp: Date.now(),
        });
        session.revision += 1;
      }
      this.writeChain = this.writeChain.then(() => fs.unlink(chunk.filePath).catch(() => undefined));
      this.onTruncated?.(session.firstAvailableLine);
    }
  }
}

function defaultFaxCalibration(boundaryId: string): ImageFaxCalibration {
  return {
    boundaryId, revision: 0, autoEnabled: true, autoPoints: [],
    manualPhasePixels: 0, manualClockPpm: 0, updatedAt: Date.now(),
  };
}

function cloneCalibration(calibration: ImageFaxCalibration): ImageFaxCalibration {
  return { ...calibration, autoPoints: calibration.autoPoints.map((point) => ({ ...point })) };
}

function encodePng(png: PNG): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    png.pack()
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .once('error', reject)
      .once('end', () => resolve(Buffer.concat(chunks)));
  });
}
