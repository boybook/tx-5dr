import { describe, expect, it } from 'vitest';
import { resolveFrameLocationDisplay, type FrameDisplayMessage } from '../FramesTable';

function createMessage(overrides: Partial<FrameDisplayMessage>): FrameDisplayMessage {
  return {
    utc: '12:00:00',
    db: -10,
    dt: 0.1,
    freq: 1000,
    message: '<...> BG5DRB RR73',
    ...overrides,
  };
}

describe('frame location display', () => {
  it('uses a reliable display-only callsign without logbook analysis', () => {
    const location = resolveFrameLocationDisplay(createMessage({
      locationCallsign: 'BG5DRB',
      countryZh: '中国·浙江',
      countryEn: 'China·Zhejiang',
      countryCode: 'CN',
    }), true, false);

    expect(location).toEqual({
      callsign: 'BG5DRB',
      displayName: '中国·浙江',
      text: '中国·浙江',
    });
  });

  it('does not display location fields without a reliable sender callsign', () => {
    const location = resolveFrameLocationDisplay(createMessage({
      countryZh: '中国·浙江',
      countryCode: 'CN',
    }), true, false);

    expect(location).toBeNull();
  });

  it('keeps narrow and translated labels deterministic', () => {
    const message = createMessage({
      locationCallsign: 'BG5DRB',
      countryZh: '中国·浙江',
      countryEn: 'China·Zhejiang',
    });

    expect(resolveFrameLocationDisplay(message, true, true)?.text).toBe('浙江');
    expect(resolveFrameLocationDisplay(message, false, false)?.text).toBe('China·Zhejiang');
  });
});
