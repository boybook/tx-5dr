import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ImageArtifactSchema, type ImageArtifact, type ImageFamily, type ImagePixelFormat } from '@tx5dr/contracts';
import { PNG } from 'pngjs';

import { SafeFileWriter, loadJsonWithRecovery } from '../utils/persistence/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ImageArtifactStore');
const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface ArtifactIndex { artifacts: ImageArtifact[] }

export interface SaveArtifactInput {
  family: ImageFamily;
  direction: 'rx' | 'tx';
  operatorId?: string;
  codecMode: string;
  pixelFormat: ImagePixelFormat;
  width: number;
  height: number;
  pixels: Uint8Array;
  frequency: number;
  radioMode?: string;
  complete: boolean;
  saveReason?: 'manual' | 'protocolEnd';
  captureStartedAt?: number;
  captureEndedAt?: number;
  truncated?: boolean;
}

export class ImageArtifactStore {
  private readonly writer = new SafeFileWriter({ backups: 3 });
  private readonly artifacts = new Map<string, ImageArtifact>();
  private readonly indexPath: string;
  private readonly imageDir: string;
  private initialized = false;
  private removalListener?: (artifactId: string) => Promise<void>;

  constructor(private readonly baseDir: string, private readonly quotaBytes = DEFAULT_QUOTA_BYTES) {
    this.indexPath = path.join(baseDir, 'index.json');
    this.imageDir = path.join(baseDir, 'images');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.imageDir, { recursive: true });
    const loaded = await loadJsonWithRecovery<ArtifactIndex>(this.indexPath, {
      defaultValue: () => ({ artifacts: [] }),
      validate: (value) => {
        const record = value as { artifacts?: unknown };
        return { artifacts: ImageArtifactSchema.array().parse(record?.artifacts ?? []) };
      },
      writer: this.writer,
    });
    for (const artifact of loaded.value.artifacts) this.artifacts.set(artifact.id, artifact);
    this.initialized = true;
    await this.enforceQuota();
  }

  list(options: { family?: ImageFamily; direction?: 'rx' | 'tx'; operatorId?: string; limit?: number; offset?: number } = {}): ImageArtifact[] {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    return [...this.artifacts.values()]
      .filter((item) => !options.family || item.family === options.family)
      .filter((item) => !options.direction || item.direction === options.direction)
      .filter((item) => !options.operatorId || item.operatorId === options.operatorId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(offset, offset + limit);
  }

  listAll(): ImageArtifact[] {
    return [...this.artifacts.values()];
  }

  setRemovalListener(listener: (artifactId: string) => Promise<void>): void {
    this.removalListener = listener;
  }

  get(id: string): ImageArtifact | null {
    return this.artifacts.get(id) ?? null;
  }

  async readImage(id: string): Promise<Buffer> {
    if (!this.artifacts.has(id)) throw new Error('IMAGE_ARTIFACT_NOT_FOUND');
    return fs.readFile(this.imagePath(id));
  }

  async readRgbPixels(id: string): Promise<{ artifact: ImageArtifact; pixels: Uint8Array }> {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error('IMAGE_ARTIFACT_NOT_FOUND');
    const decoded = PNG.sync.read(await this.readImage(id), { checkCRC: true });
    const pixels = new Uint8Array(decoded.width * decoded.height * 3);
    for (let source = 0, target = 0; source < decoded.data.length; source += 4) {
      const alpha = decoded.data[source + 3] / 255;
      pixels[target++] = Math.round(decoded.data[source] * alpha);
      pixels[target++] = Math.round(decoded.data[source + 1] * alpha);
      pixels[target++] = Math.round(decoded.data[source + 2] * alpha);
    }
    return { artifact, pixels };
  }

  async save(input: SaveArtifactInput): Promise<ImageArtifact> {
    await this.initialize();
    const channels = input.pixelFormat === 'rgb8' ? 3 : 1;
    if (input.pixels.length !== input.width * input.height * channels) {
      throw new Error('IMAGE_INVALID_PIXEL_BUFFER');
    }
    const png = new PNG({ width: input.width, height: input.height });
    for (let index = 0, pixel = 0; pixel < input.width * input.height; pixel += 1) {
      const out = pixel * 4;
      if (channels === 3) {
        png.data[out] = input.pixels[index++];
        png.data[out + 1] = input.pixels[index++];
        png.data[out + 2] = input.pixels[index++];
      } else {
        const gray = input.pixels[index++];
        png.data[out] = gray;
        png.data[out + 1] = gray;
        png.data[out + 2] = gray;
      }
      png.data[out + 3] = 255;
    }
    const encoded = PNG.sync.write(png, { colorType: 6 });
    const id = randomUUID();
    const artifact: ImageArtifact = {
      id,
      family: input.family,
      direction: input.direction,
      operatorId: input.operatorId,
      codecMode: input.codecMode,
      pixelFormat: input.pixelFormat,
      width: input.width,
      height: input.height,
      frequency: input.frequency,
      radioMode: input.radioMode,
      complete: input.complete,
      saveReason: input.saveReason,
      captureStartedAt: input.captureStartedAt,
      captureEndedAt: input.captureEndedAt,
      truncated: input.truncated ?? false,
      pinned: false,
      contentHash: createHash('sha256').update(encoded).digest('hex'),
      createdAt: Date.now(),
      imageUrl: `/api/image-radio/artifacts/${id}/image`,
    };
    await this.writer.writeFile(this.imagePath(id), encoded, { backups: 0 });
    this.artifacts.set(id, artifact);
    await this.persistIndex();
    await this.enforceQuota();
    return artifact;
  }

  async importNormalizedSstvPng(input: { png: Buffer; mode: string; width: number; height: number; operatorId: string; frequency: number; radioMode?: string }): Promise<{ artifact: ImageArtifact; pixels: Uint8Array }> {
    if (input.png.length > 2 * 1024 * 1024 || input.png.length < 33
      || !input.png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      || input.png.subarray(12, 16).toString('ascii') !== 'IHDR') {
      throw new Error('IMAGE_UPLOAD_INVALID_PNG');
    }
    const declaredWidth = input.png.readUInt32BE(16);
    const declaredHeight = input.png.readUInt32BE(20);
    if (declaredWidth !== input.width || declaredHeight !== input.height) throw new Error('IMAGE_UPLOAD_DIMENSION_MISMATCH');
    let decoded: PNG;
    try {
      decoded = PNG.sync.read(input.png, { checkCRC: true });
    } catch {
      throw new Error('IMAGE_UPLOAD_INVALID_PNG');
    }
    const pixels = new Uint8Array(decoded.width * decoded.height * 3);
    for (let source = 0, target = 0; source < decoded.data.length; source += 4) {
      const alpha = decoded.data[source + 3] / 255;
      pixels[target++] = Math.round(decoded.data[source] * alpha);
      pixels[target++] = Math.round(decoded.data[source + 1] * alpha);
      pixels[target++] = Math.round(decoded.data[source + 2] * alpha);
    }
    const artifact = await this.save({
      family: 'sstv', direction: 'tx', operatorId: input.operatorId, codecMode: input.mode,
      pixelFormat: 'rgb8', width: decoded.width, height: decoded.height, pixels,
      frequency: input.frequency, radioMode: input.radioMode, complete: true,
    });
    return { artifact, pixels };
  }

  async setPinned(id: string, pinned: boolean): Promise<ImageArtifact> {
    const current = this.artifacts.get(id);
    if (!current) throw new Error('IMAGE_ARTIFACT_NOT_FOUND');
    const updated = { ...current, pinned };
    this.artifacts.set(id, updated);
    await this.persistIndex();
    return updated;
  }

  async linkQso(id: string, qsoId: string): Promise<ImageArtifact> {
    const current = this.artifacts.get(id);
    if (!current) throw new Error('IMAGE_ARTIFACT_NOT_FOUND');
    const updated = { ...current, qsoId };
    this.artifacts.set(id, updated);
    await this.persistIndex();
    return updated;
  }

  async delete(id: string): Promise<ImageArtifact> {
    await this.initialize();
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error('IMAGE_ARTIFACT_NOT_FOUND');
    await fs.unlink(this.imagePath(id));
    this.artifacts.delete(id);
    await this.persistIndex();
    await this.removalListener?.(id);
    return artifact;
  }

  private imagePath(id: string): string { return path.join(this.imageDir, `${id}.png`); }

  private async persistIndex(): Promise<void> {
    await this.writer.writeFile(this.indexPath, `${JSON.stringify({ artifacts: [...this.artifacts.values()] }, null, 2)}\n`);
  }

  private async enforceQuota(): Promise<void> {
    const candidates = [...this.artifacts.values()].filter((item) => !item.pinned && !item.qsoId).sort((a, b) => a.createdAt - b.createdAt);
    let total = 0;
    const sizes = new Map<string, number>();
    for (const artifact of this.artifacts.values()) {
      const size = (await fs.stat(this.imagePath(artifact.id)).catch(() => null))?.size ?? 0;
      sizes.set(artifact.id, size);
      total += size;
    }
    let changed = false;
    for (const artifact of candidates) {
      if (total <= this.quotaBytes) break;
      await fs.unlink(this.imagePath(artifact.id)).catch(() => undefined);
      total -= sizes.get(artifact.id) ?? 0;
      this.artifacts.delete(artifact.id);
      await this.removalListener?.(artifact.id).catch((error) => {
        logger.error('Failed to remove image history for evicted artifact', { artifactId: artifact.id, error: error instanceof Error ? error.message : String(error) });
      });
      changed = true;
      logger.info('Removed old image artifact to enforce quota', { artifactId: artifact.id });
    }
    if (changed) await this.persistIndex();
  }
}
