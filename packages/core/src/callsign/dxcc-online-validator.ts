import { createLogger } from '../utils/logger.js';

const logger = createLogger('DXCCOnlineValidator');

export interface HamQTHDXCCValidationResult {
  callsign: string;
  entityName?: string;
  entityCode?: number;
  continent?: string;
  cqZone?: number;
  ituZone?: number;
  details?: string;
  source: 'hamqth';
}

function extractXMLValue(xml: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i');
  const match = xml.match(pattern);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

export async function validateDXCCWithHamQTH(
  callsign: string,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<HamQTHDXCCValidationResult | null> {
  const trimmed = callsign.trim().toUpperCase();
  if (!trimmed) {
    return null;
  }

  const timeoutMs = options?.timeoutMs ?? 5000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const response = await fetch(`https://www.hamqth.com/dxcc.php?callsign=${encodeURIComponent(trimmed)}`, {
      headers: {
        'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8',
      },
      signal,
    });

    if (!response.ok) {
      logger.warn('HamQTH validation request failed', {
        callsign: trimmed,
        status: response.status,
      });
      return null;
    }

    const xml = await response.text();
    const entityName = extractXMLValue(xml, 'name');
    const entityCodeText = extractXMLValue(xml, 'adif');
    const cqZoneText = extractXMLValue(xml, 'waz');
    const ituZoneText = extractXMLValue(xml, 'itu');

    return {
      callsign: trimmed,
      entityName,
      entityCode: entityCodeText ? Number(entityCodeText) : undefined,
      continent: extractXMLValue(xml, 'continent'),
      cqZone: cqZoneText ? Number(cqZoneText) : undefined,
      ituZone: ituZoneText ? Number(ituZoneText) : undefined,
      details: extractXMLValue(xml, 'details'),
      source: 'hamqth',
    };
  } catch (error) {
    logger.warn('HamQTH validation request threw', {
      callsign: trimmed,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
