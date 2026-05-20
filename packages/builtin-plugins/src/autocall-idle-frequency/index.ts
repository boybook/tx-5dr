import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  PluginContext,
  PluginDefinition,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };

export const BUILTIN_AUTOCALL_IDLE_FREQUENCY_PLUGIN_NAME = 'autocall-idle-frequency';
const AUTOCALL_IDLE_FREQUENCY_MIN_HZ = 300;
const AUTOCALL_IDLE_FREQUENCY_MAX_HZ = 2800;
const AUTOCALL_IDLE_FREQUENCY_LIMIT_HZ = 3000;
const AUTOCALL_IDLE_FREQUENCY_GUARD_HZ = 100;

function shouldAutoSelectIdleFrequency(ctx: PluginContext): boolean {
  return ctx.config.autoSelectIdleFrequency === true;
}

function normalizeIdleFrequencyValue(value: unknown, fallback: number): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.max(0, Math.min(AUTOCALL_IDLE_FREQUENCY_LIMIT_HZ, Math.round(numericValue)));
}

function resolveIdleFrequencyRange(ctx: PluginContext): { minHz: number; maxHz: number } {
  const minHz = normalizeIdleFrequencyValue(ctx.config.idleFrequencyMinHz, AUTOCALL_IDLE_FREQUENCY_MIN_HZ);
  const maxHz = normalizeIdleFrequencyValue(ctx.config.idleFrequencyMaxHz, AUTOCALL_IDLE_FREQUENCY_MAX_HZ);

  if (minHz < maxHz) {
    return { minHz, maxHz };
  }

  ctx.log.warn('Autocall idle frequency range is invalid; falling back to default range', {
    minHz,
    maxHz,
    defaultMinHz: AUTOCALL_IDLE_FREQUENCY_MIN_HZ,
    defaultMaxHz: AUTOCALL_IDLE_FREQUENCY_MAX_HZ,
  });
  return {
    minHz: AUTOCALL_IDLE_FREQUENCY_MIN_HZ,
    maxHz: AUTOCALL_IDLE_FREQUENCY_MAX_HZ,
  };
}

function configureIdleFrequency(
  request: AutoCallExecutionRequest,
  plan: AutoCallExecutionPlan,
  ctx: PluginContext,
): AutoCallExecutionPlan {
  if (!shouldAutoSelectIdleFrequency(ctx)) {
    return plan;
  }

  const sourceSlotId = request.sourceSlotInfo?.id;
  if (!sourceSlotId) {
    ctx.log.debug('Autocall idle frequency skipped because the accepted proposal has no source slot', {
      callsign: request.callsign,
      sourcePluginName: request.sourcePluginName,
    });
    return plan;
  }

  const { minHz, maxHz } = resolveIdleFrequencyRange(ctx);
  const recommendedFrequency = ctx.band.findIdleTransmitFrequency({
    slotId: sourceSlotId,
    minHz,
    maxHz,
    guardHz: AUTOCALL_IDLE_FREQUENCY_GUARD_HZ,
  });
  if (typeof recommendedFrequency !== 'number' || !Number.isFinite(recommendedFrequency)) {
    ctx.log.debug('Autocall idle frequency skipped because no suitable frequency was found', {
      callsign: request.callsign,
      sourceSlotId,
    });
    return plan;
  }

  if (ctx.operator.frequency === recommendedFrequency) {
    return plan;
  }

  ctx.log.debug('Autocall idle frequency selected transmit frequency for accepted proposal', {
    callsign: request.callsign,
    sourceSlotId,
    sourcePluginName: request.sourcePluginName,
    frequency: recommendedFrequency,
  });

  return {
    ...plan,
    audioFrequency: recommendedFrequency,
  };
}

export const autocallIdleFrequencyPlugin: PluginDefinition = {
  name: BUILTIN_AUTOCALL_IDLE_FREQUENCY_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'Automatically pick a quieter transmit audio frequency before an accepted autocall starts',

  settings: {
    autoSelectIdleFrequency: {
      type: 'boolean',
      default: false,
      label: 'autoSelectIdleFrequency',
      description: 'autoSelectIdleFrequencyDesc',
      scope: 'operator',
    },
    idleFrequencyMinHz: {
      type: 'number',
      default: AUTOCALL_IDLE_FREQUENCY_MIN_HZ,
      label: 'idleFrequencyMinHz',
      description: 'idleFrequencyMinHzDesc',
      scope: 'operator',
      min: 0,
      max: AUTOCALL_IDLE_FREQUENCY_LIMIT_HZ,
    },
    idleFrequencyMaxHz: {
      type: 'number',
      default: AUTOCALL_IDLE_FREQUENCY_MAX_HZ,
      label: 'idleFrequencyMaxHz',
      description: 'idleFrequencyMaxHzDesc',
      scope: 'operator',
      min: 0,
      max: AUTOCALL_IDLE_FREQUENCY_LIMIT_HZ,
    },
  },

  quickSettings: [
    { settingKey: 'autoSelectIdleFrequency' },
  ],

  hooks: {
    onConfigureAutoCallExecution(request, plan, ctx) {
      return configureIdleFrequency(request, plan, ctx);
    },
  },
};

export const autocallIdleFrequencyLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};
