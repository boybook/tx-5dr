import type { ParsedFT8Message } from '@tx5dr/contracts';
import { FT8MessageType } from '@tx5dr/contracts';
import { getCallsignInfo } from '@tx5dr/core';

const DIRECTED_CQ_CONTINENT_TOKENS = new Set([
  'AF',
  'AN',
  'AS',
  'EU',
  'NA',
  'OC',
  'SA',
]);

const UNSUPPORTED_ACTIVITY_TOKENS = new Set([
  'BOTA',
  'COTA',
  'FD',
  'IOTA',
  'LGT',
  'POTA',
  'QRP',
  'QRO',
  'SES',
  'SOTA',
  'TEST',
  'VOTA',
  'WWFF',
]);

export type AutoTargetEligibilityReason =
  | 'non_cq_message'
  | 'plain_cq'
  | 'missing_callsign_identity'
  | 'missing_target_identity'
  | 'unsupported_activity_token'
  | 'unsupported_callback_token'
  | 'continent_match'
  | 'continent_mismatch'
  | 'dx_match'
  | 'dx_same_continent'
  | 'entity_match'
  | 'entity_mismatch'
  | 'unknown_modifier';

export interface AutoTargetEligibilityDecision {
  eligible: boolean;
  reason: AutoTargetEligibilityReason;
  modifier?: string;
}

function normalizeModifier(rawModifier: unknown): string | undefined {
  if (typeof rawModifier !== 'string') {
    return undefined;
  }

  const modifier = rawModifier.trim().toUpperCase();
  return modifier.length > 0 ? modifier : undefined;
}

function getCqModifier(message: ParsedFT8Message['message']): string | undefined {
  if (!('flag' in message)) {
    return undefined;
  }
  return normalizeModifier(message.flag);
}

function hasSharedContinent(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left?.length || !right?.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.some((continent) => rightSet.has(continent));
}

function resolveIdentity(callsign: string | undefined) {
  if (!callsign) {
    return undefined;
  }
  return getCallsignInfo(callsign.trim().toUpperCase());
}

function resolveModifierEntity(modifier: string) {
  // The DXCC resolver expects something that looks like a callsign prefix.
  // Appending a suffix avoids accidentally rejecting short, valid prefixes.
  return getCallsignInfo(`${modifier}1AA`);
}

export function evaluateAutomaticTargetEligibility(
  myCallsign: string,
  parsedMessage: ParsedFT8Message,
): AutoTargetEligibilityDecision {
  if (parsedMessage.message.type !== FT8MessageType.CQ) {
    return {
      eligible: true,
      reason: 'non_cq_message',
    };
  }

  const modifier = getCqModifier(parsedMessage.message);
  if (!modifier) {
    return {
      eligible: true,
      reason: 'plain_cq',
    };
  }

  if (/^\d{3}$/.test(modifier)) {
    return {
      eligible: false,
      reason: 'unsupported_callback_token',
      modifier,
    };
  }

  if (UNSUPPORTED_ACTIVITY_TOKENS.has(modifier)) {
    return {
      eligible: false,
      reason: 'unsupported_activity_token',
      modifier,
    };
  }

  const myIdentity = resolveIdentity(myCallsign);
  if (!myIdentity) {
    return {
      eligible: false,
      reason: 'missing_callsign_identity',
      modifier,
    };
  }

  const senderCallsign = 'senderCallsign' in parsedMessage.message
    ? parsedMessage.message.senderCallsign
    : undefined;
  const targetIdentity = resolveIdentity(senderCallsign);
  if (!targetIdentity) {
    return {
      eligible: false,
      reason: 'missing_target_identity',
      modifier,
    };
  }

  if (DIRECTED_CQ_CONTINENT_TOKENS.has(modifier)) {
    const eligible = Array.isArray(myIdentity.continent) && myIdentity.continent.includes(modifier);
    return {
      eligible,
      reason: eligible ? 'continent_match' : 'continent_mismatch',
      modifier,
    };
  }

  if (modifier === 'DX') {
    const eligible = !hasSharedContinent(myIdentity.continent, targetIdentity.continent);
    return {
      eligible,
      reason: eligible ? 'dx_match' : 'dx_same_continent',
      modifier,
    };
  }

  const modifierIdentity = resolveModifierEntity(modifier);
  if (modifierIdentity?.entityCode !== undefined && myIdentity.entityCode !== undefined) {
    const eligible = modifierIdentity.entityCode === myIdentity.entityCode;
    return {
      eligible,
      reason: eligible ? 'entity_match' : 'entity_mismatch',
      modifier,
    };
  }

  return {
    eligible: false,
    reason: 'unknown_modifier',
    modifier,
  };
}
