// Fast orchestration assertions. No engine, native codec or station clock here.
export function assertStationPlugins(snapshot, runtime, { strategy, provider, plugins = [], operatorId }) {
  const selected = [...new Set([strategy, provider, ...plugins])].map(name => {
    const plugin = snapshot.plugins.find(entry => entry.name === name);
    // A scenario-only strategy provider need not own the station's strategy instance.
    const needsInstance = name === strategy || plugins.includes(name) || plugin?.type === 'utility';
    if (!plugin?.loaded || (needsInstance && !plugin.enabled) || plugin.autoDisabled) {
      throw new Error(`Requested plugin is not loaded and enabled: ${name}${plugin?.lastError ? ` (${plugin.lastError})` : ''}`);
    }
    return plugin;
  });
  const target = selected.find(plugin => plugin.name === strategy);
  if (target.type !== 'strategy' || runtime.currentStrategy !== strategy
      || !target.assignedOperatorIds?.includes(operatorId)) {
    throw new Error(`Requested strategy ${strategy} is not assigned to ${operatorId}; actual strategy: ${runtime.currentStrategy}`);
  }
  for (const name of plugins) {
    if (name !== strategy && name !== provider && selected.find(plugin => plugin.name === name).type !== 'utility') {
      throw new Error(`Additional plugin ${name} is a strategy; select it with --strategy`);
    }
  }
  return selected;
}

function qsoIdentities(value) {
  if (!Array.isArray(value) || value.some(row => !row || typeof row.id !== 'string' || !row.id
      || typeof row.callsign !== 'string' || !row.callsign)) {
    throw new Error('QSO query did not return records with id and callsign');
  }
  return value.map(({ id, callsign }) => ({ id, callsign }));
}

export function assertRestoredQsos(before, after) {
  if (before.length !== after.length || before.some(q => !after.some(r => r.id === q.id && r.callsign === q.callsign))) {
    throw new Error('QSO records did not survive restart');
  }
}

/** Read a public ContestWorkbench view through an ordinary authenticated page session. */
export function createWorkbenchQsoReader({ plugin, pageId, operatorId, callsign, api, readPage }) {
  const page = plugin.ui?.pages?.find(entry => entry.id === pageId);
  if (!page) throw new Error(`Plugin ${plugin.name} has no declared page: ${pageId}`);
  const binding = page.resourceBinding === 'callsign' ? { callsign }
    : page.resourceBinding === 'operator' ? { operatorId } : {};
  const query = new URLSearchParams({
    ...(plugin.instanceScope !== 'global' ? { operatorId } : {}), ...binding,
  });
  let sessionId;
  return async () => {
    if (!sessionId) {
      const entry = page.entry.split('/').map(encodeURIComponent).join('/');
      const html = await readPage(`/api/plugins/${encodeURIComponent(plugin.name)}/ui/${entry}?${query}`);
      const match = html.match(/window\.__TX5DR_PAGE_SESSION_ID__\s*=\s*("(?:[^"\\]|\\.)*")\s*;/);
      if (!match || typeof (sessionId = JSON.parse(match[1])) !== 'string' || !sessionId) {
        throw new Error('Plugin page did not establish a page session');
      }
    }
    const { result } = await api(`/api/plugins/${encodeURIComponent(plugin.name)}/ui-invoke`, {
      pageId, pageSessionId: sessionId, action: 'get-state', data: binding,
    });
    if (result?.schemaVersion !== 1 || typeof result.health?.readable !== 'boolean') {
      throw new Error('Selected page does not implement the public ContestWorkbench get-state contract');
    }
    const records = qsoIdentities(result.qsos);
    if (!result.health.readable) {
      if (result.health.state === 'opening') return [];
      throw new Error(`Plugin logbook is not readable: ${result.health.error ?? result.health.state}`);
    }
    return records;
  };
}

export async function readCallsignQsos(api) {
  const books = await api('/api/logbooks');
  if (!Array.isArray(books?.data) || books.data.some(book => typeof book.id !== 'string')) {
    throw new Error('Invalid logbook list response');
  }
  const records = [];
  for (const book of books.data) {
    const response = await api(`/api/logbooks/${encodeURIComponent(book.id)}/qsos`);
    records.push(...qsoIdentities(response.data));
  }
  return records;
}

/** Parse an explicit `MIN-MAX` millisecond range for a station fault option. */
export function parseMsRange(value, name) {
  const match = /^(\d+)-(\d+)$/.exec(String(value ?? ''));
  const range = match ? [Number(match[1]), Number(match[2])] : null;
  if (!range || range[0] > range[1] || range[1] > 10000) throw new Error(`${name} must be MIN-MAX milliseconds (at most 10000)`);
  return range;
}

