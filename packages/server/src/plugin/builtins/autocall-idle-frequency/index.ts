import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  PluginContext,
  PluginDefinition,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const BUILTIN_AUTOCALL_IDLE_FREQUENCY_PLUGIN_NAME = 'autocall-idle-frequency';
const AUTOCALL_IDLE_FREQUENCY_MIN_HZ = 300;
const AUTOCALL_IDLE_FREQUENCY_MAX_HZ = 3000;
const AUTOCALL_IDLE_FREQUENCY_GUARD_HZ = 100;

function shouldAutoSelectIdleFrequency(ctx: PluginContext): boolean {
  return ctx.config.autoSelectIdleFrequency === true;
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

  const recommendedFrequency = ctx.band.findIdleTransmitFrequency({
    slotId: sourceSlotId,
    minHz: AUTOCALL_IDLE_FREQUENCY_MIN_HZ,
    maxHz: AUTOCALL_IDLE_FREQUENCY_MAX_HZ,
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
};
