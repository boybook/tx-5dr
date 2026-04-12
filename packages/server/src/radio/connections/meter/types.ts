import type { LevelMeterReading, MeterCapabilities } from '@tx5dr/contracts';
import type { MeterData } from '../IRadioConnection.js';
import type { MeterDecodeStrategy } from '../meterUtils.js';

/**
 * Hamlib rig metadata resolved from rigModel number.
 * Extracted here so it can be shared across meter modules.
 */
export type RigMetadata = {
  rigModel: number;
  mfgName: string;
  modelName: string;
};

/**
 * Context used to determine which MeterProfile matches the current rig.
 */
export interface MeterProfileMatchContext {
  manufacturer: string | null;
  modelName: string | null;
  rigModel: number | null;
  supportedLevels: ReadonlySet<string>;
  connectionType: 'serial' | 'network';
}

/**
 * Runtime context passed to MeterProfile read methods.
 * Provides controlled access to the rig instance — profiles never hold
 * a direct HamLib reference, keeping IO serialisation intact.
 */
export interface MeterReadContext {
  /** Read a Hamlib level value (wraps rig.getLevel, returns null on error). */
  getLevel(level: string): Promise<number | null>;

  /** Send a raw CAT command and receive the reply (serial mode only). */
  sendRaw(data: Buffer, replyMaxLen: number, terminator?: Buffer): Promise<Buffer>;

  /** Current operating frequency in Hz (for S-meter HF/VHF reference selection). */
  currentFrequencyHz: number;

  /** Hamlib supported levels detected at connect time. */
  supportedLevels: ReadonlySet<string>;

  /** Rig metadata — available in serial mode, null in network mode. */
  rigMetadata: Readonly<RigMetadata> | null;

  /** Max TX power in watts for the current frequency/mode (for power percent calc). */
  txPowerMaxWatts: number | null;

  /** Existing level meter decode strategy (icom/yaesu/generic display style). */
  levelDecodeStrategy: MeterDecodeStrategy;
}

/**
 * A MeterProfile describes how to read and calibrate meters for a
 * specific radio family.  Profiles are matched at connect time by
 * {@link MeterProfileMatchContext} and remain active for the session.
 *
 * Each read method is optional — when absent, the default Hamlib
 * profile supplies the fallback implementation.
 */
export interface MeterProfile {
  /** Unique identifier (e.g. 'yaesu-newcat'). */
  readonly name: string;

  /** Human-readable label for logs. */
  readonly label: string;

  /** Higher priority wins when multiple profiles match.  Default profile = 0. */
  readonly priority: number;

  /** Return true if this profile should be used for the given rig. */
  matches(ctx: MeterProfileMatchContext): boolean;

  // Optional per-meter overrides.  Undefined = fall back to default.
  readAlc?(ctx: MeterReadContext): Promise<MeterData['alc']>;
  readSwr?(ctx: MeterReadContext): Promise<MeterData['swr']>;
  readPower?(ctx: MeterReadContext): Promise<MeterData['power']>;
  readLevel?(ctx: MeterReadContext): Promise<MeterData['level']>;
}

export type { MeterData, LevelMeterReading, MeterCapabilities, MeterDecodeStrategy };
