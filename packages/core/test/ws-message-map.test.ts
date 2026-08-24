import test from 'node:test';
import assert from 'node:assert/strict';
import { WSMessageType } from '@tx5dr/contracts';
import { WSMessageHandler, WS_MESSAGE_EVENT_MAP } from '../src/websocket/WSMessageHandler.js';

test('routes squelch status messages to frontend event handlers', () => {
  assert.equal(
    WS_MESSAGE_EVENT_MAP[WSMessageType.SQUELCH_STATUS_CHANGED],
    'squelchStatusChanged',
  );
});

test('routes spectrum subscription acknowledgements to frontend event handlers', () => {
  assert.equal(
    WS_MESSAGE_EVENT_MAP[WSMessageType.SPECTRUM_SUBSCRIPTION_CHANGED],
    'spectrumSubscriptionChanged',
  );
});

test('routes all image radio messages to frontend event handlers', () => {
  assert.deepEqual(
    [
      WSMessageType.IMAGE_RADIO_STATUS,
      WSMessageType.IMAGE_RX_EVENT,
      WSMessageType.SSTV_TX_STATUS,
      WSMessageType.SSTV_TX_COMMAND_RESULT,
    ].map((type) => WS_MESSAGE_EVENT_MAP[type]),
    [
      'imageRadioStatus',
      'imageRxEvent',
      'sstvTxStatus',
      'sstvTxCommandResult',
    ],
  );
});

test('dispatches image row payloads received from the websocket', () => {
  const handler = new WSMessageHandler();
  let received: unknown;
  handler.onWSEvent('imageRxEvent', (event) => {
    received = event;
  });
  const event = {
    type: 'rows' as const,
    sessionId: 'fax-page-1',
    generation: 2,
    revision: 12,
    pixelFormat: 'gray8' as const,
    rows: [{ rowIndex: 11, rowRevision: 0, completeness: 'final' as const, dataBase64: 'AP+A' }],
  };

  handler.handleRawMessage(JSON.stringify({
    type: WSMessageType.IMAGE_RX_EVENT,
    timestamp: new Date().toISOString(),
    data: event,
  }));

  assert.deepEqual(received, event);
});