function exchangeMessages(trace, stationCallsign, peerCallsign) {
  const tail = text => text.split(' ').slice(2).join(' ');
  const kind = text => {
    const value = tail(text);
    if (/^(RR73|RRR)$/.test(value)) return 'RR73';
    if (value === '73') return '73';
    if (/^R[+-]\d\d$/.test(value)) return 'R-report';
    if (/^[+-]\d\d$/.test(value)) return 'report';
    if (/^[A-R]{2}\d\d$/.test(value)) return 'call';
    return value;
  };
  const ours = new Map();
  for (const event of trace) {
    if (event.kind !== 'host-decode') continue;
    for (const message of event.data?.messages ?? []) {
      if (typeof message.text === 'string' && message.text.startsWith(`${peerCallsign} ${stationCallsign} `)) {
        ours.set(`${event.data.slot}|${message.text}`, { slot: event.data.slot, text: message.text, kind: kind(message.text) });
      }
    }
  }
  const peer = trace.filter(event => event.kind === 'reply-encoded' && typeof event.data?.text === 'string'
    && event.data.text.startsWith(`${stationCallsign} ${peerCallsign} `))
    .map(event => ({ slot: event.data.targetSlotStart, text: event.data.text, kind: kind(event.data.text) }));
  const bySlot = (a, b) => a.slot - b.slot;
  return { ours: [...ours.values()].sort(bySlot), peer: peer.sort(bySlot) };
}

/** Latest slot in which either side transmitted part of this exchange. */
export function lastExchangeSlot(trace, { stationCallsign, peerCallsign }) {
  const { ours, peer } = exchangeMessages(trace, stationCallsign, peerCallsign);
  return Math.max(-Infinity, ...ours.map(m => m.slot), ...peer.map(m => m.slot));
}

// The peer message that moves each of our steps on.
const NEXT_PEER_STEP = { call: 'report', report: 'R-report', 'R-report': 'RR73', RR73: '73' };

/**
 * A finished exchange must stay finished, and every frame must follow what the
 * peer last sent. Our 73 is repeated only when the peer repeated RR73 in the
 * slot just before it; after our 73 or the peer's 73 the station sends nothing
 * else to that peer. Repeating a step after the peer already answered it means
 * a frame encoded before the slot decision reached the air uncorrected (a frame
 * replaced mid-slot leaves its replacement in the same slot and is accepted).
 */
export function findFinalExchangeViolations(trace, { stationCallsign, peerCallsign, slotMs }) {
  const { ours, peer } = exchangeMessages(trace, stationCallsign, peerCallsign);
  const violations = [];
  const our73 = ours.filter(m => m.kind === '73');
  for (const repeat of our73.slice(1)) {
    if (!peer.some(m => m.kind === 'RR73' && m.slot === repeat.slot - slotMs)) {
      violations.push(`73 repeated without a repeated RR73 (slot ${repeat.slot})`);
    }
  }
  if (our73.length) {
    for (const m of ours.filter(m => m.slot > our73[0].slot && m.kind !== '73')) {
      violations.push(`sent "${m.text}" after our 73 (slot ${m.slot})`);
    }
  }
  ours.forEach((m, index) => {
    const previous = ours.slice(0, index).reverse().find(other => other.slot < m.slot);
    if (!previous || previous.kind !== m.kind || !NEXT_PEER_STEP[m.kind]) return;
    const answered = peer.some(p => p.kind === NEXT_PEER_STEP[m.kind] && p.slot === m.slot - slotMs && p.slot > previous.slot);
    const replaced = ours.some(other => other.slot === m.slot && other.kind !== m.kind);
    if (answered && !replaced) {
      violations.push(`repeated ${m.kind} although the peer already sent ${NEXT_PEER_STEP[m.kind]} (slot ${m.slot})`);
    }
  });
  const peer73 = peer.find(m => m.kind === '73');
  if (peer73) {
    for (const m of ours.filter(m => m.slot > peer73.slot)) {
      violations.push(`sent "${m.text}" after the peer's 73 (slot ${m.slot})`);
    }
  }
  return violations;
}

/**
 * Interrupted station output that no replacement continued within graceMs. A
 * frame corrected mid-slot (late decode, stale encode) is stopped and its
 * replacement starts at once; output cut off without a successor is a failure.
 */
export function findUnreplacedInterruptions(trace, { now, graceMs = 2000 }) {
  const starts = trace.filter(event => event.kind === 'host-start').map(event => event.at);
  return trace.filter(event => event.kind === 'host-end' && event.data?.phase === 'interrupted'
    && now - event.at > graceMs && !starts.some(at => at >= event.at && at <= event.at + graceMs))
    .map(event => event.at);
}
