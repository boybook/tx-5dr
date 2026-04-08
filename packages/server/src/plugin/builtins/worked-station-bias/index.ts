import type { PluginDefinition, ScoredCandidate } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

function getSenderCallsign(message: unknown): string {
  if (typeof message === 'object' && message !== null && 'senderCallsign' in message) {
    const callsign = (message as { senderCallsign?: unknown }).senderCallsign;
    return typeof callsign === 'string' ? callsign : '';
  }
  return '';
}

export const workedStationBiasPlugin: PluginDefinition = {
  name: 'worked-station-bias',
  version: '1.0.0',
  type: 'utility',
  description: 'Bias candidate scores based on whether the callsign was already worked',

  settings: {
    biasOverview: {
      type: 'info',
      default: '',
      label: 'biasOverview',
      description: 'biasOverviewDesc',
      scope: 'global',
    },
    newStationBonus: {
      type: 'number',
      default: 20,
      label: 'newStationBonus',
      description: 'newStationBonusDesc',
      scope: 'global',
      min: 0,
      max: 100,
    },
    workedStationPenalty: {
      type: 'number',
      default: 10,
      label: 'workedStationPenalty',
      description: 'workedStationPenaltyDesc',
      scope: 'global',
      min: 0,
      max: 100,
    },
  },

  hooks: {
    async onScoreCandidates(candidates, ctx) {
      const bonus = typeof ctx.config.newStationBonus === 'number'
        ? ctx.config.newStationBonus
        : 20;
      const penalty = typeof ctx.config.workedStationPenalty === 'number'
        ? ctx.config.workedStationPenalty
        : 10;

      const scored = await Promise.all(candidates.map(async (candidate) => {
        const callsign = getSenderCallsign(candidate.message);
        if (!callsign) {
          return candidate;
        }

        const hasWorked = await ctx.logbook.hasWorked(callsign);
        const scoreDelta = hasWorked ? -penalty : bonus;
        return {
          ...candidate,
          score: candidate.score + scoreDelta,
        } satisfies ScoredCandidate;
      }));

      ctx.log.debug('Worked station bias applied', {
        candidateCount: candidates.length,
        bonus,
        penalty,
      });

      return scored;
    },
  },
};

export const workedStationBiasLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
