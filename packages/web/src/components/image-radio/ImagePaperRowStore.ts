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
): void {
  target.fill(0);
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
