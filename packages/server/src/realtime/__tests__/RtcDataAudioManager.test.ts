import { afterEach, describe, expect, it } from 'vitest';
import {
  getRtcDataAudioLocalUdpPort,
  resolveRtcDataAudioPortRange,
} from '../RtcDataAudioManager.js';

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

describe('RtcDataAudioManager port configuration', () => {
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
});
