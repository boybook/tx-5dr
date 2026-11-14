import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { assertStationPlugins, assertRestoredQsos, createWorkbenchQsoReader, readCallsignQsos } from './lib/station-test-support.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: {
  hardware: { type: 'string' }, case: { type: 'string' }, artifacts: { type: 'string' },
  provider: { type: 'string' }, strategy: { type: 'string' }, scenario: { type: 'string' }, plugins: { type: 'string' },
  callsign: { type: 'string' }, grid: { type: 'string' }, 'skip-build': { type: 'boolean', default: false },
  plugin: { type: 'string', multiple: true, default: [] }, 'logbook-page': { type: 'string' },
  prepare: { type: 'boolean', default: false }, serve: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  process.stdout.write(`Usage: yarn test:station [--case ft8-caller|ft8-responder|ft4-caller|ft8-silence|rtty-caller|rtty-responder|rtty-noise|rtty-disconnect]
  --strategy NAME --provider NAME --scenario ID --plugins /path/to/built-plugins
  --plugin NAME                 Also load a utility/UI plugin (repeatable)
  --logbook-page PAGE_ID         Verify the strategy's public ContestWorkbench QSO view
  --prepare                     Serve UI; wait for normal operator start, then verify the case
  --serve                       Keep an isolated UI station open; no automatic test verdict
  --artifacts /path/to/new-dir   Retain evidence and session.json (UI modes)
  --hardware /absolute/profile.json --callsign YOURCALL --grid YOURGRID
  --skip-build                  Use already refreshed build output
UI modes use Dummy only, default to ft8-caller, and expire within ten minutes.
Stop a UI session with the authenticated POST /api/station-test/stop or Ctrl-C.
`);
  process.exit(0);
}
const uiMode = values.prepare || values.serve;
if (values.prepare && values.serve) throw new Error('Choose --prepare or --serve');
if (uiMode && values.hardware) throw new Error('UI station sessions currently support Dummy only; use the interactive hardware runner for physical tests');
if (values.hardware && (!process.stdin.isTTY || !values.callsign || !values.grid)) {
  throw new Error('Hardware tests require an interactive terminal, --callsign and --grid. Install a dummy load and manually set minimum power before authorizing transmission.');
}
const cases = {
  'ft8-caller': { mode: 'FT8', scenario: 'standard', cycle: 0 },
  'ft8-responder': { mode: 'FT8', scenario: 'calling', cycle: 1 },
  'ft4-caller': { mode: 'FT4', scenario: 'standard', cycle: 0 },
  'ft8-silence': { mode: 'FT8', scenario: 'silence', cycle: 0, negative: true },
  // Keyboard RTTY: the runner acts as the operator through the normal WebSocket API.
  'rtty-caller': { mode: 'RTTY', scenario: 'rtty-answering', cycle: 0, keyboard: 'caller' },
  'rtty-responder': { mode: 'RTTY', scenario: 'rtty-calling', cycle: 0, keyboard: 'responder' },
  'rtty-noise': { mode: 'RTTY', scenario: 'rtty-answering', cycle: 0, keyboard: 'caller', snrDb: 0 },
  'rtty-disconnect': { mode: 'RTTY', scenario: 'rtty-silence', cycle: 0, keyboard: 'disconnect', negative: true },
};
const selected = values.case ? [values.case] : values.hardware || uiMode ? ['ft8-caller'] : Object.keys(cases);
for (const id of selected) if (!cases[id]) throw new Error(`Unknown station case: ${id}`);
const artifactRoot = path.resolve(values.artifacts ?? await fs.mkdtemp(path.join(os.tmpdir(), 'tx5dr-station-')));
await fs.mkdir(artifactRoot, { recursive: true });
process.stdout.write(`Station test artifacts: ${artifactRoot}\n`);
if (!values['skip-build']) {
  const build = spawn('yarn', ['exec', 'turbo', 'run', 'build', '--filter=@tx5dr/server...', ...(uiMode ? ['--filter=@tx5dr/web...'] : [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const log = await fs.open(path.join(artifactRoot, 'build.log'), 'w');
  build.stdout.on('data', data => void log.write(data)); build.stderr.on('data', data => void log.write(data));
  const [code] = await once(build, 'exit'); await log.close();
  if (code !== 0) throw new Error(`Station prerequisite build failed; see ${artifactRoot}/build.log`);
}
const { MODES, RadioProfileSchema, RadioOperatorStatusResponseSchema, StationTestRunSchema, StationTestStatusSchema, StationTestAgentSessionSchema, PluginSystemSnapshotSchema } = await import('@tx5dr/contracts');
const hardwareProfile = values.hardware ? RadioProfileSchema.parse(JSON.parse(await fs.readFile(path.resolve(values.hardware), 'utf8'))) : null;
const summary = [];
const secrets = new Set();
const sensitiveKey = /password|secret|token|authorization|credential/i;
function redact(value) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.split(secret).join('<redacted>');
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (sensitiveKey.test(key) && typeof entry === 'string' && entry) { secrets.add(entry); return [key, '<redacted>']; }
    return [key, redact(entry)];
  }));
  return value;
}
if (hardwareProfile) redact(hardwareProfile);
async function sanitizeEvidence(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await sanitizeEvidence(file); continue; }
    if (/^\.(admin|device-ui)-token(?:$|\.)/.test(entry.name) || /^(auth|device-ui-auth).*\.json/.test(entry.name)) { await fs.rm(file); continue; }
    if (!/\.(json|jsonl|log)(\.[0-9]+)?$/.test(entry.name)) continue;
    const original = await fs.readFile(file, 'utf8');
    let cleaned;
    try { cleaned = JSON.stringify(redact(JSON.parse(original)), null, 2); }
    catch { cleaned = redact(original); }
    await fs.writeFile(file, cleaned);
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let interruption;
async function until(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interruption) throw interruption;
    const result = await check(); if (result) return result; await pause(250);
  }
  throw new Error(`Station test timeout: ${description}`);
}
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
/**
 * Operates a keyboard RTTY QSO over the normal WebSocket API and returns the
 * logged QSOs. Each exchange waits for the station to return to receive and for
 * the peer's answer in the station's own decoder output.
 */
