import type { ImagePersistenceStatus } from '@tx5dr/contracts';
import { ImageArtifactStore } from './ImageArtifactStore.js';
import { ImageHistoryStore } from './ImageHistoryStore.js';
import { ImageTemplateStore } from './ImageTemplateStore.js';
import { ImageComposerBackgroundStore } from './ImageComposerBackgroundStore.js';
import { SstvTxPreferenceStore } from './SstvTxPreferenceStore.js';
import { jsonFailureCode } from '../utils/persistence/SafeFileWriter.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ImagePersistenceCoordinator');

export class ImagePersistenceCoordinator {
  readonly artifacts: ImageArtifactStore;
  readonly history: ImageHistoryStore;
  readonly templates: ImageTemplateStore;
  readonly backgrounds: ImageComposerBackgroundStore;
  readonly preferences: SstvTxPreferenceStore;
  private initialization?: Promise<void>;
  private available = false;

  constructor(baseDir: string) {
    this.artifacts = new ImageArtifactStore(baseDir);
    this.history = new ImageHistoryStore(baseDir);
    this.templates = new ImageTemplateStore(baseDir);
    this.backgrounds = new ImageComposerBackgroundStore(baseDir);
    this.preferences = new SstvTxPreferenceStore(baseDir);
  }

  getStatus(): ImagePersistenceStatus {
    return { available: this.available, stores: this.stores.map(store => store.persistence.getStatus()) };
  }

  private get stores() { return [this.artifacts, this.history, this.templates, this.backgrounds, this.preferences]; }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeStores();
    return this.initialization;
  }

  private async initializeStores(): Promise<void> {
    const results = await Promise.allSettled(this.stores.map(store => store.initialize()));
    if (results.some(result => result.status === 'rejected')) return;
    try {
      await this.history.reconcileReceivedArtifacts(this.artifacts.listAll());
      this.artifacts.setRemovalListener(id => this.history.removeByArtifact(id));
      this.available = true;
    } catch (error) {
      this.history.persistence.markUnavailable();
      logger.error('Image history reconciliation failed; image operations disabled', { filePath: this.history.persistence.filePath, code: jsonFailureCode(error) });
    }
  }
}
