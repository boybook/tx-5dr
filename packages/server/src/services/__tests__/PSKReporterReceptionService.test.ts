import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PSKReporterReceptionSpot } from '@tx5dr/contracts';

import {
  PSKReporterReceptionService,
  RECEPTION_APPEND_FLUSH_MS,
  RECEPTION_HISTORY_MIN_INTERVAL_MS,
  RECEPTION_IDLE_DISCONNECT_MS,
  RECEPTION_RECONNECT_BASE_MS,
  RECEPTION_WINDOW_MS,
  type PSKReporterReceptionTransport,
  type ReceptionLiveHandlers,
} from '../pskreporterReception/PSKReporterReceptionService.js';
import {
  buildReceptionTopic,
  decodeMqttReceptionSpot,
  decodeQueryReceptionSpots,
} from '../pskreporterReception/receptionDecoders.js';

const NOW = Date.UTC(2026, 10, 24, 8, 30, 0);

function liveSpot(overrides: Partial<{ sc: string; rc: string; t: number; t_tx: number }> = {}) {
  return Buffer.from(JSON.stringify({
    sq: 1,
    f: 21075985,
    md: 'FT8',
    rp: -12,
    t: NOW / 1000 - 60,
    t_tx: NOW / 1000 - 75,
    sc: 'BG5DRB',
    sl: 'PL09rw',
    rc: 'OH2JJA',
    rl: 'KP20PH',
    sa: 318,
    ra: 224,
    b: '15m',
    ...overrides,
  }));
}

function historySpot(receiver: string, secondsAgo: number, sender = 'BG5DRB'): PSKReporterReceptionSpot {
  const reportedAt = NOW - secondsAgo * 1000;
  return {
    id: `${sender}|${receiver}|${Math.trunc(reportedAt / 1000)}`,
    senderCallsign: sender,
    receiverCallsign: receiver,
    receiverLocator: 'QF57UB',
    mode: 'FT8',
    transmittedAt: reportedAt,
    reportedAt,
    source: 'history',
  };
}

