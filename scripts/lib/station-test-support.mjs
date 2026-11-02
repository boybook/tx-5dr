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
