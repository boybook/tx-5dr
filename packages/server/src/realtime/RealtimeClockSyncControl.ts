type ClockSyncPayload = string | Buffer | ArrayBuffer | Buffer[];

interface ClockSyncRequestMessage {
  type?: string;
  id?: unknown;
  clientSentAtMs?: unknown;
}

export function handleRealtimeClockSyncControlMessage(
  payload: ClockSyncPayload,
  sendJson: (payload: Record<string, unknown>) => void,
): boolean {
  const serverReceivedAtMs = Date.now();
  const text = decodeMaybeJsonPayload(payload);
  if (!text) {
    return false;
  }

  let message: ClockSyncRequestMessage;
  try {
    message = JSON.parse(text) as ClockSyncRequestMessage;
  } catch {
    return false;
  }

  if (message.type !== 'clock-sync') {
    return false;
  }

  const clientSentAtMs = Number(message.clientSentAtMs);
  if (!Number.isFinite(clientSentAtMs)) {
    return true;
  }

  sendJson({
    type: 'clock-sync',
    id: typeof message.id === 'string' ? message.id : '',
    clientSentAtMs,
    serverReceivedAtMs,
    serverSentAtMs: Date.now(),
  });
  return true;
}

function decodeMaybeJsonPayload(payload: ClockSyncPayload): string | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trimStart();
    return trimmed.startsWith('{') ? payload : null;
  }

  const buffer = normalizeBuffer(payload);
  if (!buffer || buffer.length === 0 || buffer[0] !== 0x7b) {
    return null;
  }

  return buffer.toString('utf-8');
}

function normalizeBuffer(payload: Exclude<ClockSyncPayload, string>): Buffer | null {
  if (Array.isArray(payload)) {
    return Buffer.concat(payload);
  }
  if (Buffer.isBuffer(payload)) {
    return payload;
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }
  return null;
}