async function runRttyCase({ entry, dir, callsign, frequency, api, port, jwt, getQsos, send, rx, tx, ptt }) {
  const operatorId = 'station-operator';
  const transmit = async text => {
    send('rttyTxAppend', { text: `${text} {RX}`, operatorId });
    await until(() => tx()?.active, 15000, `RTTY transmission start: ${text}`);
    await until(() => !tx()?.active && !ptt(), 90000, `RTTY transmission end: ${text}`);
    if (tx()?.error) throw new Error(`RTTY transmission failed: ${tx().error}`);
  };
  const hear = (pattern, description) => until(() => pattern.test(rx()), 90000, `RTTY reception: ${description}`);
  const peerDecoded = async text => {
    const trace = (await fs.readFile(path.join(dir, 'peer.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    return trace.some(event => event.kind === 'host-decode' && event.data.messages.some(message => message.text.includes(text)));
  };
  await until(() => tx()?.available, 30000, 'RTTY transmit availability');
  if (entry.keyboard === 'disconnect') {
    const owner = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { origin: `http://127.0.0.1:${port}` });
    let ready = false;
    owner.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'authResult' && message.data?.success) {
        owner.send(JSON.stringify({ type: 'clientHandshake', timestamp: new Date().toISOString(), data: { clientInstanceId: 'station-rtty-owner', enabledOperatorIds: [operatorId], selectedOperatorId: operatorId } }));
      }
      if (message.type === 'serverHandshakeComplete') ready = true;
    });
    await once(owner, 'open');
    owner.send(JSON.stringify({ type: 'authToken', timestamp: new Date().toISOString(), data: { jwt } }));
    await until(() => ready, 10000, 'second client handshake');
    owner.send(JSON.stringify({ type: 'rttyTxAppend', timestamp: new Date().toISOString(), data: { text: 'RYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRYRY', operatorId } }));
    await until(() => ptt() && tx()?.phase === 'on_air', 20000, 'RTTY on air from the second client');
    const closedAt = Date.now();
    owner.close();
    await until(() => !ptt() && !tx()?.active, 5000, 'PTT release after the owner disconnected');
    const releaseMs = Date.now() - closedAt;
    await fs.writeFile(path.join(dir, 'disconnect.json'), JSON.stringify({ releaseMs }, null, 2));
    if (releaseMs > 3000) throw new Error(`PTT released ${releaseMs} ms after disconnect`);
    return [];
  }
  const startedAt = Date.now();
  let finalStationText;
  if (entry.keyboard === 'caller') {
    await transmit(`CQ CQ CQ DE ${callsign} ${callsign} ${callsign} K`);
    await hear(new RegExp(`${callsign} DE JA1AAA`), 'peer answer');
    await transmit(`JA1AAA DE ${callsign} UR 599 599 K`);
    await hear(/R TU UR 599/, 'peer report');
    finalStationText = `JA1AAA TU 73 DE ${callsign} SK`;
    await transmit(finalStationText);
    await hear(/TU 73 DE JA1AAA SK/, 'peer sign-off');
  } else {
    await hear(/CQ .*DE JA1AAA/, 'peer CQ');
    await transmit(`JA1AAA DE ${callsign} ${callsign} K`);
    await hear(new RegExp(`${callsign} DE JA1AAA UR 599`), 'peer report');
    finalStationText = `JA1AAA DE ${callsign} R TU UR 599 599 K`;
    await transmit(finalStationText);
    await hear(/TU 73 DE JA1AAA SK/, 'peer sign-off');
  }
  if (!await peerDecoded(finalStationText)) throw new Error('Peer did not decode the final station message');
  if (ptt()) throw new Error('PTT still active after the QSO');
  await api(`/api/logbooks/${encodeURIComponent(callsign)}/qsos`, {
    callsign: 'JA1AAA', frequency: frequency - 2125, mode: 'RTTY', startTime: startedAt, endTime: Date.now(),
    reportSent: '599', reportReceived: '599', messageHistory: [],
  });
  return until(async () => {
    const records = await getQsos();
    return records.some(record => record.callsign === 'JA1AAA') ? records : false;
  }, 15000, 'RTTY QSO in the logbook');
}

