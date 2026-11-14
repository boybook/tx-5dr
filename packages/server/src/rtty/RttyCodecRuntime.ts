import { createRequire } from 'node:module';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('RttyCodecRuntime');
const require = createRequire(import.meta.url);

export type RttyCodecModule = Pick<typeof import('rasterwave-node'), 'RttyEncoder' | 'RttyDecoder' | 'rttyProfiles'>
  /** Optional: older builds have no wideband scanner (the signal browser is then off). */
  & Partial<Pick<typeof import('rasterwave-node'), 'RttyScanner'>>;

/**
 * Lazily loads the RTTY modem from the native rasterwave binding.
 *
 * Kept separate from the image runtime: an older binding without RTTY must
 * disable RTTY only, never SSTV/FAX.
 */
export class RttyCodecRuntime {
  private module: RttyCodecModule | null = null;
  private loadError: string | null = null;

  getAvailability(): { available: boolean; reason?: string } {
    if (this.module) return { available: true };
    if (this.loadError) return { available: false, reason: this.loadError };
    try {
      this.load();
      return { available: true };
    } catch {
      return { available: false, reason: this.loadError ?? 'RTTY_NATIVE_UNAVAILABLE' };
    }
  }

  load(): RttyCodecModule {
    if (this.module) return this.module;
    if (this.loadError) throw new Error(this.loadError);
    try {
      const loaded = require('rasterwave-node') as Partial<RttyCodecModule>;
      if (typeof loaded.RttyEncoder !== 'function' || typeof loaded.RttyDecoder !== 'function'
        || typeof loaded.rttyProfiles !== 'function' || loaded.rttyProfiles().length === 0) {
        throw new Error('rasterwave-node does not provide the RTTY modem');
      }
      this.module = loaded as RttyCodecModule;
      return this.module;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.loadError = `RTTY_NATIVE_UNAVAILABLE: ${message.replace(/\s+/g, ' ').trim()}`;
      logger.error('Native RTTY codec is unavailable', { error: this.loadError });
      throw new Error(this.loadError);
    }
  }

  /** Test hook: inject a codec implementation. */
  useModuleForTest(module: RttyCodecModule | null): void {
    this.module = module;
    this.loadError = null;
  }
}

export const rttyCodecRuntime = new RttyCodecRuntime();
