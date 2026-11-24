/**
 * Decoders for the two PSK Reporter reception sources:
 * - the live MQTT feed run by M0LTE (mqtt.pskreporter.info), one JSON spot per message;
 * - the official retrieval query (retrieve.pskreporter.info/query), an XML document.
 *
 * Both are untrusted external input. Records that do not decode are dropped.
 */

import { z } from 'zod';
import type { PSKReporterReceptionSpot } from '@tx5dr/contracts';

const LOCATOR_PATTERN = /^[A-R]{2}[0-9]{2}(?:[A-X]{2}(?:[0-9]{2})?)?$/i;
/** Callsigns and receiver names such as `SDR/JN69BA`; nothing markup-like. */
const STATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,31}$/;
const MAX_XML_LENGTH = 8 * 1024 * 1024;

export function normalizeReceptionCallsign(callsign: string): string {
  return callsign.trim().toUpperCase();
}

/** A `/` in a callsign is written as `.` in MQTT topics. */
export function buildReceptionTopic(callsign: string): string {
  return `pskr/filter/v2/+/+/${normalizeReceptionCallsign(callsign).replace(/\//g, '.')}/#`;
}

export function buildReceptionSpotId(sender: string, receiver: string, reportedAtSeconds: number): string {
  return `${sender}|${receiver}|${Math.trunc(reportedAtSeconds)}`;
}

const MqttSpotPayloadSchema = z.object({
  f: z.number().finite().optional(),
  md: z.string(),
  rp: z.number().finite().optional(),
  t: z.number().finite().positive(),
  t_tx: z.number().finite().positive().optional(),
  sc: z.string().regex(STATION_NAME_PATTERN),
  rc: z.string().regex(STATION_NAME_PATTERN),
  rl: z.string().regex(LOCATOR_PATTERN),
});

/** Decode one MQTT message payload (`pskr/filter/v2/...`). */
export function decodeMqttReceptionSpot(payload: Buffer | string): PSKReporterReceptionSpot | null {
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
  } catch {
    return null;
  }
  const parsed = MqttSpotPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const spot = parsed.data;
  const sender = normalizeReceptionCallsign(spot.sc);
  const receiver = normalizeReceptionCallsign(spot.rc);
  return {
    id: buildReceptionSpotId(sender, receiver, spot.t),
    senderCallsign: sender,
    receiverCallsign: receiver,
    receiverLocator: spot.rl,
    frequency: spot.f,
    mode: spot.md,
    snr: spot.rp,
    transmittedAt: Math.trunc((spot.t_tx ?? spot.t) * 1000),
    reportedAt: Math.trunc(spot.t * 1000),
    source: 'live',
  };
}

const XML_ENTITY_PATTERN = /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi;

function decodeXmlEntities(value: string): string {
  return value.replace(XML_ENTITY_PATTERN, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return '\'';
    const codePoint = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

function parseXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlEntities(match[2]);
  }
  return attributes;
}

const QueryReportSchema = z.object({
  senderCallsign: z.string().regex(STATION_NAME_PATTERN),
  receiverCallsign: z.string().regex(STATION_NAME_PATTERN),
  receiverLocator: z.string().regex(LOCATOR_PATTERN),
  flowStartSeconds: z.coerce.number().finite().positive(),
  frequency: z.coerce.number().finite().optional(),
  mode: z.string().default(''),
  sNR: z.coerce.number().finite().optional(),
});

/**
 * Decode `receptionReport` records from a retrieval query response.
 * The document is flat and machine-generated, so a bounded attribute scan is
 * enough; active-receiver and statistics elements are ignored.
 */
export function decodeQueryReceptionSpots(xml: string): PSKReporterReceptionSpot[] {
  if (xml.length > MAX_XML_LENGTH) {
    throw new Error('PSK Reporter query response is too large');
  }
  const spots: PSKReporterReceptionSpot[] = [];
  for (const match of xml.matchAll(/<receptionReport\s([^>]*?)\/?>/g)) {
    const parsed = QueryReportSchema.safeParse(parseXmlAttributes(match[1]));
    if (!parsed.success) {
      continue;
    }
    const report = parsed.data;
    const sender = normalizeReceptionCallsign(report.senderCallsign);
    const receiver = normalizeReceptionCallsign(report.receiverCallsign);
    const reportedAt = Math.trunc(report.flowStartSeconds * 1000);
    spots.push({
      id: buildReceptionSpotId(sender, receiver, report.flowStartSeconds),
      senderCallsign: sender,
      receiverCallsign: receiver,
      receiverLocator: report.receiverLocator,
      frequency: report.frequency,
      mode: report.mode,
      snr: report.sNR,
      transmittedAt: reportedAt,
      reportedAt,
      source: 'history',
    });
  }
  return spots;
}
