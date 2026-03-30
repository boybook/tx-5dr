import { z } from 'zod';
import { UserRole } from './auth.schema.js';

// ===== Actions =====

export type AppAction = 'manage' | 'read' | 'create' | 'update' | 'delete' | 'execute';

// ===== Subjects =====

/**
 * Domain subjects - entity-level access with instance conditions
 * - Operator: condition { id: string }
 * - Transmission: condition { operatorId: string }
 * - Token / AuthConfig: admin-only management
 */
export type DomainSubject =
  | 'Operator'
  | 'Transmission'
  | 'Token'
  | 'AuthConfig';

/**
 * Capability subjects - delegatable atomic permissions
 * Each Permission enum value maps to exactly one CapabilitySubject
 */
export type CapabilitySubject =
  | 'RadioFrequency'
  | 'RadioTuner'
  | 'RadioTune'
  | 'RadioConfig'
  | 'RadioReconnect'
  | 'RadioControl'
  | 'Engine'
  | 'ModeSwitch'
  | 'SettingsDecodeWindows'
  | 'SettingsFrequencyPresets'
  | 'StationInfo';

export type AppSubject = DomainSubject | CapabilitySubject | 'all';

/** CASL generic type parameter: [Action, Subject] */
export type AppAbilities = [AppAction, AppSubject];

// ===== Permission enum (storage & UI identifier) =====

export enum Permission {
  RADIO_SET_FREQUENCY = 'radio:set_frequency',
  RADIO_SET_TUNER = 'radio:set_tuner',
  RADIO_TUNE = 'radio:tune',
  RADIO_CONFIG = 'radio:config',
  RADIO_RECONNECT = 'radio:reconnect',
  /** 统一电台控制能力写命令（AF增益、静噪、发射功率等）*/
  RADIO_CONTROL = 'radio:control',
  ENGINE_START_STOP = 'engine:start_stop',
  MODE_SWITCH = 'mode:switch',
  SETTINGS_DECODE_WINDOWS = 'settings:decode_windows',
  SETTINGS_FREQUENCY_PRESETS = 'settings:frequency_presets',
  STATION_UPDATE = 'station:update',
}

export const PermissionSchema = z.nativeEnum(Permission);

// ===== Permission → CASL rule mapping =====

export const PERMISSION_RULE_MAP: Record<Permission, { action: AppAction; subject: CapabilitySubject }> = {
  [Permission.RADIO_SET_FREQUENCY]: { action: 'execute', subject: 'RadioFrequency' },
  [Permission.RADIO_SET_TUNER]: { action: 'execute', subject: 'RadioTuner' },
  [Permission.RADIO_TUNE]: { action: 'execute', subject: 'RadioTune' },
  [Permission.RADIO_CONFIG]: { action: 'update', subject: 'RadioConfig' },
  [Permission.RADIO_RECONNECT]: { action: 'execute', subject: 'RadioReconnect' },
  [Permission.RADIO_CONTROL]: { action: 'execute', subject: 'RadioControl' },
  [Permission.ENGINE_START_STOP]: { action: 'execute', subject: 'Engine' },
  [Permission.MODE_SWITCH]: { action: 'execute', subject: 'ModeSwitch' },
  [Permission.SETTINGS_DECODE_WINDOWS]: { action: 'update', subject: 'SettingsDecodeWindows' },
  [Permission.SETTINGS_FREQUENCY_PRESETS]: { action: 'update', subject: 'SettingsFrequencyPresets' },
  [Permission.STATION_UPDATE]: { action: 'update', subject: 'StationInfo' },
};

// ===== PermissionGrant (stored on token) =====

export const PermissionGrantSchema = z.object({
  permission: PermissionSchema,
  /** MongoDB-style conditions for CASL, e.g. { frequency: { $in: [14074000] } } */
  conditions: z.record(z.unknown()).optional(),
});

export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

// ===== Raw rule type (pure data, no CASL dependency) =====

export interface RawRule {
  action: AppAction | AppAction[];
  subject: AppSubject | AppSubject[];
  conditions?: Record<string, unknown>;
  inverted?: boolean;
}

// ===== Ability rules builder =====

/**
 * Build CASL-compatible rules from role + operatorIds + permission grants.
 * Three layers stacked:
 *   Layer 1: Role-based defaults
 *   Layer 2: Operator data scope (operatorIds → conditions)
 *   Layer 3: Custom permission grants
 *
 * Returns pure JSON — server/web each call createMongoAbility() with these rules.
 */
export function buildAbilityRules(params: {
  role: UserRole;
  operatorIds?: string[];
  permissionGrants?: PermissionGrant[];
}): RawRule[] {
  const { role, operatorIds = [], permissionGrants = [] } = params;

  // ADMIN: full access
  if (role === UserRole.ADMIN) {
    return [{ action: 'manage', subject: 'all' }];
  }

  const rules: RawRule[] = [];

  // Layer 1: role defaults
  rules.push({ action: 'read', subject: 'all' });

  if (role === UserRole.OPERATOR) {
    // Operators can manage their own operators and transmissions
    if (operatorIds.length > 0) {
      rules.push(
        { action: 'manage', subject: 'Operator', conditions: { id: { $in: operatorIds } } },
        { action: 'manage', subject: 'Transmission', conditions: { operatorId: { $in: operatorIds } } },
      );
    }
    // Operators can create new operators (maxOperators checked separately)
    rules.push({ action: 'create', subject: 'Operator' });
  }

  // Layer 2: custom permission grants
  for (const grant of permissionGrants) {
    const mapping = PERMISSION_RULE_MAP[grant.permission];
    if (mapping) {
      rules.push({
        action: mapping.action,
        subject: mapping.subject,
        ...(grant.conditions ? { conditions: grant.conditions } : {}),
      });
    }
  }

  return rules;
}

// ===== Permission groups (for UI) =====

export interface PermissionGroupDef {
  key: string;
  permissions: Permission[];
}

export const PERMISSION_GROUPS: PermissionGroupDef[] = [
  {
    key: 'radio',
    permissions: [
      Permission.RADIO_SET_FREQUENCY,
      Permission.RADIO_SET_TUNER,
      Permission.RADIO_TUNE,
      Permission.RADIO_CONFIG,
      Permission.RADIO_RECONNECT,
      Permission.RADIO_CONTROL,
    ],
  },
  { key: 'engine', permissions: [Permission.ENGINE_START_STOP] },
  { key: 'mode', permissions: [Permission.MODE_SWITCH] },
  {
    key: 'settings',
    permissions: [
      Permission.SETTINGS_DECODE_WINDOWS,
      Permission.SETTINGS_FREQUENCY_PRESETS,
    ],
  },
  { key: 'station', permissions: [Permission.STATION_UPDATE] },
];

/** Permissions that support condition constraints (UI shows condition editor) */
export const CONDITIONAL_PERMISSIONS: Partial<Record<Permission, {
  conditionField: string;
  conditionOperator: '$in';
  labelKey: string;
}>> = {
  [Permission.RADIO_SET_FREQUENCY]: {
    conditionField: 'frequency',
    conditionOperator: '$in',
    labelKey: 'auth:permissions.frequencyRestriction',
  },
};
