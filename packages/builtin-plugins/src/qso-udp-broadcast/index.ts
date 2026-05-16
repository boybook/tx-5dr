import type { PluginContext, PluginDefinition } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import jaLocale from './locales/ja.json' with { type: 'json' };
import { WsjtUdpSession, type UdpTarget, type WsjtUdpSettings } from './wsjtx-session.js';

export const BUILTIN_QSO_UDP_BROADCAST_PLUGIN_NAME = 'qso-udp-broadcast';

const DEFAULT_TARGETS: UdpTarget[] = [{ host: '127.0.0.1', port: 2237 }];
const sessions = new WeakMap<PluginContext, WsjtUdpSession>();

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readOptionalPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}

function readPort(value: unknown, fallback: number): number {
  return readOptionalPort(value) ?? fallback;
}

function readNumber(value: unknown, fallback: number): number {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function readTargets(config: Readonly<Record<string, unknown>>): UdpTarget[] {
  const configured = config.targets;
  if (Array.isArray(configured)) {
    const targets = configured
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const candidate = item as Record<string, unknown>;
        const host = readString(candidate.host, '');
        const port = readPort(candidate.port, 0);
        return host && port ? { host, port } : null;
      })
      .filter((target): target is UdpTarget => Boolean(target));
    if (targets.length > 0) return targets;
  }

  // Legacy settings migration path: old type12Host/type12Port remain accepted.
  return [{
    host: readString(config.type12Host, DEFAULT_TARGETS[0].host),
    port: readPort(config.type12Port, DEFAULT_TARGETS[0].port),
  }];
}

function readSettings(ctx: PluginContext): WsjtUdpSettings {
  const config = ctx.config;
  return {
    targets: readTargets(config),
    localPort: readOptionalPort(config.localPort),
    clientId: readString(config.clientId ?? config.udpClientId, 'TX-5DR'),
    enableType5QsoLogged: readBoolean(config.enableType5QsoLogged, true),
    enableType12LoggedAdif: readBoolean(config.enableType12LoggedAdif ?? config.enableType12, true),
    enableRawAdif: readBoolean(config.enableRawAdif, true),
    rawAdifHost: readString(config.rawAdifHost, '127.0.0.1'),
    rawAdifPort: readPort(config.rawAdifPort, 2333),
    lowConfidenceThreshold: readNumber(config.lowConfidenceThreshold, 0.8),
    maxHighlightRules: Math.max(1, Math.trunc(readNumber(config.maxHighlightRules, 100))),
    allowReplyRequests: readBoolean(config.allowReplyRequests, false),
    allowHaltTxRequests: readBoolean(config.allowHaltTxRequests, false),
    allowFreeTextRequests: readBoolean(config.allowFreeTextRequests, false),
    allowLocationRequests: readBoolean(config.allowLocationRequests, false),
    allowConfigureRequests: readBoolean(config.allowConfigureRequests, false),
    allowCloseRequests: readBoolean(config.allowCloseRequests, false),
    allowSwitchConfigurationRequests: readBoolean(config.allowSwitchConfigurationRequests, false),
  };
}

async function getOrStartSession(ctx: PluginContext): Promise<WsjtUdpSession> {
  const existing = sessions.get(ctx);
  if (existing) return existing;
  const session = new WsjtUdpSession(ctx, readSettings(ctx));
  sessions.set(ctx, session);
  await session.start();
  return session;
}

