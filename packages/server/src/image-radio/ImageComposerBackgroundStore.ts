import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ImageComposerBackgroundSchema, type ImageComposerBackground } from '@tx5dr/contracts';
import { PNG } from 'pngjs';

import { SafeFileWriter, loadJsonWithRecovery } from '../utils/persistence/index.js';

const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;
const MAX_BACKGROUND_DIMENSION = 1024;
const MAX_BACKGROUND_PIXELS = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

interface BackgroundIndex { backgrounds: ImageComposerBackground[] }

export class ImageComposerBackgroundStore {
  private readonly writer = new SafeFileWriter({ backups: 3 });
  private readonly indexPath: string;
  private readonly imageDir: string;
  private readonly backgrounds = new Map<string, ImageComposerBackground>();
  private initialized = false;
  private persistTail: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.indexPath = path.join(baseDir, 'composer-backgrounds.json');
    this.imageDir = path.join(baseDir, 'composer-backgrounds');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.imageDir, { recursive: true });
    const loaded = await loadJsonWithRecovery<BackgroundIndex>(this.indexPath, {
      defaultValue: () => ({ backgrounds: [] }),
      validate: (value) => ({ backgrounds: ImageComposerBackgroundSchema.array().parse((value as BackgroundIndex)?.backgrounds ?? []) }),
      writer: this.writer,
    });
    for (const background of loaded.value.backgrounds) this.backgrounds.set(background.operatorId, background);
    this.initialized = true;
  }

  get(operatorId: string): ImageComposerBackground | null {
    return this.backgrounds.get(operatorId) ?? null;
  }

  async read(operatorId: string): Promise<Buffer> {
    await this.initialize();
    if (!this.backgrounds.has(operatorId)) throw new Error('IMAGE_COMPOSER_BACKGROUND_NOT_FOUND');
    return fs.readFile(this.imagePath(operatorId));
  }

  async save(operatorId: string, source: Buffer): Promise<ImageComposerBackground> {
    await this.initialize();
    if (source.length < 33 || source.length > MAX_BACKGROUND_BYTES
      || !source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      || source.subarray(12, 16).toString('ascii') !== 'IHDR') {
      throw new Error('IMAGE_COMPOSER_BACKGROUND_INVALID');
    }
    const declaredWidth = source.readUInt32BE(16);
    const declaredHeight = source.readUInt32BE(20);
    if (declaredWidth < 1 || declaredHeight < 1
      || declaredWidth > MAX_BACKGROUND_DIMENSION || declaredHeight > MAX_BACKGROUND_DIMENSION
      || declaredWidth * declaredHeight > MAX_BACKGROUND_PIXELS) {
      throw new Error('IMAGE_COMPOSER_BACKGROUND_DIMENSIONS');
    }
    let decoded: PNG;
    try {
      decoded = PNG.sync.read(source, { checkCRC: true });
    } catch {
      throw new Error('IMAGE_COMPOSER_BACKGROUND_INVALID');
    }
    if (decoded.width !== declaredWidth || decoded.height !== declaredHeight) throw new Error('IMAGE_COMPOSER_BACKGROUND_INVALID');
    const encoded = PNG.sync.write(decoded, { colorType: 6 });
    const background = ImageComposerBackgroundSchema.parse({
      operatorId,
      width: decoded.width,
      height: decoded.height,
      updatedAt: Date.now(),
      imageUrl: `/api/image-radio/composer-backgrounds/${encodeURIComponent(operatorId)}/image`,
    });
    await this.writer.writeFile(this.imagePath(operatorId), encoded, { backups: 1 });
    this.backgrounds.set(operatorId, background);
    await this.persist();
    return background;
  }

  private imagePath(operatorId: string): string {
    const fileName = createHash('sha256').update(operatorId).digest('hex');
    return path.join(this.imageDir, `${fileName}.png`);
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify({ backgrounds: [...this.backgrounds.values()] }, null, 2)}\n`;
    const operation = this.persistTail.catch(() => undefined).then(() => this.writer.writeFile(this.indexPath, serialized));
    this.persistTail = operation;
    return operation;
  }
}
