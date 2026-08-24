import { createRequire } from 'node:module';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('RasterwaveRuntime');
const require = createRequire(import.meta.url);

export type RasterwaveModule = typeof import('rasterwave-node');

export interface RasterwaveAvailability {
  available: boolean;
  reason?: string;
}

export class RasterwaveRuntime {
  private module: RasterwaveModule | null = null;
  private loadError: string | null = null;

  getAvailability(): RasterwaveAvailability {
    if (this.module) return { available: true };
    if (this.loadError) return { available: false, reason: this.loadError };
    return { available: true };
  }

  load(): RasterwaveModule {
    if (this.module) return this.module;
    if (this.loadError) throw new Error(this.loadError);
    try {
      const loaded = require('rasterwave-node') as RasterwaveModule;
      if (loaded.sstvModes().length !== 31) {
        throw new Error('rasterwave-node mode catalog is incomplete');
      }
      this.module = loaded;
      return loaded;
    } catch (error) {
      this.loadError = this.describeError(error);
      logger.error('Native image codec is unavailable', { error: this.loadError });
      throw new Error(this.loadError);
    }
  }

  resetForTest(): void {
    this.module = null;
    this.loadError = null;
  }

  errorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.match(/RASTERWAVE_[A-Z_]+/)?.[0] ?? 'IMAGE_NATIVE_FAILED';
  }

  private describeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `IMAGE_NATIVE_UNAVAILABLE: ${message.replace(/\s+/g, ' ').trim()}`;
  }
}

export const rasterwaveRuntime = new RasterwaveRuntime();