export const qsoUdpBroadcastPlugin: PluginDefinition = {
  name: BUILTIN_QSO_UDP_BROADCAST_PLUGIN_NAME,
  version: '2.0.0',
  type: 'utility',
  description: 'pluginDescription',
  permissions: ['network'],

  settings: {
    targets: {
      type: 'object[]',
      default: DEFAULT_TARGETS,
      label: 'targets',
      description: 'targetsDesc',
      scope: 'operator',
      itemFields: [
        { key: 'host', type: 'string', label: 'targetHost', required: true },
        { key: 'port', type: 'number', label: 'targetPort', required: true },
      ],
    },
    localPort: {
      type: 'number',
      default: 0,
      label: 'localPort',
      description: 'localPortDesc',
      scope: 'operator',
      min: 0,
      max: 65535,
    },
    clientId: {
      type: 'string',
      default: 'TX-5DR',
      label: 'clientId',
      description: 'clientIdDesc',
      scope: 'operator',
    },
    enableType5QsoLogged: {
      type: 'boolean',
      default: true,
      label: 'enableType5QsoLogged',
      description: 'enableType5QsoLoggedDesc',
      scope: 'operator',
    },
    enableType12LoggedAdif: {
      type: 'boolean',
      default: true,
      label: 'enableType12LoggedAdif',
      description: 'enableType12LoggedAdifDesc',
      scope: 'operator',
    },
    enableRawAdif: {
      type: 'boolean',
      default: true,
      label: 'enableRawAdif',
      description: 'enableRawAdifDesc',
      scope: 'operator',
    },
    rawAdifHost: {
      type: 'string',
      default: '127.0.0.1',
      label: 'rawAdifHost',
      description: 'rawAdifHostDesc',
      scope: 'operator',
    },
    rawAdifPort: {
      type: 'number',
      default: 2333,
      label: 'rawAdifPort',
      description: 'rawAdifPortDesc',
      scope: 'operator',
      min: 1,
      max: 65535,
    },
    allowReplyRequests: {
      type: 'boolean',
      default: false,
      label: 'allowReplyRequests',
      description: 'allowReplyRequestsDesc',
      scope: 'operator',
    },
    allowHaltTxRequests: {
      type: 'boolean',
      default: false,
      label: 'allowHaltTxRequests',
      description: 'allowHaltTxRequestsDesc',
      scope: 'operator',
    },
    allowFreeTextRequests: {
      type: 'boolean',
      default: false,
      label: 'allowFreeTextRequests',
      description: 'allowFreeTextRequestsDesc',
      scope: 'operator',
    },
    allowLocationRequests: {
      type: 'boolean',
      default: false,
      label: 'allowLocationRequests',
      description: 'allowLocationRequestsDesc',
      scope: 'operator',
    },
    allowConfigureRequests: {
      type: 'boolean',
      default: false,
      label: 'allowConfigureRequests',
      description: 'allowConfigureRequestsDesc',
      scope: 'operator',
    },
    allowCloseRequests: {
      type: 'boolean',
      default: false,
      label: 'allowCloseRequests',
      description: 'allowCloseRequestsDesc',
      scope: 'operator',
    },
    allowSwitchConfigurationRequests: {
      type: 'boolean',
      default: false,
      label: 'allowSwitchConfigurationRequests',
      description: 'allowSwitchConfigurationRequestsDesc',
      scope: 'operator',
    },
    lowConfidenceThreshold: {
      type: 'number',
      default: 0.8,
      label: 'lowConfidenceThreshold',
      description: 'lowConfidenceThresholdDesc',
      scope: 'operator',
      min: 0,
      max: 1,
    },
    maxHighlightRules: {
      type: 'number',
      default: 100,
      label: 'maxHighlightRules',
      description: 'maxHighlightRulesDesc',
      scope: 'operator',
      min: 1,
      max: 1000,
    },
  },

  async onLoad(ctx) {
    await getOrStartSession(ctx);
  },

  async onUnload(ctx) {
    const session = sessions.get(ctx);
    sessions.delete(ctx);
    await session?.stop();
  },

  hooks: {
    onConfigChange(_changes, ctx) {
      sessions.get(ctx)?.updateSettings(readSettings(ctx));
    },
    onTimer(timerId, ctx) {
      void sessions.get(ctx)?.onTimer(timerId);
    },
    onSlotActivity(event, ctx) {
      void getOrStartSession(ctx)
        .then((session) => session.onSlotActivity(event))
        .catch((error) => ctx.log.error('WSJT-X UDP decode broadcast failed', error));
    },
    onFrequencyChange(state, ctx) {
      void getOrStartSession(ctx)
        .then((session) => session.onFrequencyChange(state))
        .catch((error) => ctx.log.error('WSJT-X UDP frequency status broadcast failed', error));
    },
    onQSOComplete(record, ctx) {
      void getOrStartSession(ctx)
        .then((session) => session.onQSOComplete(record))
        .catch((error) => ctx.log.error('WSJT-X UDP QSO broadcast failed', error));
    },
  },
};

export const qsoUdpBroadcastLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
  ja: jaLocale,
};
