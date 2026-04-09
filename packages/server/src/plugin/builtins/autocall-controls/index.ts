import type {
  AutoCallExecutionPlan,
  AutoCallExecutionRequest,
  PluginContext,
  PluginDefinition,
} from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };

export const BUILTIN_AUTOCALL_CONTROLS_PLUGIN_NAME = 'autocall-controls';
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

  const recommendedFrequency = ctx.band.findIdleTransmitFrequency({
    slotId: request.slotInfo.id,
    minHz: AUTOCALL_IDLE_FREQUENCY_MIN_HZ,
    maxHz: AUTOCALL_IDLE_FREQUENCY_MAX_HZ,
    guardHz: AUTOCALL_IDLE_FREQUENCY_GUARD_HZ,
  });
  if (typeof recommendedFrequency !== 'number' || !Number.isFinite(recommendedFrequency)) {
    ctx.log.debug('Autocall controls skipped idle frequency selection because no suitable frequency was found', {
      callsign: request.callsign,
      slotId: request.slotInfo.id,
    });
    return plan;
  }

  if (ctx.operator.frequency === recommendedFrequency) {
    return plan;
  }

  ctx.log.debug('Autocall controls selected idle frequency for accepted proposal', {
    callsign: request.callsign,
    slotId: request.slotInfo.id,
    sourcePluginName: request.sourcePluginName,
    frequency: recommendedFrequency,
  });

  return {
    ...plan,
    audioFrequency: recommendedFrequency,
  };
}

export const autocallControlsPlugin: PluginDefinition = {
  name: BUILTIN_AUTOCALL_CONTROLS_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'Shared controls for how automatic-call proposals are executed',

  settings: {
    autocallControlsOverview: {
      type: 'info',
      default: '',
      label: 'autocallControlsOverview',
      description: 'autocallControlsOverviewDesc',
      scope: 'operator',
    },
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

export const autocallControlsLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