for (const id of selected) {
  const entry = cases[id];
  const dir = path.join(artifactRoot, id);
  await fs.mkdir(dir);
  await fs.mkdir(path.join(dir, 'config'));
  const now = Date.now();
  const isRtty = entry.mode === 'RTTY';
  const frequency = entry.mode === 'FT4' || isRtty ? 14080000 : 14074000;
  const profile = hardwareProfile ?? { id: 'station-dummy', name: 'Station Dummy', radio: { type: 'serial', serial: { path: process.platform === 'win32' ? 'NUL' : '/dev/null', rigModel: 1 }, pttMethod: 'cat', digitalModeRadioMode: 'usb' },
    audio: { inputDeviceName: 'Station PCM device', outputDeviceName: 'Station PCM device', inputSampleRate: 48000, outputSampleRate: 48000, inputBufferSize: 1024, outputBufferSize: 1024 }, audioLockedToRadio: false, createdAt: now, updatedAt: now };
  const callsign = values.callsign ?? 'BG5DRB';
  const provider = values.provider ?? 'standard-qso';
  const strategy = values.strategy ?? 'standard-qso';
  const requestedPlugins = new Set([provider, strategy, ...values.plugin]);
  for (const name of requestedPlugins) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid plugin name');
    if (values.plugins) {
      const source = path.join(path.resolve(values.plugins), name);
      try { await fs.stat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await fs.cp(source, path.join(dir, 'plugins', name), { recursive: true, dereference: true, errorOnExist: true });
    }
  }
  const spec = StationTestRunSchema.parse({ version: 1, hardware: Boolean(hardwareProfile), profileId: profile.id, mode: entry.mode,
    dialFrequencyHz: frequency, scenarioProvider: provider, seed: id, transmitCycle: 1 - entry.cycle,
    peers: [{ id: 'remote-1', callsign: 'JA1AAA', grid: 'PM95', scenarioId: values.scenario ?? entry.scenario,
      audioFrequencyHz: isRtty ? 2210 : 1500, ...(entry.snrDb !== undefined ? { channelSnrDb: entry.snrDb } : {}) }], artifactDir: dir });
  const configs = Object.fromEntries(['autocall-idle-frequency', 'wavelog-sync', 'qrz-sync', 'lotw-sync', 'clublog-sync', 'qso-udp-broadcast',
    'scheduled-cq-autocall', 'scheduled-band-switcher'].map(name => [name, { enabled: false, settings: {} }]));
  configs['standard-qso'] = { enabled: true, settings: { autoReplyToCQ: true, autoResumeCQAfterSuccess: false, autoResumeCQAfterFail: false, replyToWorkedStations: false } };
  configs[provider] ??= { enabled: true, settings: {} };
  configs[strategy] ??= { enabled: true, settings: {} };
  for (const name of values.plugin) configs[name] ??= { enabled: true, settings: {} };
  const config = { profiles: [profile], activeProfileId: profile.id,
    operators: [{ id: 'station-operator', myCallsign: callsign, myGrid: values.grid ?? 'OL32', frequency: 1500, transmitCycles: [entry.cycle], mode: MODES[isRtty ? 'FT8' : entry.mode] }],
    ...(isRtty
      ? { lastDigitalModeName: 'FT8', lastEngineMode: 'rtty', lastRTTYFrequency: { frequency, band: '20m', description: '14.080 MHz 20m RTTY' } }
      : { lastDigitalModeName: entry.mode, lastEngineMode: 'digital', lastSelectedFrequency: { frequency, mode: entry.mode, radioMode: 'USB', band: '20m' } }),
    pskreporter: { enabled: false }, rigctld: { enabled: false }, observability: { enabled: false }, ntp: { autoApplyOffset: false },
    plugins: { configs, operatorStrategies: { 'station-operator': strategy }, operatorSettings: { 'station-operator': { 'standard-qso': configs['standard-qso'].settings } } }, logLevel: 'info' };
  await fs.writeFile(path.join(dir, 'config/config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(spec, null, 2));
  const port = await freePort();
  const webPort = uiMode ? await freePort() : undefined;
  let child, exited, socket, jwt;
  let web, webExited, session, pluginSelection, getQsos, result;
  const interruptController = new AbortController();
  let logsDone = Promise.resolve();
  let eventsDone = Promise.resolve();
  let webLogsDone = Promise.resolve();
  let pttActive = false;
  let rttyText = '';
  let rttyTx = null;
  const shutdownToken = crypto.randomBytes(32).toString('hex');
  secrets.add(shutdownToken);
  const api = async (route, body, publicAccess = false, asText = false) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(jwt && !publicAccess ? { authorization: `Bearer ${jwt}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
    return asText ? response.text() : response.json();
  };
  const checkPlugins = async restart => {
    const snapshot = PluginSystemSnapshotSchema.parse(await api('/api/plugins'));
    await fs.writeFile(path.join(dir, restart ? 'plugins.restart.json' : 'plugins.json'), JSON.stringify(snapshot, null, 2));
    const runtime = await api('/api/plugins/operators/station-operator');
    const selection = assertStationPlugins(snapshot, runtime, { strategy, provider, plugins: values.plugin, operatorId: 'station-operator' });
    if (pluginSelection && selection.some(plugin => !pluginSelection.some(previous => previous.name === plugin.name && previous.version === plugin.version && previous.isBuiltIn === plugin.isBuiltIn))) {
      throw new Error('Requested plugin identity changed during the test');
    }
    if (!pluginSelection) pluginSelection = selection;
    const target = selection.find(plugin => plugin.name === strategy);
    if (values['logbook-page']) {
      getQsos = createWorkbenchQsoReader({ plugin: target, pageId: values['logbook-page'], operatorId: 'station-operator', callsign,
        api, readPage: route => api(route, undefined, false, true) });
    } else {
      if (!values.serve && target.permissions?.includes('logbook:session')) {
        throw new Error('Strategy declares plugin logbook sessions; select --logbook-page PAGE_ID for its public ContestWorkbench view');
      }
      getQsos = () => readCallsignQsos(api);
    }
  };
  const writeSession = async phase => {
    if (!session) return;
    session = StationTestAgentSessionSchema.parse({ ...session, phase,
      tokenFile: ['stopped', 'failed'].includes(phase) ? undefined : path.join(dir, 'config/.admin-token') });
    const temporary = path.join(dir, 'session.json.tmp');
    await fs.writeFile(temporary, JSON.stringify(session, null, 2), { mode: 0o600 });
    await fs.rename(temporary, path.join(dir, 'session.json'));
  };
  const startWeb = async () => {
    const log = await fs.open(path.join(dir, 'web.log'), 'w');
    web = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      cwd: path.join(root, 'packages/web'), env: { ...process.env, TX5DR_BACKEND_TARGET: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    webExited = once(web, 'exit');
    let tail = Promise.resolve();
    const append = data => { tail = tail.then(() => log.write(data)); };
    web.stdout.on('data', append); web.stderr.on('data', append);
    webLogsDone = once(web, 'close').then(async () => { await tail; await log.close(); });
    await until(async () => {
      if (web.exitCode !== null) throw new Error('Web preview exited; see web.log');
      try { return (await fetch(`http://127.0.0.1:${webPort}/`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 15000, 'Web preview startup');
  };
  const start = async restart => {
    const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), TX5DR_SERVER_PORT_AUTO: '0',
      TX5DR_STATION_TEST_SPEC: path.join(dir, 'run.json'), TX5DR_INTERNAL_SHUTDOWN_TOKEN: shutdownToken, TX5DR_TELEMETRY_CONSENT: 'disabled',
      TX5DR_DECODE_WORKERS: '1', LOG_LEVEL: 'info',
      TX5DR_CONFIG_DIR: path.join(dir, 'config'), TX5DR_DATA_DIR: path.join(dir, 'data'), TX5DR_LOGS_DIR: path.join(dir, 'logs'),
      TX5DR_CACHE_DIR: path.join(dir, 'cache'), TX5DR_PLUGINS_DIR: path.join(dir, 'plugins'), TX5DR_PLUGIN_DATA_DIR: path.join(dir, 'plugin-data'),
      TX5DR_SERVER_READY_FILE: path.join(dir, 'ready.json'), RTC_DATA_AUDIO_UDP_PORT: String(await freePort()) };
    if (uiMode) { env.WEB_PORT = String(webPort); env.TX5DR_WEB_DEV_PORT = String(webPort); }
    child = spawn(process.execPath, [path.join(root, 'packages/server/dist/index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    exited = once(child, 'exit');
    const log = await fs.open(path.join(dir, restart ? 'restart.log' : 'server.log'), 'w');
    let logTail = Promise.resolve();
    const append = data => { logTail = logTail.then(() => log.write(data)); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    logsDone = once(child, 'close').then(async () => { await logTail; await log.close(); });
    await until(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited with ${child.exitCode}`);
      try { return (await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
    }, 45000, 'HTTP startup');
    const token = (await fs.readFile(path.join(dir, 'config/.admin-token'), 'utf8')).trim();
    secrets.add(token);
    jwt = (await api('/api/auth/login', { token }, true)).jwt;
    secrets.add(jwt);
    await until(async () => {
      const status = StationTestStatusSchema.parse(await api('/api/station-test/status'));
      if (status.phase === 'failed') throw new Error(status.error);
      return status.phase === 'ready';
    }, 30000, 'radio, audio and peer readiness');
    await checkPlugins(restart);
    if (restart) return;
    const events = await fs.open(path.join(dir, 'events.jsonl'), 'w');
    socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { origin: `http://127.0.0.1:${port}` });
    let authenticated = false, handshaken = false;
    let eventTail = Promise.resolve();
    socket.on('error', error => { interruption ??= error; });
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'authResult' && message.data?.success) {
        authenticated = true;
        socket.send(JSON.stringify({ type: 'clientHandshake', timestamp: new Date().toISOString(), data: { clientInstanceId: `station-${id}`, enabledOperatorIds: ['station-operator'], selectedOperatorId: 'station-operator' } }));
      }
      if (message.type === 'serverHandshakeComplete') handshaken = true;
      if (message.type === 'pttStatusChanged') pttActive = message.data.isTransmitting;
      if (message.type === 'rttyDecoderEvent' && message.data?.kind === 'characters') {
        rttyText += message.data.characters.map(character => character.ch).join('');
      }
      if (message.type === 'rttyTxStatus') rttyTx = message.data;
      eventTail = eventTail.then(() => events.write(`${JSON.stringify(redact(message))}\n`));
    });
    eventsDone = new Promise(resolve => socket.once('close', resolve)).then(async () => { await eventTail; await events.close(); });
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'authToken', timestamp: new Date().toISOString(), data: { jwt } }));
    await until(() => authenticated && handshaken, 10000, 'normal WebSocket handshake');
    await fs.writeFile(path.join(dir, 'capabilities.json'), JSON.stringify(await api('/api/radio/capabilities'), null, 2));
  };
  const stop = async () => {
    socket?.close(); socket = undefined;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { await logsDone; await eventsDone; return; }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/system/internal/prepare-shutdown`, { method: 'POST', headers: { 'x-tx5dr-internal-token': shutdownToken }, signal: AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(`Server shutdown preparation failed: ${response.status}`);
    } finally {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 45000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; throw new Error('Server required forced termination'); }
      await logsDone; await eventsDone;
    }
  };
  const stopWeb = async () => {
    if (!web) return;
    if (web.exitCode === null && web.signalCode === null) {
      web.kill('SIGTERM');
      let timer;
      await Promise.race([webExited, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); clearTimeout(timer);
      if (web.exitCode === null && web.signalCode === null) { web.kill('SIGKILL'); await webExited; throw new Error('Web preview required forced termination'); }
    }
    await webLogsDone;
  };
  const interrupt = signal => {
    interruption = new Error(`Station run interrupted: ${signal}`);
    interruptController.abort(interruption);
    child?.stdin?.end();
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
  try {
    process.stdout.write(`Running ${id}\n`);
    await start(false);
    if (uiMode) {
      await startWeb();
      session = { version: 1, phase: values.serve ? 'serving' : 'preparing', sessionId: (await api('/api/station-test/status')).sessionId,
        serverUrl: `http://127.0.0.1:${port}`, webUrl: `http://127.0.0.1:${webPort}`, operatorId: 'station-operator', artifactDir: dir,
        expiresAt: now + spec.maxDurationMs, plugins: pluginSelection.map(({ name, version, type }) => ({ name, version, type })) };
      await writeSession(session.phase);
      process.stdout.write(`Station UI: ${session.webUrl}\nAgent session: ${path.join(dir, 'session.json')}\n${values.serve ? 'Manual session; stop through /api/station-test/stop. No automatic pass is claimed.' : 'Prepare plugins through the UI, then start station-operator normally to begin verification.'}\n`);
      await until(async () => {
        const status = StationTestStatusSchema.parse(await api('/api/station-test/status'));
        if (status.phase === 'failed') throw new Error(status.error);
        if (web.exitCode !== null || web.signalCode !== null || child.exitCode !== null || child.signalCode !== null) throw new Error('Station UI process exited');
        if (values.serve) return status.phase === 'stopped';
        if (status.phase === 'stopped') throw new Error('Station stopped before case verification');
        // isActive describes the engine. isTransmitting is the operator's TX intent;
        // physical PTT remains independently observed through normal WS events.
        return RadioOperatorStatusResponseSchema.parse(await api('/api/operators/station-operator/status')).data.isTransmitting;
      }, spec.maxDurationMs, values.serve ? 'manual station session stop' : 'operator start after plugin preparation');
    }
    if (values.serve) {
      result = { id, result: 'unverified', hardware: false, reason: 'Manual UI session; automatic QSO assertions were not run' };
    } else {
      if (hardwareProfile) {
        const status = await api('/api/station-test/status');
        // Show what the radio itself reports, so the operator can compare it with the display.
        const readback = (await api('/api/radio/capabilities')).capabilities ?? [];
        const capability = id => readback.find(item => item.id === id);
        const radioMode = capability('radio_mode')?.supported ? capability('radio_mode').value : 'unreadable';
        const powerValue = capability('rf_power')?.supported ? capability('rf_power').value : null;
        // rf_power is normalised 0..1, not watts.
        const rfPower = typeof powerValue === 'number' ? `${Math.round(powerValue * 100)}%` : 'unreadable';
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const answer = await terminal.question(`Target ${profile.name}; ${frequency} Hz ${entry.mode}; radio reports mode ${radioMode}, RF power ${rfPower}; maximum ${spec.maxDurationMs / 1000}s counted from server start. Confirm dummy load installed and minimum power set manually. Type ARM: `, { signal: interruptController.signal });
          if (answer !== 'ARM') throw new Error('Hardware test was not armed');
        } finally { terminal.close(); }
        const permission = await api('/api/station-test/arm', { sessionId: status.sessionId, dummyLoadInstalled: true, minimumPowerSetManually: true });
        await fs.writeFile(path.join(dir, 'hardware-permission.json'), JSON.stringify({ ...permission, dummyLoadInstalled: true, minimumPowerSetManually: true, frequency, mode: entry.mode }, null, 2));
      }
      await checkPlugins(false);
      await writeSession('verifying');
      if (!values.prepare && !isRtty) await api('/api/operators/station-operator/start', {});
      let qsos = [];
      if (isRtty) {
        qsos = await runRttyCase({ entry, dir, callsign, frequency, api, port, jwt, getQsos,
          send: (type, data) => socket.send(JSON.stringify({ type, timestamp: new Date().toISOString(), data })),
          rx: () => rttyText.replace(/\s+/g, ' ').toUpperCase(), tx: () => rttyTx, ptt: () => pttActive });
      } else if (entry.negative) {
        const end = Date.now() + MODES[entry.mode].slotMs * 3;
        while (Date.now() < end) {
          if (interruption) throw interruption;
          const status = await api('/api/station-test/status'); if (status.phase === 'failed') throw new Error(status.error);
          if (status.phase === 'stopped') throw new Error('Station stopped during case verification');
          if ((await getQsos()).length) throw new Error('Silent peer produced a false QSO'); await pause(500);
        }
      } else {
        qsos = await until(async () => {
          const status = await api('/api/station-test/status'); if (status.phase === 'failed') throw new Error(status.error);
          if (status.phase === 'stopped') throw new Error('Station stopped during case verification');
          const records = await getQsos();
          const trace = (await fs.readFile(path.join(dir, 'peer.jsonl'), 'utf8')).split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
          if (trace.some(event => event.kind === 'host-end' && event.data.phase === 'interrupted')) throw new Error('Observed station output was interrupted');
          const finalDecoded = trace.some(event => event.kind === 'host-decode' && event.data.messages.some(m =>
            m.text === `JA1AAA ${callsign} RR73` || m.text === `JA1AAA ${callsign} 73`));
          if (!records.some(q => q.callsign === 'JA1AAA') || !finalDecoded || pttActive) return false;
          await checkPlugins(false);
          return records;
        }, MODES[entry.mode].slotMs * 12, 'audio QSO completion and durable logbook');
      }
      await checkPlugins(false);
      if (!isRtty) await api('/api/operators/station-operator/stop', {});
      await api('/api/station-test/stop', {});
      const status = await api('/api/station-test/status');
      if (status.phase !== 'stopped') throw new Error(`Station test did not stop: ${status.error}`);
      await stop();
      await start(true);
      const restored = await until(async () => {
        const records = await getQsos();
        return records.length >= qsos.length ? records : false;
      }, 30000, 'logbook recovery after restart');
      assertRestoredQsos(qsos, restored);
      const trace = await fs.readFile(path.join(dir, 'peer.jsonl'), 'utf8');
      if (!entry.negative && !trace.includes('host-decode')) throw new Error('No observed transmission was decoded by the peer');
      result = { id, result: 'passed', qsos: restored.length, hardware: Boolean(hardwareProfile), evidence: hardwareProfile ? 'actual-output' : 'virtual-device-consumed',
        plugins: pluginSelection.map(({ name, version }) => ({ name, version })), logbookPage: values['logbook-page'] };
    }
  } catch (error) {
    result = { id, result: 'failed', error: error.message }; process.exitCode = 1;
    process.stderr.write(`Failed ${id}: ${error.message}\n`);
  } finally {
    const cleanup = await Promise.allSettled([stopWeb(), stop()]);
    for (const outcome of cleanup) if (outcome.status === 'rejected') {
      process.exitCode = 1; result = { id, result: 'failed', error: outcome.reason.message };
      process.stderr.write(`${outcome.reason.message}\n`);
    }
    process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
    await writeSession(result.result === 'failed' ? 'failed' : 'stopped');
    await sanitizeEvidence(dir);
    summary.push(result);
    await fs.writeFile(path.join(artifactRoot, 'summary.json'), JSON.stringify(summary, null, 2));
    if (result.result === 'passed') process.stdout.write(`Passed ${id}: ${result.qsos} QSO(s) persisted\n`);
  }
  if (process.exitCode) break;
}
