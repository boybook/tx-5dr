/**
 * FT8 message type discriminator values.
 *
 * Inlined from `@tx5dr/contracts` to keep `@tx5dr/plugin-api` free of runtime
 * dependencies. The values MUST remain identical to those in
 * `packages/contracts/src/schema/ft8.schema.ts`.
 *
 * A cross-check test in this package verifies they stay in sync.
 */
export const FT8MessageType = {
  CQ: 'cq',
  CALL: 'call',
  SIGNAL_REPORT: 'signal_report',
  ROGER_REPORT: 'roger_report',
  RRR: 'rrr',
  SEVENTY_THREE: '73',
  FOX_RR73: 'fox_rr73',
  CUSTOM: 'custom',
  UNKNOWN: 'unknown',
} as const;
