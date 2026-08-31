import {
  ContestQsoEnvelopeSchema,
  type ContestQsoEnvelope,
} from '@tx5dr/contracts';
import type { FT8ContestDefinition } from './FT8ContestDefinition.js';
import type {
  ContestValidationIssue,
  FT8ContestQso,
} from './FT8ContestModules.js';

export type ContestQsoAnnotationValue = string | number | boolean;

export interface ContestQsoEnvelopeFacts<TExchange> {
  sent: TExchange;
  received: TExchange;
  annotations?: Readonly<Record<string, ContestQsoAnnotationValue>>;
}

export type ContestQsoEnvelopeValidation<TExchange> =
  | {
      ok: true;
      envelope: ContestQsoEnvelope;
      facts: ContestQsoEnvelopeFacts<TExchange>;
    }
  | {
      ok: false;
      code:
        | 'contest_qso_envelope_invalid'
        | 'contest_qso_envelope_identity_mismatch'
        | 'contest_qso_envelope_sent_exchange_invalid'
        | 'contest_qso_envelope_received_exchange_invalid';
      issues: readonly ContestValidationIssue[];
    };

export interface ContestQsoEnvelopeAdapter<TExchange> {
  create(facts: ContestQsoEnvelopeFacts<TExchange>): ContestQsoEnvelope;
  validate(value: unknown): ContestQsoEnvelopeValidation<TExchange>;
}

function invalidExchangeMessage(
  direction: 'sent' | 'received',
  issues: readonly ContestValidationIssue[],
): Error {
  return new Error(
    `contest_qso_envelope_${direction}_exchange_invalid:${issues.map((issue) => issue.code).join(',')}`,
  );
}

/**
 * Connects one contest definition's identity and exchange codec to the durable
 * ContestQsoEnvelope contract. Persistence remains owned by the Host QSO write.
 */
export function createContestQsoEnvelopeAdapter<
  TExchange,
  TQso extends FT8ContestQso<TExchange>,
  TSubmissionOptions = void,
>(
  contest: FT8ContestDefinition<TExchange, TQso, TSubmissionOptions>,
): ContestQsoEnvelopeAdapter<TExchange> {
  return {
    create(facts) {
      const sentIssues = contest.exchange.validate(facts.sent);
      if (sentIssues.length > 0) throw invalidExchangeMessage('sent', sentIssues);
      const receivedIssues = contest.exchange.validate(facts.received);
      if (receivedIssues.length > 0) throw invalidExchangeMessage('received', receivedIssues);
      return ContestQsoEnvelopeSchema.parse({
        schemaVersion: 1,
        contestId: contest.id,
        editionId: contest.edition.id,
        rulesetVersion: contest.rulesetVersion,
        sent: contest.exchange.encode(facts.sent),
        received: contest.exchange.encode(facts.received),
        annotations: facts.annotations,
      });
    },
    validate(value) {
      const parsed = ContestQsoEnvelopeSchema.safeParse(value);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'contest_qso_envelope_invalid',
          issues: parsed.error.issues.map((issue) => ({
            code: issue.code,
            field: issue.path.join('.') || undefined,
            message: issue.message,
          })),
        };
      }
      const envelope = parsed.data;
      if (envelope.contestId !== contest.id
        || envelope.editionId !== contest.edition.id
        || envelope.rulesetVersion !== contest.rulesetVersion) {
        return {
          ok: false,
          code: 'contest_qso_envelope_identity_mismatch',
          issues: [{ code: 'identity_mismatch' }],
        };
      }
      const sent = contest.exchange.decode(envelope.sent);
      if (!sent.ok) {
        return {
          ok: false,
          code: 'contest_qso_envelope_sent_exchange_invalid',
          issues: sent.issues,
        };
      }
      const received = contest.exchange.decode(envelope.received);
      if (!received.ok) {
        return {
          ok: false,
          code: 'contest_qso_envelope_received_exchange_invalid',
          issues: received.issues,
        };
      }
      return {
        ok: true,
        envelope,
        facts: {
          sent: sent.value,
          received: received.value,
          annotations: envelope.annotations,
        },
      };
    },
  };
}
