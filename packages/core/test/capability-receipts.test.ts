import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WSMessageType } from '@tx5dr/contracts';
import { WSMessageHandler } from '../src/websocket/WSMessageHandler.js';

test('capability receipts stay on the raw request channel and do not replay into live state', () => {
  const handler = new WSMessageHandler();
  const raw: unknown[] = []; const states: unknown[] = [];
  handler.onRawMessage(message => raw.push(message));
  handler.onWSEvent('radioCapabilityChanged', state => states.push(state));
  const state = { id: 'rf_power', supported: true, value: 0.8, updatedAt: 10 };
  const broadcast = { type: WSMessageType.RADIO_CAPABILITY_CHANGED, timestamp: new Date().toISOString(), data: state };
  handler.handleRawMessage(JSON.stringify(broadcast));
  handler.handleRawMessage(JSON.stringify({ ...broadcast, id: 'old-request', data: { ...state, value: 0.3, updatedAt: 5 } }));
  assert.equal(raw.length, 2);
  assert.deepEqual(states, [state]);
});
