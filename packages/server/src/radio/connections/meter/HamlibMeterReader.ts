import { createLogger } from '../../../utils/logger.js';
import type { MeterProfile, MeterReadContext, MeterData } from './types.js';

const logger = createLogger('HamlibMeterReader');

type MeterReadMethod = 'readAlc' | 'readSwr' | 'readPower' | 'readLevel';

/**
 * Runtime meter reader that delegates to a matched MeterProfile and
 * falls back to the default Hamlib profile on failure or when a
 * profile does not override a given meter.
 */
export class HamlibMeterReader {
  constructor(
    private readonly profile: MeterProfile,
    private readonly defaultProfile: MeterProfile,
  ) {}

  /**
   * Read all meters sequentially (serial connections are half-duplex)
   * and return a complete MeterData snapshot.
   */
  async readAll(ctx: MeterReadContext): Promise<MeterData> {
    const alc = await this.readWithFallback('readAlc', ctx);
    const swr = await this.readWithFallback('readSwr', ctx);
    const power = await this.readWithFallback('readPower', ctx);
    const level = await this.readWithFallback('readLevel', ctx);
    return { alc, swr, power, level };
  }

  /** Name of the active profile (for logging). */
  getProfileName(): string {
    return this.profile.name;
  }

  // -------------------------------------------------------------------------

  private async readWithFallback<K extends MeterReadMethod>(
    method: K,
    ctx: MeterReadContext,
  ): Promise<MeterData[K extends 'readAlc' ? 'alc' : K extends 'readSwr' ? 'swr' : K extends 'readPower' ? 'power' : 'level']> {
    type R = MeterData[K extends 'readAlc' ? 'alc' : K extends 'readSwr' ? 'swr' : K extends 'readPower' ? 'power' : 'level'];

    // 1. Try the matched profile's method.
    const profileFn = this.profile[method] as ((ctx: MeterReadContext) => Promise<R>) | undefined;
    if (profileFn) {
      try {
        return await profileFn.call(this.profile, ctx);
      } catch (error) {
        logger.warn(`Meter profile "${this.profile.name}" ${method} failed, falling back to default`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 2. Fall back to the default profile.
    const defaultFn = this.defaultProfile[method] as ((ctx: MeterReadContext) => Promise<R>) | undefined;
    if (defaultFn) {
      try {
        return await defaultFn.call(this.defaultProfile, ctx);
      } catch {
        return null as R;
      }
    }

    return null as R;
  }
}