function createHarness(options: { enabled?: boolean; history?: PSKReporterReceptionSpot[] } = {}) {
  let enabled = options.enabled ?? true;
  const clients: Array<{
    clientId: string;
    handlers: ReceptionLiveHandlers;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const fetchHistory = vi.fn(async () => options.history ?? []);
  const transport: PSKReporterReceptionTransport = {
    connectLive(clientId, handlers) {
      const client = { clientId, handlers, subscribe: vi.fn(), unsubscribe: vi.fn(), close: vi.fn() };
      clients.push(client);
      return client;
    },
    fetchHistory,
    decodeLive: decodeMqttReceptionSpot,
  };
  const service = new PSKReporterReceptionService({
    transport,
    isEnabled: () => enabled,
    now: () => Date.now(),
    randomSuffix: () => 'abcd1234',
  });
  const spots: PSKReporterReceptionSpot[][] = [];
  const states: string[] = [];
  service.on('spots', batch => spots.push(batch));
  service.on('stateChanged', state => states.push(state));
  return {
    service,
    clients,
    fetchHistory,
    spots,
    states,
    setEnabled(value: boolean) {
      enabled = value;
    },
  };
}

describe('PSK Reporter reception decoders', () => {
  it('decodes a live MQTT spot and anchors it to the transmission start', () => {
    expect(decodeMqttReceptionSpot(liveSpot({ sc: 'bg5drb' }))).toEqual({
      id: `BG5DRB|OH2JJA|${NOW / 1000 - 60}`,
      senderCallsign: 'BG5DRB',
      receiverCallsign: 'OH2JJA',
      receiverLocator: 'KP20PH',
      frequency: 21075985,
      mode: 'FT8',
      snr: -12,
      transmittedAt: NOW - 75_000,
      reportedAt: NOW - 60_000,
      source: 'live',
    });
  });

  it('drops malformed live payloads', () => {
    expect(decodeMqttReceptionSpot('not json')).toBeNull();
    expect(decodeMqttReceptionSpot(JSON.stringify({ sc: 'BG5DRB', rc: 'X', rl: 'UNKNOWN', t: 1, md: 'FT8' }))).toBeNull();
  });

  it('decodes query reception reports and ignores other elements', () => {
    const xml = `<?xml version="1.0"?>
<receptionReports currentSeconds="1795508448.9">
  <activeReceiver callsign="F4ITK" locator="JN23WC" frequency="7075018" />
  <receptionReport receiverCallsign="VK2JEH" receiverLocator="QF57UB" senderCallsign="BG5DRB" senderLocator="PL09rw" frequency="21075970" flowStartSeconds="1795507992" mode="FT8" isSender="1" receiverRegion="New South Wales" sNR="-15" />
  <receptionReport receiverCallsign="TUHURAOTAGO" receiverLocator="RE54gc" senderCallsign="BG5DRB" flowStartSeconds="1795507860" mode="FT8" receiverDXCC="C&#244;te &amp; Co" />
  <receptionReport receiverCallsign="NOGRID" senderCallsign="BG5DRB" flowStartSeconds="1795507860" mode="FT8" />
  <lastSequenceNumber value="75200251737"/>
</receptionReports>`;
    expect(decodeQueryReceptionSpots(xml)).toEqual([
      {
        id: 'BG5DRB|VK2JEH|1795507992',
        senderCallsign: 'BG5DRB',
        receiverCallsign: 'VK2JEH',
        receiverLocator: 'QF57UB',
        frequency: 21075970,
        mode: 'FT8',
        snr: -15,
        transmittedAt: 1795507992000,
        reportedAt: 1795507992000,
        source: 'history',
      },
      {
        id: 'BG5DRB|TUHURAOTAGO|1795507860',
        senderCallsign: 'BG5DRB',
        receiverCallsign: 'TUHURAOTAGO',
        receiverLocator: 'RE54gc',
        frequency: undefined,
        mode: 'FT8',
        snr: undefined,
        transmittedAt: 1795507860000,
        reportedAt: 1795507860000,
        source: 'history',
      },
    ]);
  });

  it('writes portable callsigns with dots in MQTT topics', () => {
    expect(buildReceptionTopic('f/m0lte/p')).toBe('pskr/filter/v2/+/+/F.M0LTE.P/#');
  });
});

describe('PSKReporterReceptionService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests nothing while disabled or while no page follows a callsign', () => {
    const disabled = createHarness({ enabled: false });
    const follow = disabled.service.follow(['BG5DRB']);
    expect(disabled.clients).toHaveLength(0);
    expect(disabled.fetchHistory).not.toHaveBeenCalled();
    expect(disabled.service.getState()).toBe('disabled');
    follow.release();

    const idle = createHarness();
    expect(idle.service.getState()).toBe('idle');
    expect(idle.clients).toHaveLength(0);
  });

  it('backfills the window once and subscribes only to followed callsigns', async () => {
    const harness = createHarness({ history: [historySpot('VK2JEH', 300), historySpot('BG5DRB', 200)] });
    harness.service.follow(['bg5drb', 'BG5DRB']);

    expect(harness.fetchHistory).toHaveBeenCalledTimes(1);
    expect(harness.fetchHistory.mock.calls[0]?.slice(0, 2)).toEqual(['BG5DRB', RECEPTION_WINDOW_MS / 1000]);
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.clientId).toBe('tx5dr-BG5DRB-abcd1234');
    expect(harness.service.getState()).toBe('connecting');

    harness.clients[0]?.handlers.onConnect();
    expect(harness.clients[0]?.subscribe).toHaveBeenCalledWith('pskr/filter/v2/+/+/BG5DRB/#');
    expect(harness.service.getState()).toBe('live');

    await vi.advanceTimersByTimeAsync(RECEPTION_APPEND_FLUSH_MS);
    // The station's own receiver hearing itself is not reception feedback.
    expect(harness.spots.flat().map(spot => spot.receiverCallsign)).toEqual(['VK2JEH']);
  });

  it('deduplicates live and history reports and keeps only the window', async () => {
    const harness = createHarness();
    harness.service.follow(['BG5DRB']);
    harness.clients[0]?.handlers.onConnect();
    const handlers = harness.clients[0]!.handlers;

    handlers.onMessage('topic', liveSpot());
    handlers.onMessage('topic', liveSpot());
    handlers.onMessage('topic', liveSpot({ rc: 'OLD1', t: NOW / 1000 - 3600, t_tx: NOW / 1000 - 3600 }));
    handlers.onMessage('topic', liveSpot({ sc: 'BA1ZZZ', rc: 'OTHER' }));
    await vi.advanceTimersByTimeAsync(RECEPTION_APPEND_FLUSH_MS);

    expect(harness.spots).toHaveLength(1);
    expect(harness.spots[0]?.map(spot => spot.receiverCallsign)).toEqual(['OH2JJA']);
    expect(harness.service.getSpots(['BG5DRB'])).toHaveLength(1);

    vi.setSystemTime(NOW + RECEPTION_WINDOW_MS);
    expect(harness.service.getSpots(['BG5DRB'])).toEqual([]);
  });

  it('shares one connection across follows and closes it after the last page leaves', async () => {
    const harness = createHarness();
    const first = harness.service.follow(['BG5DRB']);
    const second = harness.service.follow(['BG5DRB', 'BA1ZZZ']);
    harness.clients[0]?.handlers.onConnect();
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.subscribe.mock.calls.map(([topic]) => topic).sort()).toEqual([
      'pskr/filter/v2/+/+/BA1ZZZ/#',
      'pskr/filter/v2/+/+/BG5DRB/#',
    ]);

    second.release();
    expect(harness.clients[0]?.unsubscribe).toHaveBeenCalledWith('pskr/filter/v2/+/+/BA1ZZZ/#');
    first.release();
    expect(harness.service.getState()).toBe('idle');
    expect(harness.clients[0]?.close).not.toHaveBeenCalled();

    // A reload inside the idle grace period reuses the connection.
    const reload = harness.service.follow(['BG5DRB']);
    await vi.advanceTimersByTimeAsync(RECEPTION_IDLE_DISCONNECT_MS);
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0]?.close).not.toHaveBeenCalled();

    reload.release();
    await vi.advanceTimersByTimeAsync(RECEPTION_IDLE_DISCONNECT_MS);
    expect(harness.clients[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('limits the history query to once per five minutes per callsign', async () => {
    const harness = createHarness();
    harness.service.follow(['BG5DRB']).release();
    harness.service.follow(['BG5DRB']);
    expect(harness.fetchHistory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(RECEPTION_HISTORY_MIN_INTERVAL_MS);
    const second = harness.service.follow(['BG5DRB']);
    // Still followed by the earlier page; the interest did not start again.
    expect(harness.fetchHistory).toHaveBeenCalledTimes(1);

    harness.service.follow([]).release();
    second.release();
    harness.service.follow(['BG5DRB']);
    expect(harness.fetchHistory).toHaveBeenCalledTimes(1);
  });

  it('backfills again when a callsign is followed anew after the interval', async () => {
    const harness = createHarness();
    harness.service.follow(['BG5DRB']).release();
    await vi.advanceTimersByTimeAsync(RECEPTION_HISTORY_MIN_INTERVAL_MS);
    harness.service.follow(['BG5DRB']);
    expect(harness.fetchHistory).toHaveBeenCalledTimes(2);
  });

  it('reconnects with backoff and backfills the gap when allowed', async () => {
    const harness = createHarness();
    harness.service.follow(['BG5DRB']);
    harness.clients[0]?.handlers.onConnect();

    harness.clients[0]?.handlers.onClose(new Error('socket closed'));
    expect(harness.service.getState()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(RECEPTION_RECONNECT_BASE_MS - 1);
    expect(harness.clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.clients).toHaveLength(2);
    // Within five minutes of the first query, the gap is not queried again.
    expect(harness.fetchHistory).toHaveBeenCalledTimes(1);

    harness.clients[1]?.handlers.onClose();
    await vi.advanceTimersByTimeAsync(RECEPTION_RECONNECT_BASE_MS * 2);
    expect(harness.clients).toHaveLength(3);

    // The gap is backfilled once the query interval allows it.
    await vi.advanceTimersByTimeAsync(RECEPTION_HISTORY_MIN_INTERVAL_MS);
    expect(harness.fetchHistory).toHaveBeenCalledTimes(2);
  });

  it('drops the connection and stored spots when disabled', async () => {
    const harness = createHarness();
    harness.service.follow(['BG5DRB']);
    harness.clients[0]?.handlers.onConnect();
    harness.clients[0]?.handlers.onMessage('topic', liveSpot());
    await vi.advanceTimersByTimeAsync(RECEPTION_APPEND_FLUSH_MS);

    harness.setEnabled(false);
    harness.service.onConfigChanged();
    expect(harness.clients[0]?.close).toHaveBeenCalledTimes(1);
    expect(harness.service.getSpots(['BG5DRB'])).toEqual([]);
    expect(harness.states.at(-1)).toBe('disabled');
  });
});
