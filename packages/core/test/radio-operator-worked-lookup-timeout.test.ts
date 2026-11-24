import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import EventEmitter from 'eventemitter3';
import { MODES, type DigitalRadioEngineEvents } from '@tx5dr/contracts';
import { RadioOperator } from '../src/operator/RadioOperator';

// Owner decision (DEC/DCN unverified item 1): the core worked-station lookup is
// answered by the logbook over the engine event bus. When the logbook does not
// answer within 1 s, the lookup deliberately resolves to "not worked": an
// occasional duplicate QSO is preferred over silently skipping a new station
// because the logbook is slow.

type LookupRequest = { operatorId: string; callsign: string; requestId: string };

function createOperator() {
  const eventEmitter = new EventEmitter<DigitalRadioEngineEvents>();
  const operator = new RadioOperator({
    id: 'operator-1',
    mode: MODES.FT8,
    myCallsign: 'BG4IAJ',
    myGrid: 'OM96',
    frequency: 1500,
    transmitCycles: [0],
    maxQSOTimeoutCycles: 6,
    maxCallAttempts: 5,
    autoReplyToCQ: false,
    autoResumeCQAfterFail: false,
    autoResumeCQAfterSuccess: false,
    replyToWorkedStations: false,
    prioritizeNewCalls: true,
    targetSelectionPriorityMode: 'dxcc_first',
  }, eventEmitter);
  const requests: LookupRequest[] = [];
  (eventEmitter as unknown as EventEmitter).on('checkHasWorkedCallsign', (data: LookupRequest) => {
    requests.push(data);
  });
  const respond = (requestId: string, hasWorked: boolean) => {
    (eventEmitter as unknown as EventEmitter).emit('hasWorkedCallsignResponse', { requestId, hasWorked });
  };
  const pendingResponseListeners = () =>
    (eventEmitter as unknown as EventEmitter).listenerCount('hasWorkedCallsignResponse');
  return { operator, requests, respond, pendingResponseListeners };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
});

test('worked-station lookup returns the logbook answer when it arrives within 1 s', async () => {
  const { operator, requests, respond, pendingResponseListeners } = createOperator();

  const lookup = operator.hasWorkedCallsign('JA1AAA');
  assert.strictEqual(requests.length, 1);
  assert.deepStrictEqual(
    { operatorId: requests[0]!.operatorId, callsign: requests[0]!.callsign },
    { operatorId: 'operator-1', callsign: 'JA1AAA' },
  );

  mock.timers.tick(999);
  respond(requests[0]!.requestId, true);

  assert.strictEqual(await lookup, true);
  assert.strictEqual(pendingResponseListeners(), 0);
});

test('intentionally treats an unanswered worked-station lookup as not worked after 1 s (prefer a duplicate QSO over missing a new station)', async () => {
  const { operator, requests, respond, pendingResponseListeners } = createOperator();
  let settled: boolean | undefined;

  const lookup = operator.hasWorkedCallsign('JA1AAA').then((value) => {
    settled = value;
    return value;
  });

  mock.timers.tick(999);
  await Promise.resolve();
  assert.strictEqual(settled, undefined, 'lookup must wait for the logbook up to 1 s');

  mock.timers.tick(1);
  assert.strictEqual(await lookup, false);
  assert.strictEqual(pendingResponseListeners(), 0, 'timed-out lookup must stop listening');

  // A slow logbook that finally says "worked" does not revise the decision.
  respond(requests[0]!.requestId, true);
  assert.strictEqual(settled, false);
});
