import { createMongoAbility, type MongoAbility, ForbiddenError, subject as caslSubject } from '@casl/ability';
import {
  buildAbilityRules,
  type PermissionGrant,
  UserRole,
} from '@tx5dr/contracts';

// Use [string, string] to avoid strict type constraints between RawRule and CASL's internal types
export type AppAbility = MongoAbility<[string, string]>;

/**
 * Build a CASL Ability instance from role, operatorIds, and permission grants.
 * - ADMIN → manage all
 * - OPERATOR → manage own operators + custom permission grants
 * - VIEWER → read all
 */
export function buildAbility(params: {
  role: UserRole;
  operatorIds?: string[];
  permissionGrants?: PermissionGrant[];
}): AppAbility {
  const rules = buildAbilityRules(params);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createMongoAbility(rules as any);
}

/** Empty ability (no permissions at all) */
export function emptyAbility(): AppAbility {
  return createMongoAbility([]);
}

/**
 * Helper to check ability with instance data (conditions).
 * CASL requires using subject() helper for plain objects.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canWithData(ability: AppAbility, action: string, subjectType: string, data: Record<string, unknown>): boolean {
  return ability.can(action, caslSubject(subjectType, data as Record<PropertyKey, unknown>) as any);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cannotWithData(ability: AppAbility, action: string, subjectType: string, data: Record<string, unknown>): boolean {
  return ability.cannot(action, caslSubject(subjectType, data as Record<PropertyKey, unknown>) as any);
}

export { ForbiddenError };
