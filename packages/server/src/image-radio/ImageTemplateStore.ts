import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ImageTemplateSchema, type ImageTemplate } from '@tx5dr/contracts';

import { SafeFileWriter, loadJsonWithRecovery } from '../utils/persistence/index.js';

interface TemplateIndex { templates: ImageTemplate[] }

function builtInTemplates(now = Date.now()): ImageTemplate[] {
  const layer = (id: string, text: string, y: number, fontSize: number) => ({
    id, text, x: 0.06, y, width: 0.88, height: 0.18, fontSize,
    color: '#ffffff', strokeColor: '#000000', strokeWidth: 0.12, align: 'center' as const, rotation: 0,
  });
  return [
    { id: 'builtin-cq', name: 'CQ', builtIn: true, layers: [layer('title', 'CQ SSTV', 0.08, 0.12), layer('call', '{MYCALL}', 0.68, 0.14)], createdAt: now, updatedAt: now },
    { id: 'builtin-reply', name: '595', builtIn: true, layers: [layer('to', '{HISCALL}', 0.06, 0.11), layer('report', 'RSV {RSV}', 0.68, 0.12), layer('from', '{MYCALL}', 0.82, 0.08)], createdAt: now, updatedAt: now },
    { id: 'builtin-73', name: '73', builtIn: true, layers: [layer('title', '73 {HISCALL}', 0.12, 0.13), layer('from', '{MYCALL}', 0.72, 0.11)], createdAt: now, updatedAt: now },
  ];
}

export class ImageTemplateStore {
  private readonly writer = new SafeFileWriter({ backups: 3 });
  private readonly filePath: string;
  private templates: ImageTemplate[] = [];
  private initialized = false;

  constructor(baseDir: string) { this.filePath = path.join(baseDir, 'templates.json'); }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await loadJsonWithRecovery<TemplateIndex>(this.filePath, {
      defaultValue: () => ({ templates: [] }),
      validate: (value) => ({ templates: ImageTemplateSchema.array().parse((value as TemplateIndex)?.templates ?? []) }),
      writer: this.writer,
    });
    this.templates = loaded.value.templates.filter((item) => !item.builtIn);
    this.initialized = true;
  }

  list(operatorId?: string): ImageTemplate[] {
    return [...builtInTemplates(), ...this.templates.filter((item) => item.operatorId === operatorId)];
  }

  referencesArtifact(artifactId: string): boolean {
    return this.templates.some((template) => template.backgroundArtifactId === artifactId);
  }

  async save(operatorId: string, input: Pick<ImageTemplate, 'id' | 'name' | 'backgroundArtifactId' | 'layers'>): Promise<ImageTemplate> {
    await this.initialize();
    const now = Date.now();
    const existing = this.templates.find((item) => item.id === input.id && item.operatorId === operatorId);
    const template = ImageTemplateSchema.parse({
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      operatorId,
      builtIn: false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.templates = [
      ...this.templates.filter((item) => !(item.id === template.id && item.operatorId === operatorId)),
      template,
    ];
    await this.persist();
    return template;
  }

  async delete(operatorId: string, id: string): Promise<void> {
    await this.initialize();
    if (id.startsWith('builtin-')) throw new Error('IMAGE_TEMPLATE_BUILTIN_READONLY');
    const next = this.templates.filter((item) => !(item.id === id && item.operatorId === operatorId));
    if (next.length === this.templates.length) throw new Error('IMAGE_TEMPLATE_NOT_FOUND');
    this.templates = next;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.writer.writeFile(this.filePath, `${JSON.stringify({ templates: this.templates }, null, 2)}\n`);
  }
}
