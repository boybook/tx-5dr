export interface ImagePaperRow {
  width: number;
  pixels: Uint8Array;
  rowRevision: number;
}

interface StoredImagePaperRow extends ImagePaperRow {
  version: number;
}

const ROW_BUCKET_LINES = 256;

export class ImagePaperRowStore {
  private readonly buckets = new Map<number, Map<number, StoredImagePaperRow>>();
  private nextVersion = 1;

  clear(): void {
    this.buckets.clear();
    this.nextVersion += 1;
  }

  set(rowIndex: number, row: ImagePaperRow): boolean {
    const bucketIndex = Math.floor(rowIndex / ROW_BUCKET_LINES);
    let bucket = this.buckets.get(bucketIndex);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(bucketIndex, bucket);
    }
    const previous = bucket.get(rowIndex);
    if (previous && previous.rowRevision >= row.rowRevision) return false;

    const version = this.nextVersion++;
    bucket.set(rowIndex, { ...row, version });
    return true;
  }

  deleteBefore(lineIndex: number): void {
    for (const [bucketIndex, bucket] of this.buckets) {
      const bucketEnd = (bucketIndex + 1) * ROW_BUCKET_LINES;
      if (bucketEnd <= lineIndex) {
        this.buckets.delete(bucketIndex);
        continue;
      }
      for (const rowIndex of bucket.keys()) {
        if (rowIndex < lineIndex) bucket.delete(rowIndex);
      }
      if (bucket.size === 0) {
        this.buckets.delete(bucketIndex);
      }
    }
  }

  rangeRevision(startLine: number, endLine: number): number {
    if (endLine <= startLine) return 0;
    const firstBucket = Math.floor(startLine / ROW_BUCKET_LINES);
    const lastBucket = Math.floor((endLine - 1) / ROW_BUCKET_LINES);
    let revision = 0;
    for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex += 1) {
      const bucket = this.buckets.get(bucketIndex);
      if (!bucket) continue;
      for (const [rowIndex, row] of bucket) {
        if (rowIndex >= startLine && rowIndex < endLine) revision = Math.max(revision, row.version);
      }
    }
    return revision;
  }

  get(rowIndex: number): ImagePaperRow | undefined {
    return this.buckets.get(Math.floor(rowIndex / ROW_BUCKET_LINES))?.get(rowIndex);
  }

  forEachInRange(startLine: number, endLine: number, callback: (rowIndex: number, row: ImagePaperRow) => void): void {
    if (endLine <= startLine) return;
    const firstBucket = Math.floor(startLine / ROW_BUCKET_LINES);
    const lastBucket = Math.floor((endLine - 1) / ROW_BUCKET_LINES);
    for (let bucketIndex = firstBucket; bucketIndex <= lastBucket; bucketIndex += 1) {
      const bucket = this.buckets.get(bucketIndex);
      if (!bucket) continue;
      for (const [rowIndex, row] of bucket) {
        if (rowIndex >= startLine && rowIndex < endLine) callback(rowIndex, row);
      }
    }
  }
}

export function decodeImageRowBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function writePaperRowsToRgba(
  target: Uint8ClampedArray,
  targetWidth: number,
  startLine: number,
  endLine: number,
  pixelFormat: 'rgb8' | 'gray8',
  rows: ImagePaperRowStore,
  calibration?: ImageFaxCalibration,
  calibrationStartLine = startLine,
): void {
  target.fill(0);
  if (pixelFormat === 'gray8' && calibration) {
    const phases = Array.from({ length: endLine - startLine }, (_, index) =>
      faxPhaseAtLine(calibration, startLine + index, targetWidth, calibrationStartLine));
    let sourceMin = Number.POSITIVE_INFINITY;
    let sourceMax = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < phases.length; index += 1) {
      const base = (startLine + index) * targetWidth - phases[index];
      sourceMin = Math.min(sourceMin, base);
      sourceMax = Math.max(sourceMax, base + targetWidth);
    }
    const firstSourceLine = Math.max(0, Math.floor(sourceMin / targetWidth));
    const lastSourceLine = Math.max(firstSourceLine, Math.floor(sourceMax / targetWidth));
    const sourceRows = Array.from({ length: lastSourceLine - firstSourceLine + 1 }, (_, index) => rows.get(firstSourceLine + index));
    const sample = (linear: number) => {
      if (linear < 0) return 255;
      const line = Math.floor(linear / targetWidth);
      const column = linear - line * targetWidth;
      const row = sourceRows[line - firstSourceLine];
      if (!row || column < 0 || column >= row.width) return 255;
      return row.pixels[column] ?? 255;
    };
    for (let rowIndex = startLine; rowIndex < endLine; rowIndex += 1) {
      const phase = phases[rowIndex - startLine];
      const targetRow = (rowIndex - startLine) * targetWidth * 4;
      for (let x = 0; x < targetWidth; x += 1) {
        const sourceLinear = rowIndex * targetWidth + x - phase;
        const left = Math.floor(sourceLinear);
        const fraction = sourceLinear - left;
        const leftValue = sample(left);
        const rightValue = sample(left + 1);
        const gray = Math.round(leftValue + (rightValue - leftValue) * fraction);
        const targetPixel = targetRow + x * 4;
        target[targetPixel] = gray; target[targetPixel + 1] = gray; target[targetPixel + 2] = gray; target[targetPixel + 3] = 255;
      }
    }
    return;
  }
  rows.forEachInRange(startLine, endLine, (rowIndex, row) => {
    if (row.width <= 0) return;
    const targetRow = (rowIndex - startLine) * targetWidth * 4;
    const sameWidth = row.width === targetWidth;
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = sameWidth ? x : Math.min(row.width - 1, Math.floor(x * row.width / targetWidth));
      const targetPixel = targetRow + x * 4;
      if (pixelFormat === 'rgb8') {
        const sourcePixel = sourceX * 3;
        target[targetPixel] = row.pixels[sourcePixel] ?? 0;
        target[targetPixel + 1] = row.pixels[sourcePixel + 1] ?? 0;
        target[targetPixel + 2] = row.pixels[sourcePixel + 2] ?? 0;
      } else {
        const gray = row.pixels[sourceX] ?? 0;
        target[targetPixel] = gray;
        target[targetPixel + 1] = gray;
        target[targetPixel + 2] = gray;
      }
      target[targetPixel + 3] = 255;
    }
  });
}

function faxPhaseAtLine(calibration: ImageFaxCalibration, line: number, width: number, segmentStart: number): number {
  const points = calibration.autoEnabled
    ? [...calibration.autoPoints].sort((left, right) => left.referenceLine - right.referenceLine || left.revision - right.revision)
    : [];
  let phase = 0;
  if (points.length > 0) {
    const index = points.findIndex((point) => point.referenceLine > line);
    const left = points[index < 0 ? points.length - 1 : Math.max(0, index - 1)];
    const right = index > 0 ? points[index] : undefined;
    if (right && right.referenceLine > left.referenceLine) {
      const progress = (line - left.referenceLine) / (right.referenceLine - left.referenceLine);
      phase = left.phasePixels + (right.phasePixels - left.phasePixels) * Math.max(0, Math.min(1, progress));
    } else {
      phase = left.phasePixels + Math.max(0, line - left.referenceLine) * left.clockPpm * width / 1_000_000;
    }
  }
  return phase + calibration.manualPhasePixels
    + Math.max(0, line - segmentStart) * calibration.manualClockPpm * width / 1_000_000;
}
import type { ImageFaxCalibration } from '@tx5dr/contracts';
