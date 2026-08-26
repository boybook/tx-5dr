import path from 'node:path';

import {
  SstvTxEnvelopeSelectionSchema,
  SstvTxPreferencesSchema,
  type SstvTxEnvelopeSelection,
  type SstvTxPreferences,
} from '@tx5dr/contracts';

import { SafeFileWriter, loadJsonWithRecovery } from '../utils/persistence/index.js';

interface PreferenceIndex { preferences: SstvTxPreferences[] }

export class SstvTxPreferenceStore {
  private readonly writer = new SafeFileWriter({ backups: 3 });
  private readonly filePath: string;
  private readonly preferences = new Map<string, SstvTxPreferences>();
  private initialized = false;
  private persistTail: Promise<void> = Promise.resolve();

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'sstv-tx-preferences.json');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const loaded = await loadJsonWithRecovery<PreferenceIndex>(this.filePath, {
      defaultValue: () => ({ preferences: [] }),
      validate: (value) => ({
        preferences: SstvTxPreferencesSchema.array().parse(
          (value as PreferenceIndex)?.preferences ?? [],
        ),
      }),
      writer: this.writer,
    });
    for (const preference of loaded.value.preferences) {
      this.preferences.set(preference.operatorId, preference);
    }
    this.initialized = true;
  }

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
    this.preferences.set(operatorId, preference);
    await this.persist();
    return preference;
  }

  private persist(): Promise<void> {
    const serialized = `${JSON.stringify({ preferences: [...this.preferences.values()] }, null, 2)}\n`;
    const operation = this.persistTail
      .catch(() => undefined)
      .then(() => this.writer.writeFile(this.filePath, serialized));
    this.persistTail = operation;
    return operation;
  }
}
