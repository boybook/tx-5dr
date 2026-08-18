import { EventEmitter } from 'events';
import { UserRole } from '@tx5dr/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRtcDataAudioConnectivityHints,
  getRtcDataAudioLocalUdpPort,
  RtcDataAudioManager,
  resolveRtcDataAudioPortRange,
} from '../RtcDataAudioManager.js';

const { rtcTestState } = vi.hoisted(() => ({
  rtcTestState: {
    peers: [] as unknown[],
    dataChannels: [] as unknown[],
  },
}));

vi.mock('node-datachannel', () => {
  class FakeDataChannel {
    private open = true;
    private onOpenCallback: (() => void) | null = null;
    private onClosedCallback: (() => void) | null = null;

    constructor() {
      rtcTestState.dataChannels.push(this);
    }

    onOpen(callback: () => void): void { this.onOpenCallback = callback; }
    onMessage(): void {}
    onClosed(callback: () => void): void { this.onClosedCallback = callback; }
    onError(): void {}
    isOpen(): boolean { return this.open; }
    sendMessage(): boolean { return true; }
    sendMessageBinary(): boolean { return true; }
    bufferedAmount(): number { return 0; }
    triggerOpen(): void { this.onOpenCallback?.(); }
    close(): void {
      if (!this.open) return;
      this.open = false;
      this.onClosedCallback?.();
    }
  }

  class FakePeerConnection {
    readonly close = vi.fn();

    constructor() {
      rtcTestState.peers.push(this);
    }

    onLocalDescription(): void {}
    onLocalCandidate(): void {}
    onStateChange(): void {}
    createDataChannel(): FakeDataChannel { return new FakeDataChannel(); }
    setRemoteDescription(): void {}
    addRemoteCandidate(): void {}
  }

  const fakeModule = {
    preload: vi.fn(),
    PeerConnection: FakePeerConnection,
  };
  return { ...fakeModule, default: fakeModule };
});

const ORIGINAL_ENV = {
  RTC_DATA_AUDIO_UDP_PORT: process.env.RTC_DATA_AUDIO_UDP_PORT,
  RTC_DATA_AUDIO_ICE_UDP_MUX: process.env.RTC_DATA_AUDIO_ICE_UDP_MUX,
};
const RETIRED_PORT_START_ENV = 'RTC_DATA_AUDIO_UDP_PORT_' + 'START';
const RETIRED_PORT_END_ENV = 'RTC_DATA_AUDIO_UDP_PORT_' + 'END';
const RETIRED_PORT_RANGE_ENV = 'RTC_DATA_AUDIO_UDP_PORT_' + 'RANGE';
const ORIGINAL_RETIRED_ENV = {
  [RETIRED_PORT_START_ENV]: process.env[RETIRED_PORT_START_ENV],
  [RETIRED_PORT_END_ENV]: process.env[RETIRED_PORT_END_ENV],
  [RETIRED_PORT_RANGE_ENV]: process.env[RETIRED_PORT_RANGE_ENV],
};

function resetRtcEnv(): void {
  for (const key of Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_RETIRED_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('RtcDataAudioManager', () => {
  beforeEach(() => {
    rtcTestState.peers.length = 0;
    rtcTestState.dataChannels.length = 0;
  });

  afterEach(() => {
    resetRtcEnv();
  });

  it('uses a single fixed UDP port by default', () => {
    delete process.env.RTC_DATA_AUDIO_UDP_PORT;
    delete process.env.RTC_DATA_AUDIO_ICE_UDP_MUX;

    expect(resolveRtcDataAudioPortRange()).toEqual({
      portRangeBegin: 50110,
      portRangeEnd: 50110,
      enableIceUdpMux: true,
    });
    expect(getRtcDataAudioLocalUdpPort()).toBe(50110);
  });

  it('accepts one explicit UDP port and ignores retired range envs', () => {
    process.env.RTC_DATA_AUDIO_UDP_PORT = '50222';
    process.env.RTC_DATA_AUDIO_ICE_UDP_MUX = '0';
    process.env[RETIRED_PORT_START_ENV] = String(50_000);
    process.env[RETIRED_PORT_END_ENV] = String(50_100);
    process.env[RETIRED_PORT_RANGE_ENV] = `${50_000}-${50_100}`;

    expect(resolveRtcDataAudioPortRange()).toEqual({
      portRangeBegin: 50222,
      portRangeEnd: 50222,
      enableIceUdpMux: false,
    });
    expect(getRtcDataAudioLocalUdpPort()).toBe(50222);
  });

  it('falls back to the default fixed UDP port for invalid values', () => {
    process.env.RTC_DATA_AUDIO_UDP_PORT = '70000';

    expect(resolveRtcDataAudioPortRange()).toEqual({
      portRangeBegin: 50110,
      portRangeEnd: 50110,
      enableIceUdpMux: true,
    });
  });

  it('does not advertise an internal reverse-proxy port in signaling hints', () => {
    const hints = buildRtcDataAudioConnectivityHints({
      headers: {
        host: '5dr2.992218.xyz',
        origin: 'https://5dr2.992218.xyz',
        referer: 'https://5dr2.992218.xyz/',
        'x-forwarded-host': '5dr2.992218.xyz',
        'x-forwarded-port': '8076',
        'x-forwarded-proto': 'http',
      },
      requestProtocol: 'http',
    });

    expect(hints.signalingUrl).toBe('wss://5dr2.992218.xyz/api/realtime/rtc-data-audio');
  });

  it('closes an active receive peer when its source becomes unavailable', async () => {
    const source = Object.assign(new EventEmitter(), {
      id: 'native-radio:radio',
      sourcePath: 'native-radio' as const,
      isAvailable: () => true,
      getLatestStats: () => null,
    });
    const manager = new RtcDataAudioManager(
      {} as never,
      { resolveSource: () => source } as never,
    );
    const offer = await manager.buildOffer({
      scope: 'radio',
      direction: 'recv',
      role: UserRole.VIEWER,
    });
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    });

    manager.acceptConnection(socket as never, `/api/realtime/rtc-data-audio?token=${offer?.token}`);
    await vi.waitFor(() => expect(rtcTestState.dataChannels).toHaveLength(1));

    const dataChannel = rtcTestState.dataChannels[0] as {
      triggerOpen: () => void;
      isOpen: () => boolean;
    };
    const peer = rtcTestState.peers[0] as { close: ReturnType<typeof vi.fn> };
    dataChannel.triggerOpen();
    source.emit('unavailable', 'if-input-monitor-disabled');

    expect(socket.close).toHaveBeenCalledWith(4004, 'Realtime audio source is not available');
    expect(dataChannel.isOpen()).toBe(false);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(source.listenerCount('audioFrame')).toBe(0);
    expect(source.listenerCount('unavailable')).toBe(0);
  });
});
