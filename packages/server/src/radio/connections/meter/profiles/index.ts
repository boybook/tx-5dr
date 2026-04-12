import type { MeterProfile, MeterProfileMatchContext } from '../types.js';
import { defaultHamlibProfile } from './defaultHamlib.js';
import { yaesuNewcatProfile } from './yaesuNewcat.js';

export { defaultHamlibProfile } from './defaultHamlib.js';
export { yaesuNewcatProfile } from './yaesuNewcat.js';

/**
 * All registered meter profiles, sorted by priority descending.
 * The last entry (defaultHamlibProfile, priority 0) always matches.
 */
const METER_PROFILES: readonly MeterProfile[] = [
  yaesuNewcatProfile,    // priority: 10
  defaultHamlibProfile,  // priority: 0  — universal fallback
];

/**
 * Select the best matching MeterProfile for the current rig.
 * Iterates profiles in priority order; the first one whose `matches()`
 * returns true wins.  Always returns a result (defaultHamlibProfile
 * matches everything).
 */
export function resolveMeterProfile(ctx: MeterProfileMatchContext): MeterProfile {
  for (const profile of METER_PROFILES) {
    if (profile.matches(ctx)) {
      return profile;
    }
  }
  // Should never reach here — defaultHamlibProfile.matches() always returns true.
  return defaultHamlibProfile;
}
