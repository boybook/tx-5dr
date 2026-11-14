import type { RttyConfig, RttyReceivedCharacter, RttyTxStatus } from '@tx5dr/contracts';

/** Shared builders for RTTY frontend tests. */
export function txStatus(overrides: Partial<RttyTxStatus> = {}): RttyTxStatus {
  return {
    phase: 'idle',
    active: false,
    sessionId: null,
    startedBy: null,
    startedByLabel: null,
    sentText: '',
    committedText: '',
    pendingText: '',
    finishing: false,
    typeAheadSupported: true,
    messageId: null,
    startedAt: null,
    lastText: null,
    error: null,
    repeat: null,
    available: true,
    unavailableReason: null,
    revision: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function rttyConfig(overrides: Partial<RttyConfig> = {}): RttyConfig {
  return {
    baud: 45.45,
    shiftHz: 170,
    stopBits: 1.5,
    sideband: 'lsb',
    centerHz: 2210,
    reverse: false,
    characterSet: 'usTty',
    usos: true,
    afc: true,
    squelch: 0.25,
    noiseBlanker: true,
    autoReverse: true,
    idle: 'diddle',
    maxTransmitSeconds: 600,
    scanner: true,
    scannerChannels: 6,
    ...overrides,
  };
}

/** Received characters for `text`, all with the same confidence. */
export function chars(text: string, confidence = 0.9): RttyReceivedCharacter[] {
  return Array.from(text, (ch, index) => ({ ch, confidence, at: index }));
}
