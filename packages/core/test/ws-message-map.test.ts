import test from 'node:test';
import assert from 'node:assert/strict';
import { WSMessageType } from '@tx5dr/contracts';
import { WS_MESSAGE_EVENT_MAP } from '../src/websocket/WSMessageHandler.js';

test('routes squelch status messages to frontend event handlers', () => {
  assert.equal(
    WS_MESSAGE_EVENT_MAP[WSMessageType.SQUELCH_STATUS_CHANGED],
    'squelchStatusChanged',
  );
});
