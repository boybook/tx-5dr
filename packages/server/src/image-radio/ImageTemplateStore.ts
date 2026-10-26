import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { ImageTemplateSchema, type ImageTemplate } from '@tx5dr/contracts';

import { ImageRecordStore } from './ImageRecordStore.js';
import { PersistedTemplateSchema } from './ImagePersistenceSchema.js';

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
  readonly persistence: ImageRecordStore<ImageTemplate>;
  private get templates() { return [...this.persistence.values.values()].filter(item => !item.builtIn); }

  constructor(baseDir: string) {
    this.persistence = new ImageRecordStore(path.join(baseDir, 'templates.json'), 'templates', 'templates', PersistedTemplateSchema, item => JSON.stringify([item.operatorId ?? null, item.id]));
  }

  initialize(): Promise<void> { return this.persistence.initialize(); }

  list(operatorId?: string): ImageTemplate[] {
    return [...builtInTemplates(), ...this.templates.filter((item) => item.operatorId === operatorId)];
  }

  referencesArtifact(artifactId: string): boolean {
    return this.templates.some((template) => template.backgroundArtifactId === artifactId
      || template.backgroundSource?.type === 'artifact' && template.backgroundSource.artifactId === artifactId
      || template.layers.some((layer) => 'kind' in layer && layer.kind === 'image' && layer.source.type === 'artifact' && layer.source.artifactId === artifactId));
  }

  async save(operatorId: string, input: Pick<ImageTemplate, 'id' | 'name' | 'backgroundArtifactId' | 'backgroundSource' | 'backgroundTransform' | 'layers'>): Promise<ImageTemplate> {
    return this.persistence.transaction(records => {
      const now = Date.now();
      const existing = [...records.values()].find((item) => item.id === input.id && item.operatorId === operatorId);
      const template = ImageTemplateSchema.parse({
        ...input,
        id: existing?.id ?? input.id ?? randomUUID(),
        operatorId,
        builtIn: false,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      records.set(JSON.stringify([operatorId, template.id]), template);
      return template;
    });
  }

  async delete(operatorId: string, id: string): Promise<void> {
    await this.persistence.transaction(records => {
      if (id.startsWith('builtin-')) throw new Error('IMAGE_TEMPLATE_BUILTIN_READONLY');
      const key = JSON.stringify([operatorId, id]);
      if (!records.delete(key)) throw new Error('IMAGE_TEMPLATE_NOT_FOUND');
    });
  }
}
