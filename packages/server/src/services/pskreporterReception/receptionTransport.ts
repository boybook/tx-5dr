/**
 * Network transport for PSK Reporter reception feedback.
 *
 * Live:    mqtt://mqtt.pskreporter.info:1883 (volunteer feed by Tom Fanning M0LTE)
 * History: https://retrieve.pskreporter.info/query (PSK Reporter by Philip Gladstone)
 */

import type { MqttClient } from 'mqtt';
import { createLogger } from '../../utils/logger.js';
import type {
  PSKReporterReceptionTransport,
  ReceptionLiveClient,
  ReceptionLiveHandlers,
} from './PSKReporterReceptionService.js';
import { decodeMqttReceptionSpot, decodeQueryReceptionSpots } from './receptionDecoders.js';

const logger = createLogger('PSKReporterReceptionTransport');

const LIVE_FEED_URL = 'mqtt://mqtt.pskreporter.info:1883';
const QUERY_URL = 'https://retrieve.pskreporter.info/query';
const MAX_QUERY_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * The MQTT library is loaded on first connection, not with the server: an
 * optional feature whose dependencies are missing from a package must fail on
 * its own (as a closed feed the service retries) instead of stopping startup.
 */
function connectLive(clientId: string, handlers: ReceptionLiveHandlers): ReceptionLiveClient {
  let client: MqttClient | null = null;
  let finished = false;
  let lastError: Error | undefined;
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    handlers.onClose(error);
  };

  import('mqtt')
    .then(({ connect }) => {
      if (finished) return;
      const created = connect(LIVE_FEED_URL, {
        clientId,
        keepalive: 60,
        clean: true,
        connectTimeout: 15_000,
        // Reconnects are scheduled by the service with backoff.
        reconnectPeriod: 0,
      });
      client = created;
      created.on('connect', () => handlers.onConnect());
      created.on('message', (topic, payload) => handlers.onMessage(topic, payload));
      created.on('error', (error) => {
        lastError = error;
      });
      created.on('close', () => finish(lastError));
    })
    .catch((error: unknown) => {
      logger.error('MQTT client library could not be loaded', {
        error: error instanceof Error ? error.message : String(error),
      });
      finish(error instanceof Error ? error : new Error(String(error)));
    });

  return {
    subscribe(topic) {
      client?.subscribe(topic, { qos: 0 }, (error) => {
        if (error) logger.warn('Live feed subscribe failed', { topic, error: error.message });
      });
    },
    unsubscribe(topic) {
      client?.unsubscribe(topic, (error) => {
        if (error) logger.debug('Live feed unsubscribe failed', { topic, error: error.message });
      });
    },
    close() {
      finished = true;
      client?.end(true);
    },
  };
}

async function fetchHistory(callsign: string, windowSeconds: number, signal: AbortSignal) {
  const url = new URL(QUERY_URL);
  url.searchParams.set('senderCallsign', callsign);
  url.searchParams.set('flowStartSeconds', String(-Math.abs(Math.round(windowSeconds))));
  url.searchParams.set('rronly', '1');
  url.searchParams.set('noactive', '1');
  const response = await fetch(url, { signal, headers: { 'User-Agent': 'TX-5DR' } });
  if (!response.ok) {
    throw new Error(`PSK Reporter query returned HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_QUERY_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`PSK Reporter query response is too large (${declaredLength} bytes)`);
  }
  return decodeQueryReceptionSpots(await readBoundedText(response, MAX_QUERY_RESPONSE_BYTES));
}

/** Reads a response body, failing once it exceeds `maxBytes` (also without a content length). */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('PSK Reporter query response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createPSKReporterReceptionTransport(): PSKReporterReceptionTransport {
  return {
    connectLive,
    fetchHistory,
    decodeLive: decodeMqttReceptionSpot,
  };
}
