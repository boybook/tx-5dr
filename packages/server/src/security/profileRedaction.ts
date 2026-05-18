import type { HamlibConfig, RadioProfile } from '@tx5dr/contracts';

export function redactHamlibConfigForRead(config: HamlibConfig): HamlibConfig {
  return {
    type: config.type,
  };
}

export function redactProfileForRead(profile: RadioProfile): RadioProfile {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    audioLockedToRadio: profile.audioLockedToRadio,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    radio: redactHamlibConfigForRead(profile.radio),
    audio: {},
  };
}

export function redactProfilesForRead(profiles: RadioProfile[]): RadioProfile[] {
  return profiles.map(redactProfileForRead);
}

export function canReadFullProfiles(role: string | null | undefined): boolean {
  return role === 'admin';
}
