import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import type { PluginContext, PluginDefinition, QSORecord } from '@tx5dr/plugin-api';
import zhLocale from './locales/zh.json' with { type: 'json' };
import enLocale from './locales/en.json' with { type: 'json' };
import { buildAdifFile, buildLoggedAdifDatagram, buildRawAdifRecord } from './encoder.js';

export const BUILTIN_QSO_UDP_BROADCAST_PLUGIN_NAME = 'qso-udp-broadcast';

interface UdpTarget {
  host: string;
  port: number;
}

interface PluginSettings {
  enableType12: boolean;
  type12Host: string;
  type12Port: number;
  enableRawAdif: boolean;
  rawAdifHost: string;
  rawAdifPort: number;
  udpClientId: string;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function readPort(value: unknown, fallback: number): number {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function readSettings(ctx: PluginContext): PluginSettings {
  return {
    enableType12: readBoolean(ctx.config.enableType12, true),
    type12Host: readString(ctx.config.type12Host, '127.0.0.1'),
    type12Port: readPort(ctx.config.type12Port, 2237),
    enableRawAdif: readBoolean(ctx.config.enableRawAdif, true),
    rawAdifHost: readString(ctx.config.rawAdifHost, '127.0.0.1'),
    rawAdifPort: readPort(ctx.config.rawAdifPort, 2333),
    udpClientId: readString(ctx.config.udpClientId, 'TX-5DR'),
  };
}

function validateTarget(target: UdpTarget): string | null {
  if (!target.host || /[\u0000-\u001f\u007f\s]/.test(target.host)) {
    return 'host must be non-empty and must not contain whitespace or control characters';
  }
  if (target.host.length > 255) {
    return 'host must be 255 characters or shorter';
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    return 'port must be an integer from 1 to 65535';
  }
  return null;
}

async function sendUdpDatagram(target: UdpTarget, payload: Buffer | string): Promise<void> {
  const family = isIP(target.host) === 6 ? 'udp6' : 'udp4';
  const socket = createSocket(family);
  const message = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;

  try {
    await new Promise<void>((resolve, reject) => {
      socket.send(message, target.port, target.host, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    socket.close();
  }
}

async function sendIfEnabled(
  ctx: PluginContext,
  label: string,
  enabled: boolean,
  target: UdpTarget,
  payload: Buffer | string,
): Promise<boolean> {
  if (!enabled) return false;

  const invalidReason = validateTarget(target);
  if (invalidReason) {
    ctx.log.warn(`${label} UDP target skipped: ${invalidReason}`, { ...target });
    return false;
  }

  try {
    await sendUdpDatagram(target, payload);
    return true;
  } catch (error) {
    ctx.log.error(`${label} UDP send failed`, {
      target,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function broadcastQSO(record: QSORecord, ctx: PluginContext): Promise<void> {
  const settings = readSettings(ctx);
  const adifFile = buildAdifFile(record);
  const rawAdif = buildRawAdifRecord(record);
  const type12Datagram = buildLoggedAdifDatagram(settings.udpClientId, adifFile);

  const [type12Sent, rawSent] = await Promise.all([
    sendIfEnabled(
      ctx,
      'LoggedADIF Type12',
      settings.enableType12,
      { host: settings.type12Host, port: settings.type12Port },
      type12Datagram,
    ),
    sendIfEnabled(
      ctx,
      'Raw ADIF',
      settings.enableRawAdif,
      { host: settings.rawAdifHost, port: settings.rawAdifPort },
      rawAdif,
    ),
  ]);

  ctx.log.info('QSO UDP broadcast processed', {
    callsign: record.callsign,
    type12Sent,
    rawSent,
  });
}

export const qsoUdpBroadcastPlugin: PluginDefinition = {
  name: BUILTIN_QSO_UDP_BROADCAST_PLUGIN_NAME,
  version: '1.0.0',
  type: 'utility',
  description: 'pluginDescription',
  permissions: ['network'],

  settings: {
    enableType12: {
      type: 'boolean',
      default: true,
      label: 'enableType12',
      description: 'enableType12Desc',
      scope: 'operator',
    },
    type12Host: {
      type: 'string',
      default: '127.0.0.1',
      label: 'type12Host',
      description: 'type12HostDesc',
      scope: 'operator',
    },
    type12Port: {
      type: 'number',
      default: 2237,
      label: 'type12Port',
      description: 'type12PortDesc',
      scope: 'operator',
      min: 1,
      max: 65535,
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
    udpClientId: {
      type: 'string',
      default: 'TX-5DR',
      label: 'udpClientId',
      description: 'udpClientIdDesc',
      scope: 'operator',
    },
  },

  hooks: {
    onQSOComplete(record, ctx) {
      void broadcastQSO(record, ctx).catch((error) => {
        ctx.log.error('QSO UDP broadcast failed', error);
      });
    },
  },
};

export const qsoUdpBroadcastLocales: Record<string, Record<string, string>> = {
  zh: zhLocale,
  en: enLocale,
};
