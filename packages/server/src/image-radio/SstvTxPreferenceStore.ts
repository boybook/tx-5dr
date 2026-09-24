import path from 'node:path';

import {
  SstvTxEnvelopeSelectionSchema,
  SstvTxPreferencesSchema,
  type SstvTxEnvelopeSelection,
  type SstvTxPreferences,
} from '@tx5dr/contracts';

import { ImageRecordStore } from './ImageRecordStore.js';
import { PersistedPreferenceSchema } from './ImagePersistenceSchema.js';

export class SstvTxPreferenceStore {
  readonly persistence: ImageRecordStore<SstvTxPreferences>;
  private get preferences() { return this.persistence.values; }

  constructor(baseDir: string) {
    this.persistence = new ImageRecordStore(path.join(baseDir, 'sstv-tx-preferences.json'), 'preferences', 'preferences', PersistedPreferenceSchema, item => item.operatorId);
  }

  initialize(): Promise<void> { return this.persistence.initialize(); }

  get(operatorId: string): SstvTxPreferences {
    return this.preferences.get(operatorId) ?? {
      operatorId,
      enhancedPreamble: true,
      stationIdMode: 'fsk',
      updatedAt: 0,
    };
  }

  async save(
    operatorId: string,
    selection: SstvTxEnvelopeSelection,
  ): Promise<SstvTxPreferences> {
    await this.initialize();
    const parsed = SstvTxEnvelopeSelectionSchema.parse(selection);
    const preference = SstvTxPreferencesSchema.parse({
      operatorId,
      ...parsed,
      updatedAt: Date.now(),
    });
    await this.persistence.transaction(records => records.set(operatorId, preference));
    return preference;
  }

}
